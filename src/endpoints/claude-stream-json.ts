// claude-code print-mode output parser ("claude-stream-json"). Parser only.
// Verified against live stream samples on v2.1.260 (2026-09-10) and the
// 2026-09-09 native probe artifacts (tmp/agent-probe-20260909/claude*/):
//  - stdout is NDJSON (`-p ... --output-format stream-json --verbose`):
//      {"type":"system","subtype":"init","session_id":<uuid>,...}
//      {"type":"assistant","message":{"content":[{"type":"text","text":...}]},...}
//      {"type":"result","subtype":"success","result":<final text>,
//       "session_id":<uuid>,"usage":{input_tokens,cache_creation_input_tokens,
//       cache_read_input_tokens,output_tokens,...},"total_cost_usd":<n>,
//       "permission_denials":[{tool_name,...}],...}   <- exactly one, terminal
//  - permission denials are IN-BAND (result event permission_denials, exit 0),
//    not stderr lines — detectRefusals therefore has no evidenced signature.
// Unknown output degrades (degraded=true), it never crashes.

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import type { UsageSummary } from '../engine/types.js'
import type { DiscoverModelsResult, EndpointParseResult, EndpointStreamParser, NativeDefaults } from './parser-api.js'

export interface ClaudeParseResult extends EndpointParseResult {
/** null when no result event was seen; never fabricated */
    /** in-band permission denials as refusal evidence (also kept as warnings) */
}

export interface ClaudeStreamJsonParser extends EndpointStreamParser {

    finish(tailStdout: string, tailStderr: string): ClaudeParseResult
}

function isRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function finiteNumber(v: unknown): number | null {
    return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/**
 * Map the provider's usage object onto UsageSummary. Anthropic splits input
 * into uncached (input_tokens) and cache-write (cache_creation_input_tokens);
 * both are fresh input work, so they sum into input_tokens.
 * cache_read_input_tokens maps to cached_input_tokens. Absent fields stay null
 * (never fabricated zeros); a wholly absent usage object yields null.
 */
export function readClaudeUsage(value: unknown): UsageSummary | null {
    if (!isRecord(value)) return null
    const fresh = finiteNumber(value.input_tokens)
    const cacheCreation = finiteNumber(value.cache_creation_input_tokens)
    const cacheRead = finiteNumber(value.cache_read_input_tokens)
    const output = finiteNumber(value.output_tokens)
    if (fresh === null && cacheCreation === null && cacheRead === null && output === null) return null
    return {
        input_tokens: fresh === null && cacheCreation === null ? null : (fresh ?? 0) + (cacheCreation ?? 0),
        output_tokens: output,
        cached_input_tokens: cacheRead,
        // filled by the parser from the result event's total_cost_usd
        cost: null,
        source: 'provider',
    }
}

export function createClaudeStreamJsonParser(): ClaudeStreamJsonParser {
    let assistantText = ''
    let resultText: string | null = null
    let sawResult = false
    let initSessionId: string | null = null
    let resultSessionId: string | null = null
    let usage: UsageSummary | null = null
    let costUsd: number | null = null
    const deniedTools: string[] = []
    let degraded = false
    const warnings: string[] = []

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
        if (!isRecord(obj)) return
        if (obj.type === 'system' && obj.subtype === 'init') {
            if (typeof obj.session_id === 'string') initSessionId = obj.session_id
            return
        }
        if (obj.type === 'assistant') {
            const content = isRecord(obj.message) ? obj.message.content : undefined
            if (Array.isArray(content)) {
                for (const part of content) {
                    if (isRecord(part) && part.type === 'text' && typeof part.text === 'string') {
                        assistantText += part.text
                    }
                }
            }
            return
        }
        if (obj.type === 'result') {
            sawResult = true
            if (typeof obj.result === 'string') resultText = obj.result
            if (typeof obj.session_id === 'string') resultSessionId = obj.session_id
            usage = readClaudeUsage(obj.usage)
            costUsd = finiteNumber(obj.total_cost_usd)
            if (usage) usage.cost = costUsd
            if (Array.isArray(obj.permission_denials)) {
                for (const d of obj.permission_denials) {
                    const tool = isRecord(d) ? d.tool_name : undefined
                    deniedTools.push(typeof tool === 'string' ? tool : 'unknown-tool')
                }
            }
            return
        }
        // every other event type is recorded by the caller's event log, not by the parser
    }

    return {
        acceptStdoutLine: parseStdoutLine,
        acceptStderrLine: () => {},
        finish(tailStdout: string, _tailStderr: string): ClaudeParseResult {
            if (tailStdout.trim()) {
                degraded = true
                warnings.push('stdout ended mid-line; stream may be incomplete')
            }
            const sessionId = initSessionId ?? resultSessionId
            if (initSessionId && resultSessionId && initSessionId !== resultSessionId) {
                degraded = true
                warnings.push(`conflicting session ids (init ${initSessionId}, result ${resultSessionId})`)
            }
            if (!sawResult) {
                warnings.push('no result event; final text fell back to accumulated assistant messages')
            }
            for (const tool of deniedTools) {
                warnings.push(`permission denied by endpoint: ${tool}`)
            }
            return {
                finalText: resultText ?? assistantText,
                sessionId,
                usage,
                refusals: deniedTools.map((tool) => `permission-denied:${tool}`),
                degraded,
                warnings,
            }
        },
    }
}

