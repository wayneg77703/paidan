// opencode run --format json NDJSON parser ("opencode-run"). Parser only.
// Verified against the retired external-agent-suite opencode adapter + contracts
// (archived 2026-09-12; analyzeNdjson) and live
// opencode 1.18.29 runs (2026-09-10):
//  - stdout is NDJSON: step_start / tool_use / step_finish / text / reasoning /
//    error; every event carries a top-level sessionID (ses_...). text events
//    carry part.text; blank parts are skipped and parts join with "\n".
//  - 1.19.0 processor.ts creates one step-finish part per provider step.
//    Aggregate unique part ids, not message totals; conflicting/missing
//    identity or invalid counters make multi-step usage unavailable.
//    run.ts emits root-session parts only, not subagent billing totals.
//  - type:error events are in-band soft errors: warning + refusal evidence;
//    the message sits in error.data.message on 1.18.29 (part.message on the
//    legacy fixture shape) — both are read.
//  - non-JSON lines, mid-line EOF and multiple distinct sessionIDs (drift)
//    degrade the parser. UNKNOWN event types are known-benign drift per the
//    endpoint contract ("preserve and ignore"): warning only, never degraded.
// detectRefusals is an honest no-op: 1.18.29 carries no stderr refusal
// signature (plan-agent denial surfaces in the final text at exit 0).

import type { UsageSummary } from '../engine/types.js'
import type { EndpointParseResult, EndpointStreamParser } from './parser-api.js'
export { discoverModels, readNativeDefaults, validateSelection } from './opencode-models.js'

export type OpencodeParseResult = EndpointParseResult

export type OpencodeRunParser = EndpointStreamParser

/** Observed on opencode 1.18.29 stdout (suite adapter KNOWN_EVENT_TYPES + live runs). */
const KNOWN_EVENT_TYPES = new Set(['step_start', 'tool_use', 'step_finish', 'text', 'reasoning', 'error'])

interface StepTokens { input: number; output: number; reasoning?: number; cache: { read: number } }

function validTokens(t: unknown): t is StepTokens {
    if (!t || typeof t !== 'object' || Array.isArray(t)) return false
    const o = t as Record<string, unknown>
    const cache = o.cache
    return Number.isSafeInteger(o.input) && (o.input as number) >= 0
        && Number.isSafeInteger(o.output) && (o.output as number) >= 0
        && (o.reasoning === undefined || (Number.isSafeInteger(o.reasoning) && (o.reasoning as number) >= 0))
        && !!cache && typeof cache === 'object' && !Array.isArray(cache)
        && Number.isSafeInteger((cache as Record<string, unknown>).read)
        && ((cache as Record<string, unknown>).read as number) >= 0
}

