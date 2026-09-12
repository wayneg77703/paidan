// kimi native session-ledger usage observation ("endpoint-ledger" source).
// kimi print stdout carries no usage rows; the native session directory does:
//   <home>/session_index.jsonl          rows {sessionId, sessionDir, workDir}
//   <sessionDir>/agents/<id>/wire.jsonl rows {type:"usage.record", usageScope,
//                                        usage:{inputCacheRead,inputOther,
//                                        inputCacheCreation,output}}
// Field names and pairing rules per the operator-local kimi job runner (kimi-session.ts semantics, 2026-09)
// (aggregateSessionUsage). Read-only: this module never writes to the native home.
//
// Resume runs are summed from a pre-spawn byte cursor (the worker captures each
// wire's size before spawning the endpoint); bytes after the cursor are this
// run's delta. Without a cursor a resume run stays honestly unavailable.

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import type { UsageSummary } from '../engine/types.js'

export interface LedgerReadResult {
    usage: UsageSummary | null
    warnings: string[]
}

/** Pre-spawn byte offsets per wire file (absolute path -> size). Engine treats it as opaque. */
export interface KimiLedgerCursor {
    wires: Record<string, number>
}

const WIRE_USAGE_FIELDS = ['inputCacheRead', 'inputOther', 'inputCacheCreation', 'output'] as const

export function kimiNativeHome(env: NodeJS.ProcessEnv = process.env): string {
    return env.KIMI_CODE_HOME ?? nodePath.join(os.homedir(), '.kimi-code')
}

/** session_index.jsonl rows may be corrupt individually; the last exact match wins. */
async function findSessionDir(home: string, sessionHandle: string): Promise<string | undefined> {
    let raw: string
    try {
        raw = await fs.readFile(nodePath.join(home, 'session_index.jsonl'), 'utf8')
    } catch {
        return undefined
    }
    let found: string | undefined
    for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue
        try {
            const entry = JSON.parse(line) as { sessionId?: unknown; sessionDir?: unknown }
            if (entry.sessionId === sessionHandle && typeof entry.sessionDir === 'string') {
                found = entry.sessionDir
            }
        } catch {
            // an unrelated corrupt row cannot identify this session; keep scanning
        }
    }
    return found
}

/** Wire files of a session dir: absolute path per agents/<id>/wire.jsonl. */
async function listWireFiles(sessionDir: string): Promise<string[] | null> {
    let agentDirs: string[]
    try {
        agentDirs = (await fs.readdir(nodePath.join(sessionDir, 'agents'), { withFileTypes: true }))
            .filter((d) => d.isDirectory())
            .map((d) => d.name)
    } catch {
        return null
    }
    return agentDirs.sort().map((id) => nodePath.join(sessionDir, 'agents', id, 'wire.jsonl'))
}

/**
 * Pre-spawn cursor for resume runs: current byte size of every existing wire.
 * null = session dir not found (a session this run will create) — the read then
 * falls back to whole-file semantics. Throws are the caller's (worker) cue that
 * the cursor is unavailable.
 */
export async function captureKimiLedgerCursor(
    sessionHandle: string,
    opts: { home?: string } = {},
): Promise<KimiLedgerCursor | null> {
    const home = opts.home ?? kimiNativeHome()
    const sessionDir = await findSessionDir(home, sessionHandle)
    if (!sessionDir) return null
    const wires = await listWireFiles(sessionDir)
    if (!wires) return null
    const cursor: KimiLedgerCursor = { wires: {} }
    for (const wire of wires) {
        try {
            cursor.wires[wire] = (await fs.stat(wire)).size
        } catch {
            // wire absent pre-spawn: no entry, the read sums it whole
        }
    }
    return cursor
}

