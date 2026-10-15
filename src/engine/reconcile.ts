// Startup reconcile: scan non-terminal runs; if the worker pid is dead, mark
// attention with an evidence note. Never auto-restart anything.

import { queryProcessStarts, verifyProcessIdentity, type ProcessStartQuery, type ProcessStartsQuery } from './process-identity.js'
import type { RunStateRecord } from './types.js'
import { isTerminal, transitionRecord } from './state-machine.js'
import type { RunStore } from './run-store.js'

/**
 * Pid liveness via signal-0. Liveness alone does not prove identity (PID reuse):
 * when the worker recorded a start token, reconcile/cancel re-verify via
 * verifyProcessIdentity before acting.
 */
export function pidAlive(pid: number): boolean {
    if (!Number.isSafeInteger(pid) || pid <= 0) return false
    try {
        process.kill(pid, 0)
        return true
    } catch (err) {
        // EPERM means the process exists but we may not signal it
        return (err as NodeJS.ErrnoException).code === 'EPERM'
    }
}

/** Grace window so a run whose worker was spawned moments ago is not misjudged. */
const SPAWN_GRACE_MS = 30_000

export interface ReconcileReport {
    scanned: number
    changed: Array<{ run_id: string; from: string; to: string }>
    errors: Array<{ run_id: string; message: string }>
}

export async function reconcileRuns(
    store: RunStore,
    opts: { now?: string; limit?: number; queryStart?: ProcessStartQuery; queryStarts?: ProcessStartsQuery } = {},
): Promise<ReconcileReport> {
    const now = opts.now ?? new Date().toISOString()
    const report: ReconcileReport = { scanned: 0, changed: [], errors: [] }
    const runs = await store.list({ skipCleanup: true })
    const selected: RunStateRecord[] = []
    for (const run of runs) {
        if (isTerminal(run.state)) continue
        if (opts.limit !== undefined && selected.length >= opts.limit) break
        selected.push(run)
    }
    const pids = [...new Set(selected.flatMap(run =>
        run.worker?.pid_start && pidAlive(run.worker.pid) ? [run.worker.pid] : []))]
    let starts: ReadonlyMap<number, string | null> = new Map()
    if (pids.length > 0) {
        try {
            // Preserve the single-query injection contract; production queries all
            // live recorded workers in one call, never terminal or unselected runs.
            starts = opts.queryStart && !opts.queryStarts
                ? new Map(await Promise.all(pids.map(async pid => {
                    try { return [pid, await opts.queryStart!(pid)] as const }
                    catch { return [pid, null] as const }
                })))
                : await (opts.queryStarts ?? queryProcessStarts)(pids)
        } catch {
            // An unavailable batch must not become false evidence of PID reuse.
        }
    }
    const queryStart: ProcessStartQuery = async pid => starts.get(pid) ?? null
    for (const run of selected) {
        report.scanned++
        try {
            const next = await reconcileOne(store, run, now, queryStart)
            if (next && next.state !== run.state) {
                report.changed.push({ run_id: run.run_id, from: run.state, to: next.state })
            }
        } catch (err) {
            report.errors.push({ run_id: run.run_id, message: err instanceof Error ? err.message : String(err) })
        }
    }
    return report
}

async function reconcileOne(
    store: RunStore,
    run: RunStateRecord,
    now: string,
    queryStart?: ProcessStartQuery,
): Promise<RunStateRecord | null> {
    const worker = run.worker
    // goneReason set = fall through to the terminal-adoption/attention path
    let goneReason: string | null = null
    if (worker) {
        if (!pidAlive(worker.pid)) {
            goneReason = `worker pid ${worker.pid} is dead`
        } else if (worker.pid_start) {
            const verdict = await verifyProcessIdentity(worker.pid, worker.pid_start, queryStart)
            if (verdict === 'mismatch') {
                goneReason = `worker pid ${worker.pid} was reused by another process (start-token mismatch)`
            }
            // match: alive and ours. unknown: identity query unavailable —
            // degrade to pid liveness (the pid-only behavior), never a crash.
        }
        // no recorded start token (old run or failed query): pid liveness only
    } else if (Date.parse(now) - Date.parse(run.created_at) >= SPAWN_GRACE_MS) {
        goneReason = 'worker never became observable'
    }
    if (goneReason === null) return null

    // Worker is gone. If the worker managed to write result.json before dying,
    // adopt its terminal state instead of inventing one.
    const result = await store.readResult(run.run_id)
    // The batch query can outlive the worker. Never write its earlier snapshot
    // over a completion/session update; adoption must preserve the latest fields.
    const latest = await store.readState(run.run_id)
    if (!latest || isTerminal(latest.state)) return null
    if (latest.worker?.pid !== worker?.pid
        || (latest.worker?.pid_start ?? null) !== (worker?.pid_start ?? null)) {
        // The evidence was for a different worker registration. Let the next
        // reconciliation query that identity instead of declaring it gone.
        return null
    }
    if (result && isTerminal(result.state)) {
        const next = transitionRecord(latest, result.state, now)
        await store.writeState(next)
        await store.appendEvent(run.run_id, {
            ts: now,
            type: 'reconcile',
            note: `worker gone (${goneReason}); adopted terminal state ${result.state} from result.json`,
        })
        return next
    }

    if (latest.state === 'attention') return null
    const next = transitionRecord(latest, 'attention', now)
    await store.writeState(next)
    await store.appendEvent(run.run_id, {
        ts: now,
        type: 'reconcile',
        note: `${goneReason} and no result.json exists; marked attention (never auto-restarted)`,
    })
    return next
}
