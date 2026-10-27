// omp print-mode NDJSON parser ("omp-print"). Parser only.
// Verified against oh-my-pi 18.1.14 live runs (2026-09-10) and the suite
// adapter (the retired external-agent-suite omp adapter + contracts, archived 2026-09-12;
// analyzeNdjson/classifyOmpStderr):
//  - `-p --mode json` stdout is NDJSON: session {id} (exactly one per run),
//    agent_start, turn_start, message_start/update/end, tool_execution_start/
//    update/end, turn_end {message{content,usage,stopReason}, toolResults[]},
//    agent_end {messages[], isTerminal}, advisor_cost_changed, error.
//  - finalText = last turn_end assistant text, else last agent_end's;
//    assistant text = content blocks with type "text" joined by \n.
//  - 18.9.1 agent-loop.ts emits per-turn assistant usage. Count turn_end only;
//    message_end / agent_end repeat messages and are not extra requests.
//    Response ids, timestamps, or explicit turn boundaries identify duplicates.
//    Totals cover reported root-session turns, not hidden retries/subagents.
//  - headless approval denials are in-band: toolResults rows with isError and
//    "requires approval but no interactive UI available" (live 2026-09-10).
//  - a native --max-time deadline stop aborts the in-flight assistant message
//    (stopReason=aborted) and tool results carry "Deadline exceeded"; the
//    refusal requires BOTH signals (the raw string alone is user-echo-prone).
// Unknown top-level event types are preserved and ignored with one summary
// warning (suite failure_policy.unknown_valid_events); only non-JSON stdout
// or a mid-line EOF degrades the parser.

import type { UsageSummary } from '../engine/types.js'
import type { EndpointStreamParser } from './parser-api.js'
export { discoverModels, readNativeDefaults, validateSelection } from './omp-models.js'

/** Adapter KNOWN_EVENT_TYPES + tool_execution_* (observed live on 18.1.14, 2026-09-10). */
const KNOWN_EVENT_TYPES = new Set([
    'session', 'advisor_cost_changed', 'agent_start', 'turn_start', 'message_start',
    'message_update', 'message_end', 'turn_end', 'agent_end', 'error',
    'tool_execution_start', 'tool_execution_update', 'tool_execution_end',
])

const APPROVAL_UNAVAILABLE_RE = /requires approval but no interactive UI available/i
const DEADLINE_TEXT = 'Deadline exceeded'

type Message = Record<string, unknown>

function assistantText(message: unknown): string {
    const m = message as Message | null
    if (!m || m.role !== 'assistant' || !Array.isArray(m.content)) return ''
    return (m.content as Array<Record<string, unknown>>)
        .filter((b) => b && b.type === 'text' && typeof b.text === 'string' && b.text.trim())
        .map((b) => (b.text as string).trim())
        .join('\n')
        .trim()
}

function messageHasError(m: Message): boolean {
    return String(m.stopReason ?? '').toLowerCase() === 'error'
        || (m.errorStatus !== undefined && m.errorStatus !== null && m.errorStatus !== '')
}

function messageHasAuthError(m: Message): boolean {
    const status = String(m.errorStatus ?? '').toLowerCase()
    const detail = `${m.errorMessage ?? ''} ${m.stopReason ?? ''}`.toLowerCase()
    return status === '401' || status.includes('auth')
        || detail.includes('authentication') || detail.includes('unauthorized') || detail.includes('401')
}

function summarizeMessageError(m: Message): string {
    const detail = String(m.errorMessage ?? m.stopReason ?? '').slice(0, 160)
    return `assistant message error (stopReason=${String(m.stopReason ?? 'null')}, errorStatus=${String(m.errorStatus ?? 'null')}): ${detail}`.slice(0, 240)
}

function validProviderTokens(u: unknown): u is { input: number; output: number; cacheRead: number } {
    if (!u || typeof u !== 'object' || Array.isArray(u)) return false
    const t = u as Record<string, unknown>
    return Number.isSafeInteger(t.input) && (t.input as number) >= 0
        && Number.isSafeInteger(t.output) && (t.output as number) >= 0
        && Number.isSafeInteger(t.cacheRead) && (t.cacheRead as number) >= 0
}

