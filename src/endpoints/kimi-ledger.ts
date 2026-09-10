// kimi native session-ledger usage observation ("endpoint-ledger" source).
// kimi print stdout carries no usage rows; the native session directory does:
//   <home>/session_index.jsonl          rows {sessionId, sessionDir, workDir}
//   <sessionDir>/agents/<id>/wire.jsonl rows {type:"usage.record", usageScope,
//                                        usage:{inputCacheRead,inputOther,
//                                        inputCacheCreation,output}}
// Field names and pairing rules per kimi-job-runner/src/kimi-session.ts
// (aggregateSessionUsage). Read-only: this module never writes to the native home.
//
// v0 scope: only fresh runs (a session created by this run) are summed —
// a resumed session's wire contains earlier turns and cannot be split without
// a pre-spawn byte cursor (runner did baseline-delta; that is the P2 TODO).

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import type { UsageSummary } from '../engine/types.js'

export interface LedgerReadResult {
    usage: UsageSummary | null
    warnings: string[]
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

async function sumWireFile(
    path: string,
    totals: Record<(typeof WIRE_USAGE_FIELDS)[number], number>,
): Promise<{ records: number; invalid: boolean }> {
    let raw: string
    try {
        raw = await fs.readFile(path, 'utf8')
    } catch {
        return { records: 0, invalid: false }
    }
    let records = 0
    for (const line of raw.split(/\r?\n/)) {
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
 * Sum the session ledger into a UsageSummary (source endpoint-ledger).
 * Returns null usage — never fabricated — when the session dir is missing,
 * no usage.record rows exist, or any row is invalid.
 */
export async function readKimiLedgerUsage(
    sessionHandle: string,
    opts: { resume: boolean; home?: string },
): Promise<LedgerReadResult> {
    if (opts.resume) {
        // a resumed session's wire includes earlier turns; without a pre-spawn
        // cursor the run delta is unknowable
        return { usage: null, warnings: ['ledger usage skipped: resume run (wire contains earlier turns)'] }
    }
    const home = opts.home ?? kimiNativeHome()
    const sessionDir = await findSessionDir(home, sessionHandle)
    if (!sessionDir) {
        return { usage: null, warnings: [`ledger usage unavailable: session ${sessionHandle} not in session_index`] }
    }
    let agentDirs: string[]
    try {
        agentDirs = (await fs.readdir(nodePath.join(sessionDir, 'agents'), { withFileTypes: true }))
            .filter((d) => d.isDirectory())
            .map((d) => d.name)
    } catch {
        return { usage: null, warnings: ['ledger usage unavailable: agents dir not found'] }
    }
    const totals: Record<(typeof WIRE_USAGE_FIELDS)[number], number> = {
        inputCacheRead: 0,
        inputOther: 0,
        inputCacheCreation: 0,
        output: 0,
    }
    let records = 0
    for (const agentId of agentDirs.sort()) {
        const r = await sumWireFile(nodePath.join(sessionDir, 'agents', agentId, 'wire.jsonl'), totals)
        if (r.invalid) {
            return { usage: null, warnings: [`ledger usage unavailable: invalid usage.record in wire of agent ${agentId}`] }
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
