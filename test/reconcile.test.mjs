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
    const { request, state } = await store.create(BASE_INPUT, OLD)
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

test('live pid with a mismatched start token (pid reused) -> attention', async () => {
    const { dir, store } = await tmpStore()
    try {
        const runId = await runningWithWorker(store, {
            pid: process.pid, started_at: OLD, pid_start: 'recorded-token', endpoint_pid: null,
        })
        const report = await reconcileRuns(store, { queryStart: async () => 'different-token' })
        assert.deepEqual(report.errors, [])
        assert.deepEqual(report.changed, [{ run_id: runId, from: 'running', to: 'attention' }])
        const events = await store.readEvents(runId)
        assert.ok(
            events.some((e) => e.type === 'reconcile' && e.note.includes('reused by another process')),
            `events: ${JSON.stringify(events)}`,
        )
    } finally {
        await fs.rm(dir, { recursive: true, force: true })
    }
})

test('live pid with a matching start token -> untouched', async () => {
    const { dir, store } = await tmpStore()
    try {
        const runId = await runningWithWorker(store, {
            pid: process.pid, started_at: OLD, pid_start: 'recorded-token', endpoint_pid: null,
        })
        const report = await reconcileRuns(store, { queryStart: async () => 'recorded-token' })
        assert.deepEqual(report.errors, [])
        assert.deepEqual(report.changed, [])
        assert.equal((await store.readState(runId)).state, 'running')
    } finally {
        await fs.rm(dir, { recursive: true, force: true })
    }
})

test('identity query unavailable degrades to pid liveness -> untouched while alive', async () => {
    const { dir, store } = await tmpStore()
    try {
        const runId = await runningWithWorker(store, {
            pid: process.pid, started_at: OLD, pid_start: 'recorded-token', endpoint_pid: null,
        })
        const report = await reconcileRuns(store, { queryStart: async () => null })
        assert.deepEqual(report.errors, [])
        assert.deepEqual(report.changed, [])
        assert.equal((await store.readState(runId)).state, 'running')
    } finally {
        await fs.rm(dir, { recursive: true, force: true })
    }
})
