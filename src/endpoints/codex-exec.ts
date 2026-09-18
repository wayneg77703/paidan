// codex exec --json event-stream parser ("codex-exec"). Parser only.
// Verified against codex-cli 0.153.3 live runs (2026-09-10) and the suite
// adapter's codex knowledge (the retired external-agent-suite codex adapter, archived 2026-09-12;
// analyzeEvents/extractCodexUsage semantics):
//  - stdout is NDJSON: thread.started {thread_id} (the session handle; last
//    observation wins), turn.started, item.started/item.updated/item.completed,
//    turn.completed {usage}, turn.failed, top-level error.
//  - assistant text arrives as item.completed with item.type "agent_message"
//    and item.text; the LAST one is the final answer (codex's own -o writes
//    exactly that last message; paidan v0 has no run-dir -o templating).
//  - item.type "error" is a soft in-band error (the turn can still complete);
//    recorded as a warning, never a degrade.
//  - usage sums over turn.completed events with safe-integer and
//    cached<=input clamps; any violation collapses usage to null + warning
//    (never fabricate zeros, never degrade the parse over accounting).
//  - codex sandbox refusals exit 0 and surface on stderr
//    ("patch rejected: writing is blocked by read-only sandbox; rejected by
//    user approval settings") plus the final agent_message; detectRefusals
//    therefore does not gate on the exit code (unlike kimi-print).
// Unknown TOP-LEVEL event types set degraded (version drift policy: degrade,
// never crash); unknown item types are ignored — item families drift fast.

import { codexSnapshot, discoverCodexLive } from './codex-models.js'
import type { UsageSummary } from '../engine/types.js'
import type { EndpointParseResult, EndpointStreamParser, NativeDefaults } from './parser-api.js'

export type CodexParseResult = EndpointParseResult

export type CodexExecParser = EndpointStreamParser

/** Observed on codex-cli 0.153.3 stdout (golden fixtures + live runs 2026-09-10). */
const KNOWN_EVENT_TYPES = new Set([
    'thread.started',
    'turn.started',
    'turn.completed',
    'turn.failed',
    'item.started',
    'item.updated',
    'item.completed',
    'error',
])

export function createCodexExecParser(): CodexExecParser {
    let finalText = ''
    let sessionId: string | null = null
    let degraded = false
    const warnings: string[] = []
    let turnsCompleted = 0
    let usageInvalid = false
    let inputTokens = 0
    let cachedTokens = 0
    let outputTokens = 0
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
        if (typeof obj !== 'object' || obj === null) return
        const o = obj as Record<string, unknown>
        const type = typeof o.type === 'string' ? o.type : ''
        if (!KNOWN_EVENT_TYPES.has(type)) {
            degraded = true
            warnings.push(`unknown event type ${JSON.stringify(type || '<missing>')}; parser degraded`)
            return
        }
        if (type === 'thread.started') {
            if (typeof o.thread_id === 'string') sessionId = o.thread_id
        } else if (type === 'item.completed') {
            const item = o.item as Record<string, unknown> | undefined
            if (item && item.type === 'agent_message' && typeof item.text === 'string') {
                finalText = item.text
            } else if (item && item.type === 'error' && typeof item.message === 'string') {
                const text = `in-band error item: ${item.message.slice(0, 200)}`
                warnings.push(text)
                refusals.push(text)
            }
        } else if (type === 'turn.completed') {
            turnsCompleted++
            const u = o.usage as Record<string, unknown> | undefined
            const values = [u?.input_tokens, u?.cached_input_tokens, u?.output_tokens]
            if (!u || values.some((v) => !Number.isSafeInteger(v) || (v as number) < 0)
                || (u.cached_input_tokens as number) > (u.input_tokens as number)) {
                usageInvalid = true
                warnings.push('turn.completed usage missing or invalid; usage unavailable')
                return
            }
            inputTokens += u.input_tokens as number
            cachedTokens += u.cached_input_tokens as number
            outputTokens += u.output_tokens as number
        } else if (type === 'turn.failed') {
            const error = o.error as { message?: unknown } | undefined
            warnings.push('turn.failed event observed' + (typeof error?.message === 'string' ? `: ${error.message.slice(0, 2000)}` : ''))
        } else if (type === 'error') {
            warnings.push('top-level error event observed' + (typeof o.message === 'string' ? `: ${o.message.slice(0, 2000)}` : ''))
        }
        // turn.started / item.started / item.updated: progress rows, recorded
        // by the caller's event log, not by the parser
    }

    return {
        acceptStdoutLine: parseStdoutLine,
        acceptStderrLine: () => {}, // stderr carries no parser state; refusals are detectRefusals' job
        finish(tailStdout: string, _tailStderr: string): CodexParseResult {
            if (tailStdout.trim()) {
                degraded = true
                warnings.push('stdout ended mid-line; stream may be incomplete')
            }
            let usage: UsageSummary | null = null
            if (turnsCompleted > 0 && !usageInvalid) {
                if (![inputTokens, cachedTokens, outputTokens].every(Number.isSafeInteger) || cachedTokens > inputTokens) {
                    warnings.push('turn.completed usage sums out of range; usage unavailable')
                } else {
                    usage = {
                        input_tokens: inputTokens,
                        output_tokens: outputTokens,
                        cached_input_tokens: cachedTokens,
                        cost: null,
                        source: 'provider',
                    }
                }
            }
            return { finalText, sessionId, usage, refusals, degraded, warnings }
        },
    }
}

// Sandbox/approval refusal signatures observed on codex exec stderr (0.153.3,
// live 2026-09-10). No exit-code gating: codex sandbox refusals exit 0.
const SANDBOX_WRITE_RE = /blocked by [\w-]+ sandbox/i
const APPROVAL_REJECT_RE = /rejected by user approval settings/i
const UNTRUSTED_DIR_RE = /not inside a trusted directory/i

/** Endpoint refusal signals from the full stderr capture + exit code. */
export function detectCodexRefusals(stderrText: string, _exitCode: number | null): string[] {
    const signals = new Set<string>()
    if (SANDBOX_WRITE_RE.test(stderrText)) signals.add('sandbox-write-blocked')
    if (APPROVAL_REJECT_RE.test(stderrText)) signals.add('approval-settings-rejected')
    if (UNTRUSTED_DIR_RE.test(stderrText)) signals.add('untrusted-directory')
    return [...signals]
}

// ---- Convention exports (parser-api.ts) ----
export const createParser = createCodexExecParser

export const detectRefusals = detectCodexRefusals

export const discoverModels = discoverCodexLive

export async function readNativeDefaults(opts?: { configBin?: string | null }): Promise<NativeDefaults> {
    return (await codexSnapshot(opts?.configBin)).native
}
