// Run-store round trips against a throwaway tmp data dir. Never touches
// %APPDATA% or a real agent.

import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import { test } from 'node:test'
import { RunStore, requestFingerprint, StoreCorruptError } from '../dist/engine/run-store.js'
import { canTransition, transitionRecord } from '../dist/engine/state-machine.js'

async function tmpStore(ttlDays = 30) {
    const dir = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'paidan-test-'))
    return { dir, store: new RunStore(dir, { ttlDays }) }
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

test('create writes request.json + state.json (pending) with stable fingerprint', async () => {
    const { dir, store } = await tmpStore()
    try {
        const { request, state, created } = await store.create(BASE_INPUT, '2026-09-10T00:00:00.000Z')
        assert.equal(created, true)
        assert.match(request.run_id, /^run_\d{8}_[0-9a-f]{8}$/)
        assert.equal(state.state, 'pending')
        assert.equal(
            request.fingerprint,
            requestFingerprint('kimi-code', 'D:/work/thing', 'summarize this repo', 'workspace-write'),
        )
        const diskReq = JSON.parse(await fs.readFile(nodePath.join(dir, 'runs', request.run_id, 'request.json'), 'utf8'))
        assert.equal(diskReq.run_id, request.run_id)
        const diskState = JSON.parse(await fs.readFile(nodePath.join(dir, 'runs', request.run_id, 'state.json'), 'utf8'))
        assert.equal(diskState.state, 'pending')
        assert.equal(diskState.terminal_at, null)
    } finally {
        await fs.rm(dir, { recursive: true, force: true })
    }
})

test('idempotent submit: identical fingerprint on a non-terminal run returns that run', async () => {
    const { dir, store } = await tmpStore()
    try {
        const first = await store.create(BASE_INPUT)
        const second = await store.create(BASE_INPUT)
        assert.equal(second.created, false)
        assert.equal(second.request.run_id, first.request.run_id)
        const other = await store.create({ ...BASE_INPUT, task_text: 'different task' })
        assert.equal(other.created, true)
        assert.notEqual(other.request.run_id, first.request.run_id)
    } finally {
        await fs.rm(dir, { recursive: true, force: true })
    }
})

test('idempotent submit does NOT match a terminal run', async () => {
    const { dir, store } = await tmpStore()
    try {
        const first = await store.create(BASE_INPUT)
        const running = transitionRecord(first.state, 'running', new Date().toISOString())
        const done = transitionRecord(running, 'completed', new Date().toISOString())
        await store.writeState(done)
        const second = await store.create(BASE_INPUT)
        assert.equal(second.created, true)
        assert.notEqual(second.request.run_id, first.request.run_id)
    } finally {
        await fs.rm(dir, { recursive: true, force: true })
    }
})

test('state machine: legal transitions enforced', async () => {
    const { dir, store } = await tmpStore()
    try {
        const { state } = await store.create(BASE_INPUT)
        assert.equal(canTransition('pending', 'running'), true)
        assert.equal(canTransition('running', 'pending'), false)
        assert.equal(canTransition('completed', 'running'), false)
        assert.equal(canTransition('attention', 'cancelled'), true)
        assert.equal(canTransition('attention', 'running'), false)
        const running = transitionRecord(state, 'running', new Date().toISOString(), {
            worker: { pid: 1234, started_at: new Date().toISOString(), endpoint_pid: 5678 },
        })
        await store.writeState(running)
        const done = transitionRecord(running, 'unknown', new Date().toISOString())
        assert.ok(done.terminal_at)
        await store.writeState(done)
        assert.throws(() => transitionRecord(done, 'running', new Date().toISOString()), /illegal transition/)
    } finally {
        await fs.rm(dir, { recursive: true, force: true })
    }
})

test('result.json is write-once: identical rewrite is a no-op, conflicting rewrite throws', async () => {
    const { dir, store } = await tmpStore()
    try {
        const { request } = await store.create(BASE_INPUT)
        const result = {
            schema_version: '1.0.0',
            run_id: request.run_id,
            state: 'unknown',
            exit_code: 0,
            final_text: '',
            evidence: { deliverables: [], refusals: [], parser: { type: 'kimi-print', degraded: false }, notes: ['x'] },
            usage: { input_tokens: null, output_tokens: null, cached_input_tokens: null, source: 'unavailable' },
            session_handle: null,
            terminal_at: new Date().toISOString(),
        }
        await store.writeResult(result)
        await store.writeResult(result) // identical: no-op
        await assert.rejects(
            store.writeResult({ ...result, final_text: 'different' }),
            (err) => err instanceof StoreCorruptError,
        )
        const read = await store.readResult(request.run_id)
        assert.equal(read.state, 'unknown')
    } finally {
        await fs.rm(dir, { recursive: true, force: true })
    }
})

test('events.jsonl appends and reads back', async () => {
    const { dir, store } = await tmpStore()
    try {
        const { request } = await store.create(BASE_INPUT)
        await store.appendEvent(request.run_id, { ts: 't1', type: 'spawn', pid: 42 })
        await store.appendEvent(request.run_id, { ts: 't2', type: 'terminal', state: 'completed' })
        const events = await store.readEvents(request.run_id)
        assert.equal(events.length, 2)
        assert.equal(events[1].type, 'terminal')
    } finally {
        await fs.rm(dir, { recursive: true, force: true })
    }
})

test('list() piggy-backs TTL cleanup: old terminal runs are removed, fresh ones kept', async () => {
    const { dir, store } = await tmpStore(30)
    try {
        const old = await store.create(BASE_INPUT)
        const fresh = await store.create({ ...BASE_INPUT, task_text: 'fresh task' })
        const oldTerminal = {
            ...(await store.readState(old.request.run_id)),
            state: 'completed',
            terminal_at: new Date(Date.now() - 40 * 24 * 3600 * 1000).toISOString(),
            updated_at: new Date(Date.now() - 40 * 24 * 3600 * 1000).toISOString(),
        }
        await store.writeState(oldTerminal)
        const freshTerminal = {
            ...(await store.readState(fresh.request.run_id)),
            state: 'failed',
            terminal_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
        }
        await store.writeState(freshTerminal)
        const listed = await store.list()
        const ids = listed.map((s) => s.run_id)
        assert.ok(!ids.includes(old.request.run_id), 'expired terminal run should be cleaned')
        assert.ok(ids.includes(fresh.request.run_id), 'fresh terminal run should be kept')
        await assert.rejects(fs.stat(store.runDir(old.request.run_id)))
    } finally {
        await fs.rm(dir, { recursive: true, force: true })
    }
})

test('unsafe run_id is rejected', async () => {
    const { dir, store } = await tmpStore()
    try {
        await assert.rejects(store.readState('../escape'), /unsafe run_id/)
        await assert.rejects(store.readState('run_20260910_zzzzzzzz'), /unsafe run_id/)
    } finally {
        await fs.rm(dir, { recursive: true, force: true })
    }
})
