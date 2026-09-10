// Worker robustness: identity-verified kill on cancel, cancel/completion race
// evidence preservation, the stdio line cap, and the cmd-shim+argv spawn
// refusal. Fully isolated: PAIDAN_HOME/PAIDAN_DATA_DIR/PAIDAN_ENDPOINTS_DIR
// all point at tmp dirs; no real agent is touched.

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { test } from 'node:test'
import { RunStore } from '../dist/engine/run-store.js'

const execFileAsync = promisify(execFile)
const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const CLI = nodePath.join(repoRoot, 'dist', 'cli.js')
const WORKER = nodePath.join(repoRoot, 'dist', 'worker.js')

async function paidan(env, args) {
    try {
        const { stdout } = await execFileAsync(process.execPath, [CLI, ...args], { env, timeout: 90_000 })
        return JSON.parse(stdout.trim())
    } catch (err) {
        // error envelopes are JSON on stdout too; only the exit code is non-zero
        if (err.stdout) return JSON.parse(err.stdout.trim())
        throw err
    }
}

async function mkEnv(root, manifest) {
    const endpointsDir = nodePath.join(root, 'endpoints')
    const work = nodePath.join(root, 'work')
    await fs.mkdir(endpointsDir, { recursive: true })
    await fs.mkdir(work, { recursive: true })
    await fs.writeFile(nodePath.join(endpointsDir, `${manifest.name}.json`), JSON.stringify(manifest))
    return {
        work,
        env: {
            ...process.env,
            PAIDAN_HOME: nodePath.join(root, 'home'),
            PAIDAN_DATA_DIR: nodePath.join(root, 'data'),
            PAIDAN_ENDPOINTS_DIR: endpointsDir,
        },
    }
}

const fixtureManifest = (name, bin) => ({
    schema_version: '1.0.0',
    name,
    detect: { bin },
    command: { argv: ['{bin}', '-p', '{prompt}'], prompt_delivery: 'argv' },
    permission: {
        'fs.read': { status: 'supported' },
        'fs.write': { status: 'supported' },
        presets: { 'workspace-write': 'supported' },
    },
    parser: 'kimi-print',
})

async function readEvents(root, runId) {
    return (await fs.readFile(nodePath.join(root, 'data', 'runs', runId, 'events.jsonl'), 'utf8'))
        .trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

test('cancel re-verifies identity, then still kills the endpoint tree', async () => {
    const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'paidan-cancel-kill-'))
    try {
        const bin = nodePath.join(repoRoot, 'test', 'fixtures', 'fake-sleeper.cjs')
        const { work, env } = await mkEnv(root, fixtureManifest('fake-sleeper', bin))
        const run = await paidan(env, ['run', '--endpoint', 'fake-sleeper', '--cwd', work, '--task', 'x'])
        assert.equal(run.ok, true, JSON.stringify(run))
        // wait until the worker registered, then cancel mid-sleep (fixture sleeps 30s)
        let state
        for (let i = 0; i < 75; i++) {
            state = (await paidan(env, ['get', run.run_id])).run.state
            if (state === 'running') break
            await new Promise((r) => setTimeout(r, 200))
        }
        assert.equal(state, 'running')
        const cancelled = await paidan(env, ['cancel', run.run_id])
        assert.equal(cancelled.state, 'cancelled', JSON.stringify(cancelled))
        const events = await readEvents(root, run.run_id)
        const kill = events.find((e) => e.type === 'cancel')
        assert.ok(kill, 'cancel event recorded')
        assert.ok(
            kill.method === 'taskkill' || kill.method === 'taskkill_force',
            `the live endpoint was actually taskkilled (method ${kill.method})`,
        )
        assert.ok(
            !events.some((e) => e.type === 'note' && String(e.note).includes('identity mismatch')),
            'a live endpoint must never be skipped as pid-reused',
        )
        const got = await paidan(env, ['get', run.run_id, '--wait', '--timeout', '30'])
        assert.equal(got.run.state, 'cancelled')
    } finally {
        await fs.rm(root, { recursive: true, force: true })
    }
})

