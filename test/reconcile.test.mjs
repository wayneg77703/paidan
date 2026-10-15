// Reconcile: dead workers, spawn grace, terminal-state adoption, and the
// PID-reuse identity re-verification. Runs against a throwaway tmp data dir;
// the process-start query is injected via reconcileRuns opts, pid liveness
// uses a reaped child pid (certainly dead) and the test's own pid (alive).

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import { test } from 'node:test'
import { reconcileRuns } from '../dist/engine/reconcile.js'
import { RunStore } from '../dist/engine/run-store.js'
import { transitionRecord } from '../dist/engine/state-machine.js'

async function tmpStore() {
    const dir = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'paidan-reconcile-'))
    return { dir, store: new RunStore(dir) }
}

const BASE_INPUT = {
    endpoint: 'kimi-code',
    cwd: 'D:/work/thing',
    add_dirs: [],
    task_file: null,
    task_text: 'summarize this repo',
    mode: 'workspace-write',
    model: null,
    effort: null,
    resume_session: null,
    deliverables: [],
    warnings: [],
}

const OLD = new Date(Date.now() - 10 * 60_000).toISOString()

/** A pid that is certainly dead: a child we spawned and reaped. */
async function deadPid() {
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
    await new Promise((resolve) => child.once('exit', resolve))
    return child.pid
}

async function runningWithWorker(store, worker) {
    const { request, state } = await store.create({ ...BASE_INPUT, task_text: `${BASE_INPUT.task_text}: ${JSON.stringify(worker)}` }, OLD)
    await store.writeState(transitionRecord(state, 'running', OLD, { worker }))
    return request.run_id
}

test('worker pid dead and no result.json -> attention (never restarted)', async () => {
    const { dir, store } = await tmpStore()
    try {
        const pid = await deadPid()
        const runId = await runningWithWorker(store, { pid, started_at: OLD, endpoint_pid: null })
        const report = await reconcileRuns(store)
        assert.deepEqual(report.errors, [])
        assert.deepEqual(report.changed, [{ run_id: runId, from: 'running', to: 'attention' }])
        assert.equal((await store.readState(runId)).state, 'attention')
        const events = await store.readEvents(runId)
        assert.ok(
            events.some((e) => e.type === 'reconcile' && e.note.includes(`worker pid ${pid} is dead`)),
            `events: ${JSON.stringify(events)}`,
        )
    } finally {
        await fs.rm(dir, { recursive: true, force: true })
    }
})

test('worker not yet observable within the spawn grace window -> untouched', async () => {
    const { dir, store } = await tmpStore()
    try {
        const { request } = await store.create(BASE_INPUT) // pending, worker null, created now
        const report = await reconcileRuns(store)
        assert.deepEqual(report.errors, [])
        assert.deepEqual(report.changed, [])
        assert.equal((await store.readState(request.run_id)).state, 'pending')
    } finally {
        await fs.rm(dir, { recursive: true, force: true })
    }
})

test('worker dead but result.json holds a terminal state -> adopt it, not attention', async () => {
    const { dir, store } = await tmpStore()
    try {
        const pid = await deadPid()
        const runId = await runningWithWorker(store, { pid, started_at: OLD, endpoint_pid: null })
        await store.settleResult({
            schema_version: '1.0.0',
            run_id: runId,
            state: 'completed',
            exit_code: 0,
            final_text: 'done before the worker died',
            evidence: { deliverables: [], refusals: [], parser: { type: 'kimi-print', degraded: false }, notes: [] },
            usage: { input_tokens: null, output_tokens: null, cached_input_tokens: null, cost: null, source: 'unavailable' },
            session_handle: null,
            terminal_at: OLD,
        })
        const report = await reconcileRuns(store)
        assert.deepEqual(report.errors, [])
        assert.deepEqual(report.changed, [{ run_id: runId, from: 'running', to: 'completed' }])
        assert.equal((await store.readState(runId)).state, 'completed')
        const events = await store.readEvents(runId)
        assert.ok(
            events.some((e) => e.type === 'reconcile' && e.note.includes('adopted terminal state completed')),
            `events: ${JSON.stringify(events)}`,
        )
    } finally {
        await fs.rm(dir, { recursive: true, force: true })
    }
})

