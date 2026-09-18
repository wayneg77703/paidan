// opencode run --format json NDJSON parser ("opencode-run"). Parser only.
// Verified against the retired external-agent-suite opencode adapter + contracts
// (archived 2026-09-12; analyzeNdjson) and live
// opencode 1.18.29 runs (2026-09-10):
//  - stdout is NDJSON: step_start / tool_use / step_finish / text / reasoning /
//    error; every event carries a top-level sessionID (ses_...). text events
//    carry part.text; blank parts are skipped and parts join with "\n".
//  - usage: exactly one step_finish with valid tokens -> provider; zero or
//    MULTIPLE step_finish (normal on tool runs; cumulative vs incremental
//    semantics unproven, contract usage_contract) -> null + warning. Never
//    fabricate, never degrade the parse over accounting.
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

interface StepTokens { input: number; output: number; cache: { read: number } }

function validTokens(t: unknown): t is StepTokens {
    if (!t || typeof t !== 'object' || Array.isArray(t)) return false
    const o = t as Record<string, unknown>
    const cache = o.cache
    return Number.isSafeInteger(o.input) && (o.input as number) >= 0
        && Number.isSafeInteger(o.output) && (o.output as number) >= 0
        && !!cache && typeof cache === 'object' && !Array.isArray(cache)
        && Number.isSafeInteger((cache as Record<string, unknown>).read)
        && ((cache as Record<string, unknown>).read as number) >= 0
}

export function createOpencodeRunParser(): OpencodeRunParser {
    const finalParts: string[] = []
    const sessions = new Set<string>()
    let stepFinish = 0
    let stepTokens: unknown = null
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
        } else if (type === 'step_finish') {
            stepFinish++
            if (stepFinish === 1) stepTokens = (o.part as Record<string, unknown> | undefined)?.tokens
        } else if (type === 'error') {
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
        // step_start / tool_use / reasoning: progress rows, recorded by the
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
            if (stepFinish === 1) {
                if (validTokens(stepTokens)) {
                    usage = {
                        input_tokens: stepTokens.input,
                        output_tokens: stepTokens.output,
                        cached_input_tokens: stepTokens.cache.read,
                        cost: null,
                        source: 'provider',
                    }
                } else {
                    warnings.push('single step_finish tokens missing or invalid; usage unavailable')
                }
            } else if (stepFinish === 0) {
                warnings.push('no step_finish event; usage unavailable')
            } else {
                // cumulative vs incremental semantics unproven (endpoint contract)
                warnings.push(`multiple step_finish events (${stepFinish}); usage unavailable`)
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