async function sumWireFile(
    path: string,
    totals: Record<(typeof WIRE_USAGE_FIELDS)[number], number>,
    offset = 0,
): Promise<{ records: number; invalid: boolean }> {
    let buf: Buffer
    try {
        buf = await fs.readFile(path)
    } catch {
        return { records: 0, invalid: false }
    }
    if (offset > 0) {
        if (offset >= buf.length) return { records: 0, invalid: false }
        // an offset not preceded by a newline sits inside a line the previous
        // turns own; skip to the first complete line after it
        let start = offset
        if (buf[offset - 1] !== 0x0a) {
            const nl = buf.indexOf(0x0a, offset)
            if (nl < 0) return { records: 0, invalid: false }
            start = nl + 1
        }
        buf = buf.subarray(start)
    }
    let records = 0
    for (const line of buf.toString('utf8').split(/\r?\n/)) {
        if (!line.trim()) continue
        let row: Record<string, unknown>
        try {
            row = JSON.parse(line) as Record<string, unknown>
        } catch {
            return { records, invalid: true }
        }
        if (row.type !== 'usage.record') continue
        const usage = row.usage
        if (!usage || typeof usage !== 'object') return { records, invalid: true }
        const u = usage as Record<string, unknown>
        for (const field of WIRE_USAGE_FIELDS) {
            const value = u[field]
            if (!Number.isSafeInteger(value) || (value as number) < 0) return { records, invalid: true }
            const next = totals[field] + (value as number)
            if (!Number.isSafeInteger(next)) return { records, invalid: true }
            totals[field] = next
        }
        records++
    }
    return { records, invalid: false }
}

/**
 * Sum the session ledger into a UsageSummary (source endpoint-ledger). Null —
 * never fabricated — when the session dir is missing, no usage.record rows
 * exist, or any row is invalid. Resume runs: with a pre-spawn cursor only bytes
 * after it count; cursor null = session absent pre-spawn (fresh semantics);
 * no cursor at all = honestly unavailable.
 */
export async function readKimiLedgerUsage(
    sessionHandle: string,
    opts: { resume: boolean; cursor?: KimiLedgerCursor | null; home?: string },
): Promise<LedgerReadResult> {
    if (opts.resume && opts.cursor === undefined) {
        return { usage: null, warnings: ['ledger usage unavailable: resume run without a pre-spawn cursor'] }
    }
    const cursor = opts.resume ? (opts.cursor ?? null) : null
    const home = opts.home ?? kimiNativeHome()
    const sessionDir = await findSessionDir(home, sessionHandle)
    if (!sessionDir) {
        return { usage: null, warnings: [`ledger usage unavailable: session ${sessionHandle} not in session_index`] }
    }
    const wires = await listWireFiles(sessionDir)
    if (!wires) {
        return { usage: null, warnings: ['ledger usage unavailable: agents dir not found'] }
    }
    const totals: Record<(typeof WIRE_USAGE_FIELDS)[number], number> = {
        inputCacheRead: 0,
        inputOther: 0,
        inputCacheCreation: 0,
        output: 0,
    }
    let records = 0
    for (const wire of wires) {
        // wires absent from the cursor map appeared during this run: sum whole
        const offset = cursor ? (cursor.wires[wire] ?? 0) : 0
        const r = await sumWireFile(wire, totals, offset)
        if (r.invalid) {
            return { usage: null, warnings: [`ledger usage unavailable: invalid usage.record in wire ${nodePath.basename(nodePath.dirname(wire))}`] }
        }
        records += r.records
    }
    if (records === 0) {
        return { usage: null, warnings: ['ledger usage unavailable: no usage.record rows found'] }
    }
    // inputCacheRead is reused cache, not fresh input work; inputOther +
    // inputCacheCreation are fresh input (same mapping as the claude parser).
    return {
        usage: {
            input_tokens: totals.inputOther + totals.inputCacheCreation,
            output_tokens: totals.output,
            cached_input_tokens: totals.inputCacheRead,
            // the kimi ledger has no cost concept
            cost: null,
            source: 'endpoint-ledger',
        },
        warnings: [],
    }
}