/**
 * No evidenced stderr refusal signature: claude-code surfaces permission
 * denials in-band on stdout (result event permission_denials, exit 0), which
 * the parser already turns into evidence notes.
 */
export function detectRefusals(_stderrText: string, _exitCode: number | null): string[] {
    return []
}

// ---- Convention exports (parser-api.ts): the registry loads these by name ----
/**
 * Static docs-sourced alias list: claude has NO model-enumeration command
 * (2.1.260: `claude model list` / `claude models` are not subcommands — they
 * fall through to a chat prompt). Aliases come from the official model-config
 * page (checked 2026-09-11) and track the latest model per tier; pin a full
 * name (e.g. claude-opus-5) by hand in config.json if you need a fixed version.
 * Gateway availability varies (this machine's gateway 403s fable, live
 * 2026-09-10); a picked-but-unavailable alias fails honestly at the endpoint.
 */
export async function discoverModels(): Promise<DiscoverModelsResult> {
    return {
        models: [
            { alias: 'sonnet', connection: null },
            { alias: 'opus', connection: null },
            { alias: 'haiku', connection: null },
            { alias: 'fable', connection: null },
        ],
        notes: [
            'static list from the official model-config docs (claude has no enumeration command); aliases resolve to the latest model per tier',
            'opusplan/best strategy aliases and the [1m] context suffix exist but stay out of the picker; set defaults.models.claude-code by hand for those',
        ],
    }
}

/** Read-only native-defaults probe: the `model` key of ~/.claude/settings.json (env.ANTHROPIC_MODEL is noted when present). */
export function readClaudeNativeDefaults(settingsJson: string | null): NativeDefaults {
    if (settingsJson === null) return { model: null, effort: null, notes: ['native claude settings.json not found'] }
    let parsed: unknown
    try {
        parsed = JSON.parse(settingsJson)
    } catch {
        return { model: null, effort: null, notes: ['native claude settings.json is not valid JSON'] }
    }
    const notes: string[] = []
    let model: string | null = null
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const o = parsed as Record<string, unknown>
        if (typeof o.model === 'string' && o.model.length > 0) model = o.model
        const env = o.env
        if (env && typeof env === 'object' && !Array.isArray(env)) {
            const anthropicModel = (env as Record<string, unknown>).ANTHROPIC_MODEL
            if (typeof anthropicModel === 'string' && anthropicModel.length > 0) {
                notes.push(`settings env ANTHROPIC_MODEL=${anthropicModel}`)
            }
        }
    }
    return { model, effort: null, notes }
}

export async function readNativeDefaults(): Promise<NativeDefaults> {
    const claudeHome = process.env.CLAUDE_CONFIG_DIR ?? nodePath.join(os.homedir(), '.claude')
    let raw: string | null = null
    try {
        raw = await fs.readFile(nodePath.join(claudeHome, 'settings.json'), 'utf8')
    } catch {
        raw = null
    }
    return readClaudeNativeDefaults(raw)
}

export function createParser(): ClaudeStreamJsonParser {
    return createClaudeStreamJsonParser()
}
