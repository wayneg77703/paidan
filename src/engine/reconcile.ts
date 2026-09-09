// Startup reconcile: scan non-terminal runs; if the worker pid is dead, mark
// attention with an evidence note. Never auto-restart anything.

import type { RunStateRecord } from './types.js'
import { isTerminal, transitionRecord } from './state-machine.js'
import type { RunStore } from './run-store.js'

/**
 * Pid liveness via signal-0. PID reuse is not defended against in v0 (the
 * runner did full CIM identity checks); a reused pid delays attention marking
 * until the unrelated process exits. TODO: process-identity verification.
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
    opts: { now?: string; limit?: number } = {},
): Promise<ReconcileReport> {
    const now = opts.now ?? new Date().toISOString()
    const report: ReconcileReport = { scanned: 0, changed: [], errors: [] }
    const runs = await store.list({ skipCleanup: true })
    for (const run of runs) {
        if (isTerminal(run.state)) continue
        if (opts.limit !== undefined && report.scanned >= opts.limit) break
        report.scanned++
        try {
            const next = await reconcileOne(store, run, now)
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
): Promise<RunStateRecord | null> {
    const worker = run.worker
    if (worker && pidAlive(worker.pid)) return null
    if (!worker && Date.parse(now) - Date.parse(run.created_at) < SPAWN_GRACE_MS) return null

    // Worker is gone. If the worker managed to write result.json before dying,
    // adopt its terminal state instead of inventing one.
    const result = await store.readResult(run.run_id)
    if (result && isTerminal(result.state)) {
        const next = transitionRecord(run, result.state, now)
        await store.writeState(next)
        await store.appendEvent(run.run_id, {
            ts: now,
            type: 'reconcile',
            note: `worker gone; adopted terminal state ${result.state} from result.json`,
        })
        return next
    }

    const next = transitionRecord(run, 'attention', now)
    await store.writeState(next)
    await store.appendEvent(run.run_id, {
        ts: now,
        type: 'reconcile',
        note: worker
            ? `worker pid ${worker.pid} is dead and no result.json exists; marked attention (never auto-restarted)`
            : 'worker never became observable; marked attention (never auto-restarted)',
    })
    return next
}
