// cmd.exe shim + argv prompt delivery is refused at submit (SPAWN_UNSUPPORTED):
// npm .cmd shims pass a bare %* and re-split the caret-escaped command line on
// spaces, so task text could smuggle real flags past argument boundaries.
// stdin delivery through the same shim is unaffected, and a config override to
// a native binary/JS bundle repairs an argv endpoint. Fully isolated tmp dirs.

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { test } from 'node:test'
import { waitForWorkerExit } from './helpers/worker.mjs'

// Bare-name .cmd lookup uses Windows PATHEXT. The JS override below bypasses
// that lookup and remains a real end-to-end test on every platform.
const windowsOnly = { skip: process.platform !== 'win32' && 'requires Windows PATHEXT and cmd.exe' }

const execFileAsync = promisify(execFile)
const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const CLI = nodePath.join(repoRoot, 'dist', 'cli.js')

async function paidan(env, args) {
    try {
        const { stdout } = await execFileAsync(process.execPath, [CLI, ...args], { env, timeout: 60_000 })
        return JSON.parse(stdout.trim())
    } catch (err) {
        // error envelopes are JSON on stdout too; only the exit code is non-zero
        if (err.stdout) return JSON.parse(err.stdout.trim())
        throw err
    }
}

/**
 * One fake endpoint whose detect.bin is a bare name resolving ONLY to a .cmd
 * shim: PATH is just the shim dir, the npm roots point at nothing and the
 * manifest declares no npm layout, so the spawn plan must land on cmd-shim.
 */
async function shimEnv(root, promptDelivery) {
    const endpointsDir = nodePath.join(root, 'endpoints')
    const shimDir = nodePath.join(root, 'shim')
    const work = nodePath.join(root, 'work')
    const home = nodePath.join(root, 'home')
    await fs.mkdir(endpointsDir, { recursive: true })
    await fs.mkdir(shimDir, { recursive: true })
    await fs.mkdir(work, { recursive: true })
    await fs.mkdir(home, { recursive: true })
    await fs.writeFile(nodePath.join(shimDir, 'fakebin.CMD'), '@echo off\r\n')
    await fs.writeFile(nodePath.join(endpointsDir, 'fake-shim.json'), JSON.stringify({
        schema_version: '1.0.0',
        name: 'fake-shim',
        detect: { bin: 'fakebin' },
        command: {
            argv: promptDelivery === 'argv' ? ['{bin}', '-p', '{prompt}'] : ['{bin}', '-'],
            prompt_delivery: promptDelivery,
        },
        permission: {
            'fs.read': { status: 'supported' },
            'fs.write': { status: 'supported' },
            presets: { 'workspace-write': 'supported' },
        },
        parser: 'kimi-print',
    }))
    return {
        work,
        home,
        env: {
            ...process.env,
            PAIDAN_HOME: home,
            PAIDAN_DATA_DIR: nodePath.join(root, 'data'),
            PAIDAN_ENDPOINTS_DIR: endpointsDir,
            PATH: shimDir,
            PATHEXT: '.CMD;.EXE',
            APPDATA: nodePath.join(root, 'no-appdata'),
            NPM_CONFIG_PREFIX: nodePath.join(root, 'no-npm-prefix'),
        },
    }
}

test('argv delivery resolving to a cmd-shim is refused with SPAWN_UNSUPPORTED before any run exists', windowsOnly, async () => {
    const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'paidan-cmdshim-'))
    try {
        const { work, env } = await shimEnv(root, 'argv')
        const doctor = await paidan(env, ['doctor'])
        const endpoint = doctor.endpoints.find((e) => e.name === 'fake-shim')
        assert.equal(endpoint.resolved_from, 'cmd-shim')
        assert.equal(endpoint.spawn_supported, false)
        assert.match(endpoint.repair_hint, /endpoints\.overrides\.fake-shim\.bin/)
        assert.ok(doctor.issues.some((issue) => issue.includes('cannot preserve argument boundaries')))
        const res = await paidan(env, ['run', '--endpoint', 'fake-shim', '--cwd', work, '--task', 'x'])
        assert.equal(res.ok, false)
        assert.equal(res.error.code, 'SPAWN_UNSUPPORTED')
        assert.match(res.error.message, /cannot preserve argument boundaries/)
        assert.match(res.error.message, /%\*/)
        assert.match(res.error.message, /endpoints\.overrides\.fake-shim\.bin/)
        const runs = await fs.readdir(nodePath.join(root, 'data', 'runs')).catch(() => [])
        assert.deepEqual(runs, [], 'refused submit leaves no run dir')
    } finally {
        await fs.rm(root, { recursive: true, force: true })
    }
})

test('stdin delivery through the same cmd-shim is not refused', windowsOnly, async () => {
    const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'paidan-cmdshim-stdin-'))
    try {
        const { work, env } = await shimEnv(root, 'stdin')
        const run = await paidan(env, ['run', '--endpoint', 'fake-shim', '--cwd', work, '--task', 'x'])
        assert.equal(run.ok, true, JSON.stringify(run))
        // the worker actually spawns through the shim and reaches a terminal state
        const got = await paidan(env, ['get', run.run_id, '--wait', '--timeout', '45'])
        assert.equal(got.terminal, true, JSON.stringify(got))
        await waitForWorkerExit(env.PAIDAN_DATA_DIR, run.run_id)
        const events = (await fs.readFile(nodePath.join(root, 'data', 'runs', run.run_id, 'events.jsonl'), 'utf8'))
            .trim().split('\n').map((line) => JSON.parse(line))
        assert.ok(events.some((e) => e.type === 'spawn' && e.resolved_from === 'cmd-shim'), 'worker used the shim')
    } finally {
        await fs.rm(root, { recursive: true, force: true })
    }
})

test('a config override to a JS bundle repairs the argv endpoint (no cmd-shim, submit accepted)', async () => {
    const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'paidan-cmdshim-override-'))
    try {
        const { work, home, env } = await shimEnv(root, 'argv')
        const fakeBin = nodePath.join(repoRoot, 'test', 'fixtures', 'fake-kimi.cjs')
        await fs.writeFile(nodePath.join(home, 'config.json'), JSON.stringify({
            endpoints: { overrides: { 'fake-shim': { bin: fakeBin } } },
        }))
        const run = await paidan(env, ['run', '--endpoint', 'fake-shim', '--cwd', work, '--task', 'x'])
        assert.equal(run.ok, true, JSON.stringify(run))
        const got = await paidan(env, ['get', run.run_id, '--wait', '--timeout', '60'])
        assert.equal(got.run.state, 'completed', JSON.stringify(got))
        await waitForWorkerExit(env.PAIDAN_DATA_DIR, run.run_id)
    } finally {
        await fs.rm(root, { recursive: true, force: true })
    }
})
