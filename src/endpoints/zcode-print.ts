// zcode print-mode output parser ("zcode-print"). Parser only.
// Verified against ZCode CLI 0.16.5 live output (2026-09-10) and the suite
// adapter (operations/governance/harnesses/runtime/adapters/zcode.mjs):
//  - with --json, stdout is exactly ONE pretty-printed JSON envelope:
//    {sessionId ("sess_..."), traceId, turnId, response, usage, projection}
//    (required-field list per extractFacts, zcode.mjs:432); usage is camelCase.
//  - projection.status must be "idle" with turnCount a positive safe integer
//    (the suite's authoritative terminal signal; MAX_TURNS = 12).
// Empty stdout (startup/auth failure) is NOT degraded — the exit code governs.
// Unknown output degrades (degraded=true), it never crashes.

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import type { UsageSummary } from '../engine/types.js'
import type { DiscoverModelsResult, EndpointStreamParser } from './parser-api.js'

const REQUIRED_ENVELOPE_FIELDS = ['sessionId', 'traceId', 'turnId', 'usage', 'projection', 'response'] as const
const MAX_TURNS = 12

export interface ZcodeParseResult {
    finalText: string
    sessionId: string | null
    resumeHint: string | null
    /** envelope usage mapped to provider-source tokens; null when absent/invalid */
    usage: UsageSummary | null
    /** no in-band refusal shape observed for zcode 0.16.5; always empty */
    refusals: string[]
    degraded: boolean
    warnings: string[]
}

export interface ZcodePrintParser extends EndpointStreamParser {
    finish(tailStdout: string, tailStderr: string): ZcodeParseResult
}

function nonnegativeInteger(value: unknown): number | null {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}
export function usageFromEnvelope(value: unknown): UsageSummary | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const o = value as Record<string, unknown>
    const input = nonnegativeInteger(o.inputTokens)
    const output = nonnegativeInteger(o.outputTokens)
    if (input === null || output === null) return null
    return {
        input_tokens: input,
        output_tokens: output,
        cached_input_tokens: nonnegativeInteger(o.cacheReadTokens),
        source: 'provider',
    }
}

export function createZcodePrintParser(): ZcodePrintParser {
    const stdoutLines: string[] = []
    let degraded = false
    const warnings: string[] = []

    function parseEnvelope(text: string): {
        finalText: string
        sessionId: string | null
        usage: UsageSummary | null
    } {
        let obj: unknown
        try {
            obj = JSON.parse(text)
        } catch {
            degraded = true
            warnings.push('stdout was not exactly one JSON envelope; parser degraded')
            return { finalText: '', sessionId: null, usage: null }
        }
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
            degraded = true
            warnings.push('stdout envelope was not a JSON object; parser degraded')
            return { finalText: '', sessionId: null, usage: null }
        }
        const o = obj as Record<string, unknown>
        const missing = REQUIRED_ENVELOPE_FIELDS.filter((f) => !Object.hasOwn(o, f))
        if (missing.length > 0) {
            degraded = true
            warnings.push(`required envelope fields missing: ${missing.join(', ')}`)
        }
        const projection = o.projection
        if (!projection || typeof projection !== 'object' || Array.isArray(projection)) {
            degraded = true
            warnings.push('projection was missing or invalid')
        } else {
            const p = projection as Record<string, unknown>
            const turnCount = nonnegativeInteger(p.turnCount)
            if (p.status !== 'idle') {
                degraded = true
                warnings.push(`projection.status is ${JSON.stringify(p.status)}, expected "idle"; run may have ended abnormally`)
            }
            if (turnCount === null || turnCount < 1) {
                degraded = true
                warnings.push('projection.turnCount must be a positive safe integer')
            } else if (turnCount > MAX_TURNS) {
                degraded = true
                warnings.push(`projection.turnCount ${turnCount} exceeded ${MAX_TURNS}`)
            }
        }
        const finalText = typeof o.response === 'string' ? o.response.trim() : ''
        if (typeof o.response !== 'string' || finalText.length === 0) {
            warnings.push('envelope response was empty or not a string')
        }
        const sessionId = typeof o.sessionId === 'string' && o.sessionId.length > 0 ? o.sessionId : null
        return { finalText, sessionId, usage: usageFromEnvelope(o.usage) }
    }

    return {
        acceptStdoutLine(line: string): void {
            stdoutLines.push(line)
        },
        acceptStderrLine(_line: string): void {
            // no stderr-carried signals observed for zcode 0.16.5 headless
        },
        finish(tailStdout: string, _tailStderr: string): ZcodeParseResult {
            const full = (stdoutLines.join('\n') + (tailStdout ? `\n${tailStdout}` : '')).replace(/^\uFEFF/, '').trim()
            if (full.length === 0) {
                // startup/auth failures print nothing to stdout; the exit code decides
                return { finalText: '', sessionId: null, resumeHint: null, usage: null, refusals: [], degraded, warnings }
            }
            const parsed = parseEnvelope(full)
            return {
                finalText: parsed.finalText,
                sessionId: parsed.sessionId,
                resumeHint: parsed.sessionId ? `zcode --resume ${parsed.sessionId}` : null,
                usage: parsed.usage,
                refusals: [],
                degraded,
                warnings,
            }
        },
    }
}

