// codex exec --json event-stream parser ("codex-exec"). Parser only.
// Verified against codex-cli 0.153.3 live runs (2026-09-10) and the suite
// adapter's codex knowledge (operations/governance/harnesses/runtime/adapters/
// codex.mjs, analyzeEvents/extractCodexUsage semantics):
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

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import type { UsageSummary } from '../engine/types.js'
import type { DiscoverModelsResult, EndpointStreamParser } from './parser-api.js'

export interface CodexParseResult {
    finalText: string
    sessionId: string | null
    resumeHint: string | null
    /** null = no completed turn carried valid usage; never fabricate zeros */
    usage: UsageSummary | null
    /** in-band error items double as refusal evidence (still warnings too) */
    refusals: string[]
    degraded: boolean
    warnings: string[]
}

export interface CodexExecParser extends EndpointStreamParser {
    finish(tailStdout: string, tailStderr: string): CodexParseResult
}

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
            warnings.push('turn.failed event observed')
        } else if (type === 'error') {
            warnings.push('top-level error event observed')
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
            return { finalText, sessionId, resumeHint: null, usage, refusals, degraded, warnings }
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

/**
 * v0 model discovery: heuristic read of the native $CODEX_HOME/config.toml
 * top-level `model = "..."` key (codex has no CLI model-list surface). Honest
 * and read-only; an absent key means codex uses its built-in default.
 */
export function discoverCodexModels(configToml: string | null, hasAuthJson: boolean): DiscoverModelsResult {
    const notes: string[] = []
    if (configToml === null) {
        notes.push('native codex config.toml not found; install/login codex first')
        return { models: [], notes }
    }
    let model: string | null = null
    for (const line of configToml.split(/\r?\n/)) {
        if (/^\s*\[/.test(line)) break // top-level keys only; sections are provider/MCP config
        const m = /^\s*model\s*=\s*"([^"]+)"/.exec(line)
        if (m && m[1]) {
            model = m[1]
            break
        }
    }
    const connection = hasAuthJson ? 'chatgpt-login' : null
    if (model === null) {
        notes.push('no top-level `model` key in native config.toml; codex uses its built-in default model')
        return { models: [], notes }
    }
    notes.push('default model from native $CODEX_HOME/config.toml; codex has no CLI model-list surface (app-server model/list is experimental)')
    if (connection === null) notes.push('no auth.json found; login state unknown')
    return { models: [{ alias: model, connection }], notes }
}

// ---- Convention exports (parser-api.ts): the registry loads these by name ----

export function createParser(): CodexExecParser {
    return createCodexExecParser()
}

export const detectRefusals = detectCodexRefusals

export async function discoverModels(): Promise<DiscoverModelsResult> {
    const codexHome = process.env.CODEX_HOME ?? nodePath.join(os.homedir(), '.codex')
    let toml: string | null = null
    try {
        toml = await fs.readFile(nodePath.join(codexHome, 'config.toml'), 'utf8')
    } catch {
        toml = null
    }
    const hasAuthJson = await fs.stat(nodePath.join(codexHome, 'auth.json')).then(() => true, () => false)
    return discoverCodexModels(toml, hasAuthJson)
}
