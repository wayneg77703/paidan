// omp print-mode NDJSON parser ("omp-print"). Parser only.
// Verified against oh-my-pi 18.1.14 live runs (2026-09-10) and the suite
// adapter (operations/governance/harnesses/runtime/adapters/omp.mjs
// analyzeNdjson/classifyOmpStderr + contracts/omp-cli.json):
//  - `-p --mode json` stdout is NDJSON: session {id} (exactly one per run),
//    agent_start, turn_start, message_start/update/end, tool_execution_start/
//    update/end, turn_end {message{content,usage,stopReason}, toolResults[]},
//    agent_end {messages[], isTerminal}, advisor_cost_changed, error.
//  - finalText = last turn_end assistant text, else last agent_end's;
//    assistant text = content blocks with type "text" joined by \n.
//  - usage comes ONLY from a sole turn_end usage {input, output, cacheRead}
//    (source provider); multiple turn_end events are NORMAL with tool use and
//    stay unavailable — per-turn vs cumulative semantics unproven, never
//    aggregate, never fabricate zeros (omp-cli.json usage_contract).
//  - headless approval denials are in-band: toolResults rows with isError and
//    "requires approval but no interactive UI available" (live 2026-09-10).
//  - a native --max-time deadline stop aborts the in-flight assistant message
//    (stopReason=aborted) and tool results carry "Deadline exceeded"; the
//    refusal requires BOTH signals (the raw string alone is user-echo-prone).
// Unknown top-level event types are preserved and ignored with one summary
// warning (suite failure_policy.unknown_valid_events); only non-JSON stdout
// or a mid-line EOF degrades the parser.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { UsageSummary } from '../engine/types.js'
import type { DiscoverModelsResult, EndpointStreamParser, ModelEntry } from './parser-api.js'
import { EndpointRegistry } from './registry.js'
import { finalSpawnArgs, needsVerbatimArgs, planEndpointSpawn } from './spawn.js'

const execFileAsync = promisify(execFile)

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
    const turnUsages: unknown[] = []
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
            const summary = summarizeMessageError(m)
            warnings.push(summary)
            refusals.push(summary)
            if (messageHasAuthError(m)) refusals.push('provider-auth-error')
        }
        if (String(m.stopReason ?? '').toLowerCase() === 'aborted') abortedMessages++
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
        } else if (type === 'error') {
            const summary = `provider error event: ${JSON.stringify(o).slice(0, 200)}`
            warnings.push(summary)
            refusals.push(summary)
        } else if (type === 'turn_end') {
            observeMessage(o.message)
            const text = assistantText(o.message)
            if (text) turnFinals.push(text)
            turnUsages.push((o.message as Message | undefined)?.usage)
            observeToolResults(o.toolResults)
        } else if (type === 'agent_end' && Array.isArray(o.messages)) {
            for (const m of o.messages) {
                observeMessage(m)
                const text = assistantText(m)
                if (text) agentFinals.push(text)
            }
        } else if (!KNOWN_EVENT_TYPES.has(type)) {
            unknownEvents++
        }
        // known progress rows (agent_start/turn_start/message_*/tool_execution_*,
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
            if (turnUsages.length > 1) {
                warnings.push(`multiple turn_end events (${turnUsages.length}); per-turn vs cumulative semantics unproven, usage unavailable`)
            } else if (turnUsages.length === 1) {
                const u = turnUsages[0]
                if (validProviderTokens(u)) {
                    usage = { input_tokens: u.input, output_tokens: u.output, cached_input_tokens: u.cacheRead, cost: null, source: 'provider' }
                } else {
                    warnings.push('turn_end usage missing or invalid; usage unavailable')
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
                resumeHint: sessionId ? `omp -r ${sessionId}` : null,
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

/** Pure parse of `omp models --json` output (machine-readable surface, omp models --help 18.1.14). */
export function parseOmpModelsJson(text: string): DiscoverModelsResult {
    const notes: string[] = []
    let parsed: unknown
    try {
        parsed = JSON.parse(text)
    } catch {
        return { models: [], notes: ['omp models --json returned non-JSON output'] }
    }
    const list = (parsed as { models?: unknown } | null)?.models
    if (!Array.isArray(list)) return { models: [], notes: ['omp models --json: no models array in output'] }
    const models: ModelEntry[] = []
    for (const entry of list) {
        const e = entry as Record<string, unknown>
        if (typeof e?.selector !== 'string' || !e.selector) continue
        models.push({ alias: e.selector, connection: typeof e.provider === 'string' ? e.provider : null })
    }
    if (models.length === 0) notes.push('omp models --json returned an empty catalog (no authenticated provider?)')
    return { models, notes }
}

// ---- Convention exports (parser-api.ts): the registry loads these by name ----

export function createParser(): EndpointStreamParser {
    return createOmpPrintParser()
}

export const detectRefusals = detectOmpRefusals

/**
 * Live model discovery via `omp models --json` (the endpoint's own
 * machine-readable catalog). Resolves the binary through the same layered
 * spawn path as runs (config override first, then PATH) — a bare 'omp' lookup
 * would query a different binary than dispatch uses whenever an override is
 * set (codex P1-11). Failure throws: the caller keeps the last good cache
 * instead of overwriting it with an empty list.
 */
export async function discoverModels(opts?: { configBin?: string | null }): Promise<DiscoverModelsResult> {
    const manifest = (await EndpointRegistry.load()).get('omp')
    const spawnRes = await planEndpointSpawn(manifest, { configBin: opts?.configBin ?? null })
    if (!spawnRes.plan) {
        throw new Error(`omp binary not resolvable for \`omp models\`: ${spawnRes.notes.join('; ')}`)
    }
    const { stdout } = await execFileAsync(spawnRes.plan.command, finalSpawnArgs(spawnRes.plan, ['models', '--json']), {
        timeout: 30_000,
        windowsHide: true,
        windowsVerbatimArguments: needsVerbatimArgs(spawnRes.plan),
    })
    const parsed = parseOmpModelsJson(stdout)
    return { models: parsed.models, notes: [...parsed.notes, 'live `omp models --json`; alias is the provider-scoped selector'] }
}