export function createOpencodeRunParser(): OpencodeRunParser {
    const finalParts: string[] = []
    const sessions = new Set<string>()
    let stepFinish = 0
    const steps = new Map<string, string>()
    const starts = new Map<string, string>()
    const inFlightSteps: Array<{ session: unknown; message: unknown }> = []

    function observeStepStart(o: Record<string, unknown>): void {
        const part = o.part as Record<string, unknown> | undefined
        const session = o.sessionID ?? null
        const message = part?.messageID ?? null
        if (typeof part?.sessionID === 'string' && part.sessionID !== session) usageInvalid = true
        if (typeof part?.id === 'string' && part.id) {
            const key = JSON.stringify([session, part.id])
            const fingerprint = JSON.stringify(message)
            const previous = starts.get(key)
            if (previous !== undefined) {
                if (previous !== fingerprint) usageInvalid = true
                return
            }
            starts.set(key, fingerprint)
        }
        inFlightSteps.push({ session, message })
    }
    let anonymousSteps = 0
    let usageInvalid = false
    let missingReasoning = false
    let providerInterrupted = false
    const totals = { input: 0, output: 0, cache: { read: 0 } }

    function observeUsage(o: Record<string, unknown>): void {
        stepFinish++
        const part = o.part as Record<string, unknown> | undefined
        const tokens = part?.tokens
        if (!validTokens(tokens)) {
            usageInvalid = true
            return
        }
        if (typeof part?.sessionID === 'string' && part.sessionID !== o.sessionID) usageInvalid = true
        const key = typeof part?.id === 'string' && part.id
            ? JSON.stringify([o.sessionID ?? null, part.id]) : null
        const fingerprint = JSON.stringify([part?.messageID ?? null, tokens.input, tokens.output, tokens.reasoning ?? null, tokens.cache.read])
        if (key !== null) {
            const previous = steps.get(key)
            if (previous !== undefined) {
                if (previous !== fingerprint) usageInvalid = true
                return
            }
            steps.set(key, fingerprint)
        } else {
            anonymousSteps++
        }
        // Start/finish are different parts of one message. Pair their session
        // and message identity, never their part ids. Legacy rows can omit
        // messageID; a finish with no observed start remains supported.
        const pending = inFlightSteps.findIndex(start => start.session === (o.sessionID ?? null)
            && (start.message === null || part?.messageID == null || start.message === part.messageID))
        if (pending >= 0) inFlightSteps.splice(pending, 1)
        if (tokens.reasoning === undefined) missingReasoning = true
        totals.input += tokens.input
        // Native output excludes reasoning in 1.19.0 session.getUsage.
        totals.output += tokens.output + (tokens.reasoning ?? 0)
        totals.cache.read += tokens.cache.read
        if (!validTokens(totals)) usageInvalid = true
    }
    let degraded = false
    const warnings: string[] = []
    const refusals: string[] = []

    function parseStdoutLine(line: string): void {
        const trimmed = line.trim()
        if (!trimmed) return
        let obj: unknown
        try {
            obj = JSON.parse(trimmed)
        } catch {
            degraded = true
            warnings.push('non-JSON stdout line; parser degraded')
            return
        }
        if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return
        const o = obj as Record<string, unknown>
        if (typeof o.sessionID === 'string' && o.sessionID) sessions.add(o.sessionID)
        const type = typeof o.type === 'string' ? o.type : ''
        if (!KNOWN_EVENT_TYPES.has(type)) {
            warnings.push(`unknown event type ${JSON.stringify(type || '<missing>')} (known-benign drift; ignored)`)
            return
        }
        if (type === 'text') {
            const part = o.part as Record<string, unknown> | undefined
            if (typeof part?.text === 'string' && part.text.trim()) finalParts.push(part.text.trim())
        } else if (type === 'step_start') {
            observeStepStart(o)
        } else if (type === 'step_finish') {
            observeUsage(o)
        } else if (type === 'error') {
            providerInterrupted = true
            const part = o.part as Record<string, unknown> | undefined
            const err = o.error as Record<string, unknown> | undefined
            const data = err?.data as Record<string, unknown> | undefined
            const message = typeof part?.message === 'string' ? part.message
                : typeof data?.message === 'string' ? data.message
                    : typeof err?.name === 'string' ? err.name : '<no message>'
            const text = `in-band error event: ${message.slice(0, 200)}`
            warnings.push(text)
            refusals.push(text)
        }
        // tool_use / reasoning: progress rows, recorded by the
        // caller's event log, not by the parser
    }

    return {
        acceptStdoutLine: parseStdoutLine,
        acceptStderrLine: () => {}, // stderr carries no parser state on 1.18.29
        finish(tailStdout: string, _tailStderr: string): OpencodeParseResult {
            if (tailStdout.trim()) {
                degraded = true
                warnings.push('stdout ended mid-line; stream may be incomplete')
            }
            let sessionId: string | null = null
            if (sessions.size === 1) {
                sessionId = [...sessions][0] ?? null
            } else if (sessions.size > 1) {
                degraded = true
                warnings.push(`session drift: ${sessions.size} distinct sessionID values; parser degraded`)
            }
            let usage: UsageSummary | null = null
            if (stepFinish === 0) {
                warnings.push('no step_finish event; usage unavailable')
            } else if (usageInvalid || (anonymousSteps > 0 && stepFinish > 1)) {
                warnings.push('step_finish tokens missing or invalid, conflicting, or without trustworthy multi-step identity; usage unavailable')
            } else if (degraded || providerInterrupted || inFlightSteps.length > 0) {
                warnings.push('incomplete or interrupted root-session stream; usage unavailable rather than a partial total')
            } else {
                usage = { input_tokens: totals.input, output_tokens: totals.output, cached_input_tokens: totals.cache.read, cost: null, source: 'provider' }
                warnings.push('usage covers reported root-session steps only; input excludes cache reads/writes; cache writes, hidden retries and auxiliary/subagent requests are not represented')
                if (missingReasoning) warnings.push('some steps omit reasoning tokens; output covers reported output only for those steps')
            }
            return {
                finalText: finalParts.join('\n'),
                sessionId,
                usage,
                refusals,
                degraded,
                warnings,
            }
        },
    }
}

/** No stderr refusal signature observed on 1.18.29; honest no-op until one is. */
export function detectOpencodeRefusals(_stderrText: string, _exitCode: number | null): string[] {
    return []
}

export const detectRefusals = detectOpencodeRefusals

export const createParser = createOpencodeRunParser