test('cancel racing a successful completion keeps deliverable/parser/usage evidence', async () => {
    const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'paidan-cancel-race-'))
    try {
        const bin = nodePath.join(repoRoot, 'test', 'fixtures', 'fake-finish-then-cancel.cjs')
        const { work, env } = await mkEnv(root, fixtureManifest('fake-finisher', bin))
        const run = await paidan(env, [
            'run', '--endpoint', 'fake-finisher', '--cwd', work, '--task', 'x',
            '--deliverable', 'fake-deliverable.txt',
        ])
        assert.equal(run.ok, true, JSON.stringify(run))
        const got = await paidan(env, ['get', run.run_id, '--wait', '--timeout', '30'])
        assert.equal(got.terminal, true, JSON.stringify(got))
        // terminal state is cancelled, but the completed endpoint's evidence survives
        assert.equal(got.run.state, 'cancelled')
        assert.deepEqual(got.result.evidence.deliverables, [
            { path: 'fake-deliverable.txt', expected: null, found: true },
        ])
        assert.deepEqual(got.result.evidence.parser, { type: 'kimi-print', degraded: false })
        assert.equal(got.result.final_text, 'finished before cancel')
        assert.equal(got.result.usage.source, 'unavailable')
        assert.ok(
            got.result.evidence.notes.some((n) => n.startsWith('cancel requested by user')),
            `notes: ${JSON.stringify(got.result.evidence.notes)}`,
        )
    } finally {
        await fs.rm(root, { recursive: true, force: true })
    }
})

test('a single-line stdout flood beyond 16 MiB is truncated, not buffered forever', async () => {
    const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'paidan-flood-'))
    try {
        const bin = nodePath.join(repoRoot, 'test', 'fixtures', 'fake-flood.cjs')
        const { work, env } = await mkEnv(root, fixtureManifest('fake-flood', bin))
        const run = await paidan(env, ['run', '--endpoint', 'fake-flood', '--cwd', work, '--task', 'x'])
        assert.equal(run.ok, true, JSON.stringify(run))
        const got = await paidan(env, ['get', run.run_id, '--wait', '--timeout', '60'])
        assert.equal(got.terminal, true, JSON.stringify(got))
        const events = await readEvents(root, run.run_id)
        const trunc = events.find((e) => e.type === 'stdio-truncated' && e.stream === 'stdout')
        assert.ok(trunc, 'stdio-truncated event recorded')
        assert.ok(trunc.bytes > 16 * 1024 * 1024, `buffered bytes at truncation: ${trunc.bytes}`)
        assert.equal(got.result.evidence.parser.degraded, true, 'a capped line honestly degrades the parser')
    } finally {
        await fs.rm(root, { recursive: true, force: true })
    }
})

test('cmd-shim + argv prompt delivery is refused before spawn (worker backstop)', async () => {
    const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'paidan-shim-refuse-'))
    try {
        const shimDir = nodePath.join(root, 'shim-bin')
        await fs.mkdir(shimDir, { recursive: true })
        const shim = nodePath.join(shimDir, 'fake-argv-shim.cmd')
        await fs.writeFile(shim, '@echo off\r\necho SHOULD_NEVER_RUN> "%~dp0ran.txt"\r\n')
        const { work, env } = await mkEnv(root, fixtureManifest('fake-argv-shim', shim))
        // drive the worker directly: the CLI-side twin guard (owned by another
        // change) must not mask this worker-side backstop
        const store = new RunStore(nodePath.join(root, 'data'))
        const { request } = await store.create({
            endpoint: 'fake-argv-shim',
            cwd: work,
            add_dirs: [],
            task_file: null,
            task_text: 'x',
            mode: 'workspace-write',
            model: null,
            effort: null,
            resume_session: null,
            run_timeout_sec: 60,
            deliverables: [],
            warnings: [],
        })
        await execFileAsync(process.execPath, [WORKER, request.run_id], { env, timeout: 30_000 })
        const state = await store.readState(request.run_id)
        assert.equal(state.state, 'failed')
        const result = await store.readResult(request.run_id)
        assert.ok(
            result.evidence.notes.some((n) =>
                n.includes('cmd.exe shims cannot preserve argument boundaries for argv prompt delivery')
                && n.includes('re-split on spaces')
                && n.includes('endpoints.overrides.fake-argv-shim.bin')),
            `notes: ${JSON.stringify(result.evidence.notes)}`,
        )
        const events = await readEvents(root, request.run_id)
        assert.ok(events.some((e) => e.type === 'spawn-refused'), 'spawn-refused event recorded')
        assert.ok(!events.some((e) => e.type === 'spawn'), 'nothing was spawned')
        await assert.rejects(fs.stat(nodePath.join(shimDir, 'ran.txt')), 'the shim never ran')
    } finally {
        await fs.rm(root, { recursive: true, force: true })
    }
})
