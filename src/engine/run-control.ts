// Shared run lifecycle used by delegation and contract probes; no CLI or endpoint knowledge.
import type { RunStore } from './run-store.js'
import { isTerminal, transitionRecord } from './state-machine.js'
import { pidAlive } from './reconcile.js'
import { verifyProcessIdentity } from './process-identity.js'
import { launchWorker, terminateEndpointTree } from './supervisor.js'
import type { RunResult, RunStateRecord } from './types.js'

export async function waitForTerminal(
    store: RunStore,
    runId: string,
    timeoutSec: number,
): Promise<RunStateRecord | null> {
    const deadline = timeoutSec > 0 ? Date.now() + timeoutSec * 1000 : Number.POSITIVE_INFINITY
    let lastLivenessProbe = 0
    for (;;) {
        const state = await store.readState(runId)
        if (!state) return null
        if (isTerminal(state.state)) return state
        // attention = the worker is gone and reconcile already flagged it; no
        // code path will restart it — waiting here would hang forever, so hand
        // the state back to the caller with terminal:false (codex P1-05)
        if (state.state === 'attention') return state
        // waiting-loop liveness: a worker that died mid-wait without reconcile
        // (reconcile only runs at CLI startup) would leave the run "running"
        // forever; probe the recorded pid periodically and surface the same
        // needs-attention signal instead of looping blind
        if (Date.now() - lastLivenessProbe > 5_000) {
            lastLivenessProbe = Date.now()
            const workerPid = state.worker?.pid
            if (workerPid !== undefined && workerPid !== null && !pidAlive(workerPid)) {
                return { ...state, state: 'attention' as const }
            }
        }
        if (Date.now() >= deadline) return state
        await new Promise((r) => setTimeout(r, 1_000))
    }
}

export function resultOrNull(store: RunStore, runId: string): Promise<RunResult | null> {
    return store.readResult(runId).catch(() => null)
}

/** Launch the detached worker for a run, with the store-backed pid liveness probe (shared by run and probe). */
export function launchWorkerFor(ctx: { store: RunStore; dataDir: string }, runId: string): Promise<number> {
    return launchWorker(runId, {
        dataDir: ctx.dataDir,
        readWorkerPid: async () => {
            const s = await ctx.store.readState(runId)
            return s ? { workerPid: s.worker?.pid ?? null, terminal: isTerminal(s.state) } : null
        },
    })
}

/**
 * Direct endpoint kill gated on PID-reuse identity (contracts §5): a start-token
 * mismatch is someone else's process — never taskkill it. Query failure degrades
 * to pid liveness with a note. Returns {killed, note}: killed=false means the
 * tree termination did NOT succeed (or identity said leave it alone) — the
 * caller must not report the run as stopped (codex P1-06).
 */
export async function terminateRecordedEndpoint(
    endpointPid: number,
    recordedStart: string | null | undefined,
): Promise<{ killed: boolean; note: string | null }> {
    const verdict = await verifyProcessIdentity(endpointPid, recordedStart)
    if (verdict === 'mismatch') {
        return {
            killed: false,
            note: `endpoint pid ${endpointPid} start-token mismatch (pid reused by another process); not killed, treated as already gone`,
        }
    }
    if (!pidAlive(endpointPid)) return { killed: true, note: null }
    const term = await terminateEndpointTree(endpointPid)
    const identityNote = verdict === 'unknown'
        ? 'endpoint identity could not be re-verified (query unavailable); killed on pid liveness alone'
        : null
    if (!term.ok) {
        return {
            killed: false,
            note: `endpoint tree termination failed (pid ${endpointPid}: ${term.error}); the endpoint may still be running — verify before re-dispatching`,
        }
    }
    return { killed: true, note: identityNote }
}

/** Cancel-side settlement: result.json is the authority. Returns the settled terminal state, or 'attention' when result.json could not be settled at all (never claim a terminal state we could not record). */
export async function writeCancelledDirect(store: RunStore, state: RunStateRecord, note: string): Promise<'cancelled' | 'attention' | RunResult['state']> {
    const terminalAt = new Date().toISOString()
    const draft: RunResult = {
        schema_version: '1.0.0',
        run_id: state.run_id,
        state: 'cancelled',
        exit_code: null,
        final_text: '',
        evidence: {
            deliverables: [],
            refusals: [],
            parser: { type: 'none', degraded: false },
            notes: [note],
        },
        usage: { input_tokens: null, output_tokens: null, cached_input_tokens: null, cost: null, source: 'unavailable' },
        session_handle: state.session.handle,
        terminal_at: terminalAt,
    }
    const settled = await store.settleResult(draft).catch(() => null)
    if (settled === null) {
        // result.json could not be settled (corrupt/unreadable): keep the run in
        // attention rather than claiming a terminal state nothing backs
        try {
            if (state.state !== 'attention') await store.writeState(transitionRecord(state, 'attention', terminalAt))
        } catch { /* state unchanged; reconcile will flag it */ }
        return 'attention'
    }
    const winnerState = settled.winner.state
    try {
        if (state.state !== winnerState) await store.writeState(transitionRecord(state, winnerState, settled.winner.terminal_at))
    } catch {
        // already transitioned by the worker
    }
    return winnerState
}
