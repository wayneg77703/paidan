// kimi-code print-mode output parser ("kimi-print"). Parser only.
// Verified against kimi-job-runner's battle-tested knowledge (2026-09-10):
//  - stdout is JSONL (`--output-format stream-json`): assistant text rows are
//    {role:"assistant", content:"..."}; the session hint is
//    {role:"meta", type:"session.resume_hint", session_id, command}
//    (kimi-output.ts parseStdoutLine).
//  - stderr carries the whole-line resume hint "To resume this session:
//    kimi -r session_xxx" and the Moonshot provider safety-block terminal line
//    (kimi-output.ts RESUME_LINE_RE / SAFETY_RE).
// Unknown output degrades (degraded=true), it never crashes.

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import type { UsageSummary } from '../engine/types.js'
import type { DiscoverModelsResult, EndpointStreamParser, LedgerReadResult } from './parser-api.js'
import { captureKimiLedgerCursor, readKimiLedgerUsage, type KimiLedgerCursor } from './kimi-ledger.js'

export interface KimiParseResult {
    finalText: string
    sessionId: string | null
    resumeHint: string | null
    /** print stdout carries no usage rows; the worker reads the native ledger (kimi-ledger.ts) */
    usage: UsageSummary | null
    /** kimi's refusal evidence is stderr-carried (detectKimiRefusals); none in-band */
    refusals: string[]
    degraded: boolean
    warnings: string[]
}

export interface KimiPrintParser extends EndpointStreamParser {
    finish(tailStdout: string, tailStderr: string): KimiParseResult
}

/** Whole-line-only match: an in-line "kimi -r x" is content, not identity (GAP-4 lesson). */
const RESUME_LINE_RE = /^(?:To resume this session:\s*)?(?:kimi|node)\s+-(?:r|R|S)\s+([A-Za-z0-9_.-]{8,128})\s*$/

/** Moonshot provider safety-block terminal line; refusal evidence only with non-zero exit. */
const SAFETY_RE = /failed to run prompt:\s*Provider safety policy blocked(?: the response)?\.?\r?$/im

export function createKimiPrintParser(): KimiPrintParser {
    let finalText = ''
    let sessionId: string | null = null
    let resumeHint: string | null = null
    let stderrSessionId: string | null = null
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
        if (typeof obj !== 'object' || obj === null) return
        const o = obj as Record<string, unknown>
        if (o.role === 'assistant' && typeof o.content === 'string') {
            finalText += o.content
        } else if (o.role === 'meta' && o.type === 'session.resume_hint' && typeof o.session_id === 'string') {
            sessionId = o.session_id
            if (typeof o.command === 'string') resumeHint = o.command
        }
        // every other row is recorded by the caller's event log, not by the parser
    }

    function parseStderrLine(line: string): void {
        const m = RESUME_LINE_RE.exec(line)
        if (m && m[1]) stderrSessionId = m[1]
    }

    return {
        acceptStdoutLine: parseStdoutLine,
        acceptStderrLine: parseStderrLine,
        finish(tailStdout: string, tailStderr: string): KimiParseResult {
            if (tailStdout.trim()) {
                degraded = true
                warnings.push('stdout ended mid-line; stream may be incomplete')
            }
            if (tailStderr.trim()) parseStderrLine(tailStderr)
            if (sessionId && stderrSessionId && sessionId !== stderrSessionId) {
                degraded = true
                warnings.push(`conflicting session hints (stdout ${sessionId}, stderr ${stderrSessionId})`)
            }
            return {
                finalText,
                sessionId: sessionId ?? stderrSessionId,
                resumeHint,
                usage: null,
                refusals: [],
                degraded,
                warnings,
            }
        },
    }
}

/** Endpoint refusal signals from the full stderr capture + exit code. */
export function detectKimiRefusals(stderrText: string, exitCode: number | null): string[] {
    if (typeof exitCode === 'number' && exitCode !== 0 && SAFETY_RE.test(stderrText)) {
        return ['provider-safety-blocked']
    }
    return []
}

export interface KimiModelEntry {
    alias: string
    connection: string | null
}

/**
 * v0 model discovery: heuristic scan of the user's native kimi config.toml for
 * `connection/model` alias strings (e.g. "kimi-for-coding/k3"). Honest and
 * read-only; returns an empty list when no config or no aliases are found.
 */
export function discoverKimiModels(configToml: string | null): { models: KimiModelEntry[]; notes: string[] } {
    const notes: string[] = []
    if (configToml === null) {
        notes.push('native kimi config.toml not found; install/login kimi first')
        return { models: [], notes }
    }
    const seen = new Set<string>()
    const models: KimiModelEntry[] = []
    const aliasRe = /["']([a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9._-]*)["']/gi
    for (const m of configToml.matchAll(aliasRe)) {
        const alias = m[1]
        if (!alias || seen.has(alias)) continue
        const connection = alias.split('/')[0] ?? ''
        // source-type words (oauth/inline) are provider origins, not billable connections
        if (connection === 'oauth' || connection === 'inline') continue
        seen.add(alias)
        models.push({ alias, connection })
    }
    if (models.length === 0) {
        notes.push('no connection/model aliases found in native config.toml (heuristic scan)')
    } else {
        notes.push('aliases from heuristic scan of native config.toml; verify with `kimi provider list`')
    }
    return { models, notes }
}

// ---- Convention exports (parser-api.ts): the registry loads these by name ----

export function createParser(): KimiPrintParser {
    return createKimiPrintParser()
}

export const detectRefusals = detectKimiRefusals

export async function discoverModels(): Promise<DiscoverModelsResult> {
    const kimiHome = process.env.KIMI_CODE_HOME ?? nodePath.join(os.homedir(), '.kimi-code')
    let toml: string | null = null
    try {
        toml = await fs.readFile(nodePath.join(kimiHome, 'config.toml'), 'utf8')
    } catch {
        toml = null
    }
    return discoverKimiModels(toml)
}

/** Post-terminal ledger observation; stream parser never yields usage for kimi. */
export function readLedgerUsage(
    sessionHandle: string,
    opts: { resume: boolean; cursor?: unknown },
): Promise<LedgerReadResult> {
    return readKimiLedgerUsage(sessionHandle, { ...opts, cursor: opts.cursor as KimiLedgerCursor | null | undefined })
}

/** Pre-spawn wire byte cursor so a resume run's usage is only its own delta. */
export function captureLedgerCursor(sessionHandle: string): Promise<KimiLedgerCursor | null> {
    return captureKimiLedgerCursor(sessionHandle)
}