export function createOmpPrintParser(): EndpointStreamParser {
    const sessions = new Set<string>()
    const turnFinals: string[] = []
    const agentFinals: string[] = []
    const turns = new Map<string, string>()
    const boundaryFingerprints = new Map<string, number>()
    let turnBoundary = 0
    let turnInFlight = false
    let turnCount = 0
    let anonymousTurns = 0
    let usageInvalid = false
    let providerInterrupted = false
    const totals = { input: 0, output: 0, cacheRead: 0 }

    function observeUsage(message: unknown): void {
        turnCount++
        const m = message as Message | null
        if (!m || m.role !== 'assistant' || !validProviderTokens(m.usage)) {
            usageInvalid = true
            return
        }
        const u = m.usage
        const scope = [m.provider ?? null, m.model ?? null]
        const stableKey = typeof m.responseId === 'string' && m.responseId
            ? JSON.stringify(['response', ...scope, m.responseId])
            : Number.isSafeInteger(m.timestamp) && (m.timestamp as number) >= 0
                ? JSON.stringify(['timestamp', ...scope, m.timestamp])
                : null
        const key = stableKey ?? (turnBoundary > 0 ? `turn:${turnBoundary}` : null)
        // Same identity with different usage/content is conflicting evidence, not
        // another charge. No identity across multiple events remains unknown.
        const fingerprint = JSON.stringify([u.input, u.output, u.cacheRead, m.content, m.stopReason])
        if (stableKey === null) {
            // A new turn_start is not a request identity. An identical older
            // completion may be replayed after it; do not close or charge the
            // new turn unless the evidence distinguishes it from that replay.
            const signature = JSON.stringify([...scope, fingerprint])
            const previousBoundary = boundaryFingerprints.get(signature)
            if (previousBoundary !== undefined && previousBoundary !== turnBoundary) {
                usageInvalid = true
                return
            }
            boundaryFingerprints.set(signature, turnBoundary)
        }
        if (key !== null) {
            const previous = turns.get(key)
            if (previous !== undefined) {
                if (previous !== fingerprint) usageInvalid = true
                return
            }
            turns.set(key, fingerprint)
        } else {
            anonymousTurns++
        }
        // Only a new completion can close an observed start. A replayed older
        // turn_end must not hide an interrupted later turn.
        turnInFlight = false
        totals.input += u.input
        totals.output += u.output
        totals.cacheRead += u.cacheRead
        if (!validProviderTokens(totals)) usageInvalid = true
    }
    let abortedMessages = 0
    let deadlineSeen = false
    let unknownEvents = 0
    let degraded = false
    const warnings: string[] = []
    const refusals: string[] = []

    function observeMessage(message: unknown): void {
        if (!message || typeof message !== 'object' || Array.isArray(message)) return
        const m = message as Message
        if (messageHasError(m)) {
            providerInterrupted = true
            const summary = summarizeMessageError(m)
            warnings.push(summary)
            refusals.push(summary)
            if (messageHasAuthError(m)) refusals.push('provider-auth-error')
        }
        if (String(m.stopReason ?? '').toLowerCase() === 'aborted') {
            abortedMessages++
            providerInterrupted = true
        }
    }

    function observeToolResults(toolResults: unknown): void {
        if (!Array.isArray(toolResults)) return
        for (const r of toolResults as Array<Record<string, unknown>>) {
            if (!r || r.isError !== true || !Array.isArray(r.content)) continue
            const text = (r.content as Array<Record<string, unknown>>)
                .map((b) => (b && typeof b.text === 'string' ? b.text : ''))
                .join('\n')
            if (APPROVAL_UNAVAILABLE_RE.test(text)) {
                refusals.push(`approval-unavailable-headless:${String(r.toolName ?? 'unknown')}`)
            }
        }
    }

    function parseStdoutLine(line: string): void {
        const trimmed = line.trim()
        if (!trimmed) return
        if (!deadlineSeen && trimmed.includes(DEADLINE_TEXT)) deadlineSeen = true
        let obj: unknown
        try {
            obj = JSON.parse(trimmed)
        } catch {
            degraded = true
            warnings.push('non-JSON stdout line; parser degraded')
            return
        }
        if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
            degraded = true
            warnings.push('non-object stdout row; parser degraded')
            return
        }
        const o = obj as Record<string, unknown>
        const type = typeof o.type === 'string' ? o.type : ''
        if (type === 'session') {
            if (typeof o.id === 'string' && o.id) sessions.add(o.id)
        } else if (type === 'turn_start') {
            if (turnInFlight) usageInvalid = true
            turnInFlight = true
            turnBoundary++
        } else if (type === 'message_end') {
            // Failed attempts may never emit turn_end; do not report a partial sum.
            observeMessage(o.message)
        } else if (type === 'error') {
            providerInterrupted = true
            const summary = `provider error event: ${JSON.stringify(o).slice(0, 200)}`
            warnings.push(summary)
            refusals.push(summary)
        } else if (type === 'turn_end') {
            observeMessage(o.message)
            const text = assistantText(o.message)
            if (text) turnFinals.push(text)
            observeUsage(o.message)
            observeToolResults(o.toolResults)
        } else if (type === 'agent_end' && Array.isArray(o.messages)) {
            for (const m of o.messages) {
                observeMessage(m)
                const text = assistantText(m)
                if (text) agentFinals.push(text)
            }
        } else if (type === 'retry_fallback_applied') {
            const detail = [o.from, o.to, o.role, o.reason].filter((v): v is string => typeof v === 'string' && !!v).map(v => v.slice(0, 120)).join(' | ')
            warnings.push(`native fallback applied${detail ? `: ${detail}` : ''}`.slice(0, 600))
        } else if (type === 'retry_fallback_succeeded') {
            const detail = [o.model, o.role].filter((v): v is string => typeof v === 'string' && !!v).map(v => v.slice(0, 120)).join(' | ')
            warnings.push(`native fallback succeeded${detail ? `: ${detail}` : ''}`.slice(0, 600))
        } else if (!KNOWN_EVENT_TYPES.has(type)) {
            unknownEvents++
        }
        // known progress rows (agent_start/message_*/tool_execution_*,
        // advisor_cost_changed) are the caller's event log, not parser state
    }

    return {
        acceptStdoutLine: parseStdoutLine,
        acceptStderrLine: (line: string) => {
            if (!deadlineSeen && line.includes(DEADLINE_TEXT)) deadlineSeen = true
        },
        finish(tailStdout: string, _tailStderr: string) {
            if (tailStdout.trim()) {
                degraded = true
                warnings.push('stdout ended mid-line; stream may be incomplete')
            }
            if (unknownEvents > 0) {
                warnings.push(`unknown event types observed (${unknownEvents}); preserved and ignored`)
            }
            let sessionId: string | null = null
            if (sessions.size === 1) {
                sessionId = [...sessions][0] ?? null
            } else if (sessions.size > 1) {
                warnings.push(`expected one unique session id, got ${sessions.size}; no trustworthy resume handle`)
            }
            let usage: UsageSummary | null = null
            if (turnCount > 0) {
                if (usageInvalid || (anonymousTurns > 0 && turnCount > 1)) {
                    warnings.push('turn_end usage missing or invalid, conflicting, or without trustworthy multi-turn identity; usage unavailable')
                } else if (degraded || sessions.size > 1 || providerInterrupted || turnInFlight) {
                    warnings.push('incomplete or interrupted root-session stream; usage unavailable rather than a partial total')
                } else {
                    usage = { input_tokens: totals.input, output_tokens: totals.output, cached_input_tokens: totals.cacheRead, cost: null, source: 'provider' }
                    warnings.push('usage covers reported root-session turns only; input excludes cache reads/writes, output includes thinking; cache writes, orchestration, hidden retries and auxiliary/subagent requests are not represented')
                }
            }
            if (abortedMessages > 0) {
                refusals.push(
                    deadlineSeen
                        ? 'native-max-time-exceeded: deadline stopped the session; final text is truncated, not a completed delivery'
                        : `session-aborted: assistant stopReason=aborted without an observed deadline (${abortedMessages})`,
                )
            }
            return {
                finalText: (turnFinals.at(-1) ?? agentFinals.at(-1) ?? '').trim(),
                sessionId,
                usage,
                refusals: [...new Set(refusals)],
                degraded,
                warnings,
            }
        },
    }
}

/** Endpoint refusal signals from the full stderr capture + exit code (adapter classifyOmpStderr). */
export function detectOmpRefusals(stderrText: string, _exitCode: number | null): string[] {
    const signals = new Set<string>()
    if (/Unknown tools? in --tools/i.test(stderrText)) signals.add('unknown-tools-in-toolset')
    if (/CliUsageError:/i.test(stderrText)) signals.add('cli-usage-error')
    return [...signals]
}

export const detectRefusals = detectOmpRefusals

export const createParser = createOmpPrintParser
