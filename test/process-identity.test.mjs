// PID-reuse identity (src/engine/process-identity.ts + reconcile integration):
// match / mismatch / query-failure paths, plus a live self-query smoke.
// Reconcile gets the query injected; the store is real (tmp dirs only).

import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import { test } from 'node:test'
import { queryProcessStart, verifyProcessIdentity } from '../dist/engine/process-identity.js'
import { reconcileRuns } from '../dist/engine/reconcile.js'
import { RunStore } from '../dist/engine/run-store.js'

test('verifyProcessIdentity: match / mismatch / unknown paths', async () => {
    const q = (token) => async () => token
    assert.equal(await verifyProcessIdentity(1234, 'A', q('A')), 'match')
    assert.equal(await verifyProcessIdentity(1234, 'A', q('B')), 'mismatch')
    assert.equal(await verifyProcessIdentity(1234, 'A', q(null)), 'unknown')
    assert.equal(await verifyProcessIdentity(1234, null, q('A')), 'unknown')
    assert.equal(await verifyProcessIdentity(1234, undefined, q('A')), 'unknown')
})

test('queryProcessStart returns a start token for this process on every supported platform', async () => {
    const token = await queryProcessStart(process.pid)
    assert.ok(typeof token === 'string' && token.length > 0, `start token for self: ${JSON.stringify(token)}`)
    assert.equal(await queryProcessStart(-1), null)
})

async function storeWithRunningRun(pidStart) {
    const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'paidan-identity-'))
    const store = new RunStore(nodePath.join(root, 'data'))
    const created = await store.create({
        endpoint: 'fake',
        cwd: root,
        add_dirs: [],
        task_file: null,
        task_text: 'x',
        mode: 'workspace-write',
        model: null,
        effort: null,
        resume_session: null,
        run_timeout_sec: 1800,
        deliverables: [],
        warnings: [],
    })
    await store.patchState(created.request.run_id, new Date().toISOString(), {
        worker: { pid: process.pid, started_at: new Date().toISOString(), pid_start: pidStart, endpoint_pid: null },
    })
    return { root, store, runId: created.request.run_id }
}

test('reconcile: start-token match keeps the run; mismatch marks attention; query failure degrades to liveness', async () => {
    // match: pid alive and the same token -> untouched
    {
        const { root, store, runId } = await storeWithRunningRun('token-A')
        try {
            const report = await reconcileRuns(store, { queryStart: async () => 'token-A' })
            assert.deepEqual(report.changed, [])
            assert.equal((await store.readState(runId)).state, 'pending')
        } finally {
            await fs.rm(root, { recursive: true, force: true })
        }
    }
    // mismatch: the pid was reused -> the recorded worker is gone -> attention
    {
        const { root, store, runId } = await storeWithRunningRun('token-A')
        try {
            const report = await reconcileRuns(store, { queryStart: async () => 'token-B' })
            assert.deepEqual(report.changed, [{ run_id: runId, from: 'pending', to: 'attention' }])
            const events = await store.readEvents(runId)
            assert.ok(
                events.some((e) => e.type === 'reconcile' && String(e.note).includes('reused')),
                `events: ${JSON.stringify(events)}`,
            )
        } finally {
            await fs.rm(root, { recursive: true, force: true })
        }
    }
    // query failure: degrade to pid liveness (pid alive -> untouched), never crash
    {
        const { root, store, runId } = await storeWithRunningRun('token-A')
        try {
            const report = await reconcileRuns(store, { queryStart: async () => null })
            assert.deepEqual(report.changed, [])
            assert.equal((await store.readState(runId)).state, 'pending')
        } finally {
            await fs.rm(root, { recursive: true, force: true })
        }
    }
    // no recorded token (old record): pid liveness only
    {
        const { root, store, runId } = await storeWithRunningRun(null)
        try {
            const report = await reconcileRuns(store, { queryStart: async () => 'token-B' })
            assert.deepEqual(report.changed, [])
            assert.equal((await store.readState(runId)).state, 'pending')
        } finally {
            await fs.rm(root, { recursive: true, force: true })
        }
    }
})