/**
 * No endpoint refusal signal has been observed for zcode 0.16.5 headless yolo
 * (startup errors like "Model config is missing" are exit-code failures, not
 * refusals). Honest no-op until a real refusal shape is evidenced.
 */
export function detectZcodeRefusals(_stderrText: string, _exitCode: number | null): string[] {
    return []
}

/**
 * v0 model discovery: read-only heuristic scan of the desktop's native
 * .zcode/v2/config.json provider registry. Extracts provider/model aliases
 * only; credentials in the same file are never read into output.
 */
export function discoverZcodeModels(configJson: string | null): DiscoverModelsResult {
    const notes: string[] = []
    if (configJson === null) {
        notes.push('native .zcode/v2/config.json not found; install/sign in to ZCode desktop first')
        return { models: [], notes }
    }
    let parsed: unknown
    try {
        parsed = JSON.parse(configJson)
    } catch {
        notes.push('native .zcode/v2/config.json is not valid JSON')
        return { models: [], notes }
    }
    const providers = (parsed as Record<string, unknown>)?.provider
    const models: Array<{ alias: string; connection: string | null }> = []
    if (providers && typeof providers === 'object' && !Array.isArray(providers)) {
        for (const [providerId, entry] of Object.entries(providers as Record<string, unknown>)) {
            const e = entry as Record<string, unknown>
            if (e?.enabled === false) continue
            const modelsObj = e?.models
            if (!modelsObj || typeof modelsObj !== 'object' || Array.isArray(modelsObj)) continue
            for (const [modelId, modelCfg] of Object.entries(modelsObj as Record<string, unknown>)) {
                if ((modelCfg as Record<string, unknown>)?.enabled === false) continue
                models.push({ alias: `${providerId}/${modelId}`, connection: providerId })
            }
        }
    }
    if (models.length === 0) {
        notes.push('no enabled provider/model entries found in native v2 config (heuristic scan)')
    } else {
        notes.push('aliases from heuristic scan of native .zcode/v2/config.json; selection = caller env ZCODE_MODEL or CLI model.main; no cross-connection fallback')
    }
    return { models, notes }
}

// ---- Convention exports (parser-api.ts): the registry loads these by name ----

export function createParser(): ZcodePrintParser {
    return createZcodePrintParser()
}

export const detectRefusals = detectZcodeRefusals

export async function discoverModels(): Promise<DiscoverModelsResult> {
    const nativeRoot = process.env.USERPROFILE ?? os.homedir()
    let json: string | null = null
    try {
        json = await fs.readFile(nodePath.join(nativeRoot, '.zcode', 'v2', 'config.json'), 'utf8')
    } catch {
        json = null
    }
    return discoverZcodeModels(json)
}
