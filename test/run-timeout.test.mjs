// Engine wall-clock run timeout (worker timer + 'run timeout after Ns' note)
// and the submit-side --run-timeout / config resolution. Fully isolated:
// PAIDAN_HOME/PAIDAN_DATA_DIR/PAIDAN_ENDPOINTS_DIR all point at tmp dirs.

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { test } from 'node:test'
import { effectiveRunTimeoutSec, loadConfig, DEFAULT_RUN_TIMEOUT_SEC } from '../dist/engine/config.js'

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

async function sleeperEnv(root) {
    const endpointsDir = nodePath.join(root, 'endpoints')
    const work = nodePath.join(root, 'work')
    await fs.mkdir(endpointsDir, { recursive: true })
    await fs.mkdir(work, { recursive: true })
    const fakeBin = nodePath.join(repoRoot, 'test', 'fixtures', 'fake-sleeper.cjs')
    await fs.writeFile(nodePath.join(endpointsDir, 'fake-sleeper.json'), JSON.stringify({
        schema_version: '1.0.0',
        name: 'fake-sleeper',
        detect: { bin: fakeBin },
        command: { argv: ['{bin}', '-p', '{prompt}'], prompt_delivery: 'argv' },
        permission: {
            'fs.read': { status: 'supported' },
            'fs.write': { status: 'supported' },
            presets: { 'workspace-write': 'supported' },
        },
        parser: 'kimi-print',
    }))
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

test('run timeout kills the endpoint tree -> failed + "run timeout after Ns" note', async () => {
    const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'paidan-timeout-'))
    try {
        const { work, env } = await sleeperEnv(root)
        const started = Date.now()
        const run = await paidan(env, [
            'run', '--endpoint', 'fake-sleeper', '--cwd', work, '--task', 'x', '--run-timeout', '2',
        ])
        assert.equal(run.ok, true, JSON.stringify(run))
        const got = await paidan(env, ['get', run.run_id, '--wait', '--timeout', '45'])
        assert.equal(got.terminal, true, JSON.stringify(got))
        assert.equal(got.run.state, 'failed')
        assert.ok(
            got.result.evidence.notes.some((n) => n === 'run timeout after 2s'),
            `notes: ${JSON.stringify(got.result.evidence.notes)}`,
        )
        const events = (await fs.readFile(nodePath.join(root, 'data', 'runs', run.run_id, 'events.jsonl'), 'utf8'))
            .trim().split('\n').map((l) => JSON.parse(l))
        assert.ok(events.some((e) => e.type === 'run-timeout' && e.after_sec === 2), 'run-timeout event')
        // well under the fixture's 30s sleep: the process was actually killed
        assert.ok(Date.now() - started < 30_000)
    } finally {
        await fs.rm(root, { recursive: true, force: true })
    }
})

test('default timeout lands in request.json; --run-timeout overrides it; negatives are rejected', async () => {
    const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'paidan-timeout-flag-'))
    try {
        const { work, env } = await sleeperEnv(root)
        const bad = await paidan(env, ['run', '--endpoint', 'fake-sleeper', '--cwd', work, '--task', 'x', '--run-timeout=-1'])
        assert.equal(bad.ok, false)
        assert.equal(bad.error.code, 'ARGS_INVALID')

        // config default wins when no flag is given
        const home = nodePath.join(root, 'home')
        await fs.mkdir(home, { recursive: true })
        await fs.writeFile(nodePath.join(home, 'config.json'), JSON.stringify({ defaults: { run_timeout_sec: 42 } }))
        const run = await paidan(env, ['run', '--endpoint', 'fake-sleeper', '--cwd', work, '--task', 'x'])
        assert.equal(run.ok, true, JSON.stringify(run))
        const req = JSON.parse(await fs.readFile(nodePath.join(root, 'data', 'runs', run.run_id, 'request.json'), 'utf8'))
        assert.equal(req.run_timeout_sec, 42)
        await paidan(env, ['cancel', run.run_id])
    } finally {
        await fs.rm(root, { recursive: true, force: true })
    }
})

test('effectiveRunTimeoutSec: flag ?? config ?? 1800; 0 disables and is honored', () => {
    const bare = loadConfig(nodePath.join(os.tmpdir(), 'definitely-missing', 'config.json'))
    assert.equal(effectiveRunTimeoutSec(null, bare), DEFAULT_RUN_TIMEOUT_SEC)
    const withConfig = { ...bare, defaults: { ...bare.defaults, run_timeout_sec: 7 } }
    assert.equal(effectiveRunTimeoutSec(null, withConfig), 7)
    assert.equal(effectiveRunTimeoutSec(3, withConfig), 3)
    assert.equal(effectiveRunTimeoutSec(0, withConfig), 0)
})