test('reconcile checks identity for pending and running workers, including legacy records', async () => {
    for (const stateName of ['pending', 'running']) {
        for (const [label, recorded, current, reused] of [
            ['matching identity', 'token-A', 'token-A', false],
            ['reused PID', 'token-A', 'token-B', true],
            ['unavailable query', 'token-A', null, false],
            ['legacy record', null, 'token-B', false],
        ]) {
            const { dir, store } = await tmpStore()
            try {
                const { request, state } = await store.create(BASE_INPUT, OLD)
                const worker = { pid: process.pid, started_at: OLD, pid_start: recorded, endpoint_pid: null }
                await store.writeState(stateName === 'running'
                    ? transitionRecord(state, 'running', OLD, { worker }) : { ...state, worker })
                const report = await reconcileRuns(store, { queryStart: async () => current })
                assert.deepEqual(report.errors, [], label)
                assert.deepEqual(report.changed, reused
                    ? [{ run_id: request.run_id, from: stateName, to: 'attention' }] : [], label)
                assert.equal((await store.readState(request.run_id)).state, reused ? 'attention' : stateName, label)
                if (reused) assert.ok((await store.readEvents(request.run_id))
                    .some(e => e.type === 'reconcile' && e.note.includes('reused by another process')), label)
            } finally {
                await fs.rm(dir, { recursive: true, force: true })
            }
        }
    }
})


test('reconcile batches unique live workers and preserves per-run PID-reuse evidence', async () => {
    const { dir, store } = await tmpStore()
    try {
        const matching = await runningWithWorker(store, { pid: process.pid, pid_start: 'current', started_at: OLD })
        const reused = await runningWithWorker(store, { pid: process.pid, pid_start: 'previous', started_at: OLD })
        await runningWithWorker(store, { pid: process.pid, pid_start: null, started_at: OLD })
        await runningWithWorker(store, { pid: await deadPid(), pid_start: 'gone', started_at: OLD })
        let calls = 0
        const report = await reconcileRuns(store, { queryStarts: async pids => {
            calls++
            assert.deepEqual(pids, [process.pid])
            return new Map([[process.pid, 'current']])
        } })
        assert.equal(calls, 1)
        assert.deepEqual(report.errors, [])
        assert.equal((await store.readState(matching)).state, 'running')
        assert.equal((await store.readState(reused)).state, 'attention')
        assert.ok((await store.readEvents(reused)).some(e => e.note?.includes('start-token mismatch')))
    } finally { await fs.rm(dir, { recursive: true, force: true }) }
})

test('missing batch rows and rejected batch queries preserve live workers as unknown', async () => {
    for (const queryStarts of [async () => new Map(), async () => { throw new Error('CIM unavailable') }]) {
        const { dir, store } = await tmpStore()
        try {
            const id = await runningWithWorker(store, { pid: process.pid, pid_start: 'recorded', started_at: OLD })
            const report = await reconcileRuns(store, { queryStarts })
            assert.deepEqual(report.errors, [])
            assert.deepEqual(report.changed, [])
            assert.equal((await store.readState(id)).state, 'running')
        } finally { await fs.rm(dir, { recursive: true, force: true }) }
    }
})

