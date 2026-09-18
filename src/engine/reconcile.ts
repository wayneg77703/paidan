// Startup reconcile: scan non-terminal runs; if the worker pid is dead, mark
// attention with an evidence note. Never auto-restart anything.

import { verifyProcessIdentity, type ProcessStartQuery } from './process-identity.js'
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
    opts: { now?: string; limit?: number; queryStart?: ProcessStartQuery } = {},
): Promise<ReconcileReport> {
    const now = opts.now ?? new Date().toISOString()
    const report: ReconcileReport = { scanned: 0, changed: [], errors: [] }
    const runs = await store.list({ skipCleanup: true })
    for (const run of runs) {
        if (isTerminal(run.state)) continue
        if (opts.limit !== undefined && report.scanned >= opts.limit) break
        report.scanned++
        try {
            const next = await reconcileOne(store, run, now, opts.queryStart)
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
    if (result && isTerminal(result.state)) {
        const next = transitionRecord(run, result.state, now)
        await store.writeState(next)
        await store.appendEvent(run.run_id, {
            ts: now,
            type: 'reconcile',
            note: `worker gone (${goneReason}); adopted terminal state ${result.state} from result.json`,
        })
        return next
    }

    const next = transitionRecord(run, 'attention', now)
    await store.writeState(next)
    await store.appendEvent(run.run_id, {
        ts: now,
        type: 'reconcile',
        note: `${goneReason} and no result.json exists; marked attention (never auto-restarted)`,
    })
    return next
}
