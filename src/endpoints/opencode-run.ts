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

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { UsageSummary } from '../engine/types.js'
import type { DiscoverModelsResult, EndpointParseResult, EndpointStreamParser, ModelEntry } from './parser-api.js'
import { EndpointRegistry } from './registry.js'
import { finalSpawnArgs, needsVerbatimArgs, planEndpointSpawn } from './spawn.js'

const execFileAsync = promisify(execFile)

export interface OpencodeParseResult extends EndpointParseResult {
/** null = no provable usage (never fabricate zeros) */
    /** in-band type:error events double as refusal evidence (still warnings too) */
}

export interface OpencodeRunParser extends EndpointStreamParser {

    finish(tailStdout: string, tailStderr: string): OpencodeParseResult
}

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

/** Pure parse seam for `opencode models` output: `provider/model` per line. */
export function parseModelsOutput(text: string): { models: ModelEntry[]; notes: string[] } {
    const models: ModelEntry[] = []
    let skipped = 0
    for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim()
        if (!trimmed) continue
        const m = /^([a-z0-9][a-z0-9.-]*)\/(\S+)$/i.exec(trimmed)
        if (!m || !m[1] || !m[2]) {
            skipped++
            continue
        }
        models.push({ alias: `${m[1]}/${m[2]}`, connection: m[1] })
    }
    const notes = [
        'live `opencode models` enumeration; connection = provider prefix (opencode = free Zen group, opencode-go = Go subscription, others = native BYOK)',
    ]
    if (skipped > 0) notes.push(`${skipped} non-model line(s) skipped`)
    if (models.length === 0) notes.push('`opencode models` returned no parseable provider/model lines')
    return { models, notes }
}

// ---- Convention exports (parser-api.ts): the registry loads these by name ----

export function createParser(): OpencodeRunParser {
    return createOpencodeRunParser()
}

export const detectRefusals = detectOpencodeRefusals

/**
 * Live model discovery: spawn `opencode models` through the same layered
 * resolution as runs (registry manifest -> planEndpointSpawn, config override
 * first — codex P1-11). Never reads the native auth.json (invariant 3).
 * Failure throws: the caller keeps the last good cache instead of
 * overwriting it with an empty list.
 */
export async function discoverModels(opts?: { configBin?: string | null }): Promise<DiscoverModelsResult> {
    const manifest = (await EndpointRegistry.load()).get('opencode')
    const spawnRes = await planEndpointSpawn(manifest, { configBin: opts?.configBin ?? null })
    if (!spawnRes.plan) {
        throw new Error(`opencode binary not resolvable for \`opencode models\`: ${spawnRes.notes.join('; ')}`)
    }
    const r = await execFileAsync(spawnRes.plan.command, finalSpawnArgs(spawnRes.plan, ['models']), {
        timeout: 60_000,
        windowsHide: true,
        windowsVerbatimArguments: needsVerbatimArgs(spawnRes.plan),
    })
    return parseModelsOutput(r.stdout)
}