test('reconcile queries no PIDs outside the nonterminal limit or without identity evidence', async () => {
    const worker = { pid: process.pid, pid_start: 'current', started_at: OLD }
    const record = (run_id, state, ownWorker = worker) => ({ run_id, state, worker: ownWorker, created_at: OLD })
    const runs = [record('done', 'completed'), record('first', 'running'), record('second', 'running', { ...worker, pid: process.ppid })]
    const store = { list: async () => runs }
    let calls = 0
    const queryStarts = async pids => {
        calls++
        assert.deepEqual(pids, [process.pid])
        return new Map([[process.pid, 'current']])
    }
    const report = await reconcileRuns(store, { limit: 1, queryStarts })
    assert.equal(report.scanned, 1)
    assert.equal(calls, 1)
    await reconcileRuns(store, { limit: 0, queryStarts })
    for (const records of [[], [runs[0]], [record('legacy', 'running', { ...worker, pid_start: null })]]) {
        await reconcileRuns({ list: async () => records }, { queryStarts })
    }
    assert.equal(calls, 1, 'no process query for terminal, empty, legacy-only or limit-zero scans')
})


function completedResult(runId) {
    return {
        schema_version: '1.0.0', run_id: runId, state: 'completed', exit_code: 0,
        final_text: 'finished during identity query',
        evidence: { deliverables: [], refusals: [], parser: { type: 'test', degraded: false }, notes: [] },
        usage: { input_tokens: null, output_tokens: null, cached_input_tokens: null, cost: null, source: 'unavailable' },
        session_handle: 'session-finished', terminal_at: OLD,
    }
}

test('identity batch cannot overwrite a terminal state written while it was in flight', async () => {
    for (const withResult of [true, false]) {
        const { dir, store } = await tmpStore()
        try {
            const id = await runningWithWorker(store, { pid: process.pid, pid_start: 'old-worker', started_at: OLD })
            let finished
            const report = await reconcileRuns(store, { queryStarts: async () => {
                const state = await store.readState(id)
                finished = transitionRecord(state, 'completed', OLD, { session: { handle: 'session-finished', resumable: true } })
                if (withResult) await store.settleResult(completedResult(id))
                await store.writeState(finished)
                return new Map([[process.pid, 'replacement-process']])
            } })
            assert.deepEqual(report.errors, [])
            assert.deepEqual(report.changed, [], 'worker completion must not be reported as a reconcile change')
            assert.deepEqual(await store.readState(id), finished, withResult ? 'terminal adoption branch' : 'attention branch')
        } finally { await fs.rm(dir, { recursive: true, force: true }) }
    }
})

test('adoption uses the latest nonterminal fields after the identity batch', async () => {
    const { dir, store } = await tmpStore()
    try {
        const id = await runningWithWorker(store, { pid: process.pid, pid_start: 'old-worker', started_at: OLD })
        const session = { handle: 'session-finished', resumable: true }
        const report = await reconcileRuns(store, { queryStarts: async () => {
            await store.patchState(id, OLD, { session })
            await store.settleResult(completedResult(id))
            return new Map([[process.pid, 'replacement-process']])
        } })
        assert.deepEqual(report.errors, [])
        assert.deepEqual(report.changed, [{ run_id: id, from: 'running', to: 'completed' }])
        assert.deepEqual((await store.readState(id)).session, session)
    } finally { await fs.rm(dir, { recursive: true, force: true }) }
})

test('a worker identity updated during the batch is deferred instead of judged by an old snapshot', async () => {
    const { dir, store } = await tmpStore()
    try {
        const id = await runningWithWorker(store, { pid: process.pid, pid_start: 'old-worker', started_at: OLD })
        const replacement = { pid: process.pid, pid_start: 'new-worker', started_at: OLD }
        const report = await reconcileRuns(store, { queryStarts: async () => {
            await store.patchState(id, OLD, { worker: replacement })
            return new Map([[process.pid, 'new-worker']])
        } })
        assert.deepEqual(report.errors, [])
        assert.deepEqual(report.changed, [])
        assert.equal((await store.readState(id)).state, 'running')
        assert.deepEqual((await store.readState(id)).worker, replacement)
    } finally { await fs.rm(dir, { recursive: true, force: true }) }
})
