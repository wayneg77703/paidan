// kimi-code print-mode output parser ("kimi-print"). Parser only.
// Verified against the operator-local kimi job runner's battle-tested knowledge (2026-09-10):
//  - stdout is JSONL (`--output-format stream-json`): assistant text rows are
//    {role:"assistant", content:"..."}; the session hint is
//    {role:"meta", type:"session.resume_hint", session_id, command}
//    (kimi-output.ts parseStdoutLine).
//  - stderr carries the whole-line resume hint "To resume this session:
//    kimi -r session_xxx" and the Moonshot provider safety-block terminal line
//    (kimi-output.ts RESUME_LINE_RE / SAFETY_RE).
// Unknown output degrades (degraded=true), it never crashes.

import type { EndpointParseResult, EndpointStreamParser, LedgerReadResult } from './parser-api.js'
export { discoverModels, readNativeDefaults, validateSelection } from './kimi-models.js'
import { captureKimiLedgerCursor, readKimiLedgerUsage, type KimiLedgerCursor } from './kimi-ledger.js'

export type KimiParseResult = EndpointParseResult
export type KimiPrintParser = EndpointStreamParser

/** Whole-line-only match: an in-line "kimi -r x" is content, not identity (GAP-4 lesson). */
const RESUME_LINE_RE = /^(?:To resume this session:\s*)?(?:kimi|node)\s+-(?:r|R|S)\s+([A-Za-z0-9_.-]{8,128})\s*$/

/** Moonshot provider safety-block terminal line; refusal evidence only with non-zero exit. */
const SAFETY_RE = /failed to run prompt:\s*Provider safety policy blocked(?: the response)?\.?\r?$/im

export function createKimiPrintParser(): KimiPrintParser {
    let finalText = ''
    let sessionId: string | null = null
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
        }
        // other rows are ignored by the parser; the worker logs semantic events and
        // stdout chunk metadata, not every raw row
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

// ---- Convention exports (parser-api.ts): adapters.ts loads these by name ----

export const createParser = createKimiPrintParser
export const detectRefusals = detectKimiRefusals

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
