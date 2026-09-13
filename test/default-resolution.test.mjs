// Submit-time defaults resolution and gates: config schema validation and the
// --flag ?? per-endpoint ?? global resolution order for models AND efforts,
// plus the MODEL_UNSUPPORTED / EFFORT_UNSUPPORTED / EFFORT_INVALID submit gates.
// Fully isolated via PAIDAN_HOME/PAIDAN_DATA_DIR/PAIDAN_ENDPOINTS_DIR at tmp dirs.

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { test } from 'node:test'
import { loadConfig } from '../dist/engine/config.js'
import { waitForWorkerExit } from './helpers/worker.mjs'

const execFileAsync = promisify(execFile)
const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const CLI = nodePath.join(repoRoot, 'dist', 'cli.js')

async function paidan(env, args) {
    try {
        const { stdout } = await execFileAsync(process.execPath, [CLI, ...args], { env, timeout: 60_000 })
        return JSON.parse(stdout.trim())
    } catch (err) {
        if (err.stdout) return JSON.parse(err.stdout.trim())
        throw err
    }
}

async function mkEnv(root) {
    const endpointsDir = nodePath.join(root, 'endpoints')
    const work = nodePath.join(root, 'work')
    const home = nodePath.join(root, 'home')
    await fs.mkdir(endpointsDir, { recursive: true })
    await fs.mkdir(work, { recursive: true })
    await fs.mkdir(home, { recursive: true })
    const fakeBin = nodePath.join(repoRoot, 'test', 'fixtures', 'fake-sleeper.cjs')
    await fs.writeFile(nodePath.join(endpointsDir, 'fake-sleeper.json'), JSON.stringify({
        schema_version: '1.0.0',
        name: 'fake-sleeper',
        detect: { bin: fakeBin },
        command: {
            argv: ['{bin}', '-p', '{prompt}'],
            prompt_delivery: 'argv',
            model_arg: ['--model', '{model}'],
        },
        effort: { options: ['low', 'high'], arg: ['--thinking', '{effort}'] },
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
        },
    }
}

test('loadConfig: defaults.models parses; non-string entries and typos are hard errors', async () => {
    const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'paidan-cfg-'))
    try {
        const p = nodePath.join(root, 'config.json')
        await fs.writeFile(p, JSON.stringify({ defaults: { models: { codex: 'gpt-6-astra', 'kimi-code': 'k3' } } }))
        const cfg = loadConfig(p)
        assert.deepEqual(cfg.defaults.models, { codex: 'gpt-6-astra', 'kimi-code': 'k3' })
        await fs.writeFile(p, JSON.stringify({ defaults: { models: { codex: 5 } } }))
        assert.throws(() => loadConfig(p), /defaults\.models\.codex/)
        await fs.writeFile(p, JSON.stringify({ defaults: { models: ['codex'] } }))
        assert.throws(() => loadConfig(p), /defaults\.models/)
        await fs.writeFile(p, JSON.stringify({ defaults: { modelz: 'typo' } }))
        assert.throws(() => loadConfig(p), /unknown config key "defaults\.modelz"/)
        // reserved prototype names in dynamic maps are rejected, never silently
        // absorbed (JSON.parse yields them as own properties; written literally
        // because object literals cannot express an own "__proto__" key)
        await fs.writeFile(p, '{"defaults":{"models":{"__proto__":"x"}}}')
        assert.throws(() => loadConfig(p), /defaults\.models\.__proto__.*not allowed/)
        await fs.writeFile(p, '{"endpoints":{"overrides":{"__proto__":{"bin":"x"}}}}')
        assert.throws(() => loadConfig(p), /endpoints\.overrides\.__proto__.*not allowed/)
        await fs.writeFile(p, '{"defaults":{"models":{"constructor":{"bin":"x"}}}}')
        assert.throws(() => loadConfig(p), /not allowed/)
    } finally {
        await fs.rm(root, { recursive: true, force: true })
    }
})

test('run resolves --model ?? defaults.models[endpoint] ?? native; the global defaults.model key is gone from the schema', async () => {
    const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'paidan-models-'))
    try {
        const { work, home, env } = await mkEnv(root)
        await fs.writeFile(nodePath.join(home, 'config.json'), JSON.stringify({
            endpoints: { enabled: ['fake-sleeper'] },
            defaults: { endpoint: 'fake-sleeper', models: { 'fake-sleeper': 'per-ep-m' } },
        }))
        // per-endpoint entry applies
        const run1 = await paidan(env, ['run', '--endpoint', 'fake-sleeper', '--cwd', work, '--task', 'x'])
        assert.equal(run1.ok, true, JSON.stringify(run1))
        const req1 = JSON.parse(await fs.readFile(nodePath.join(root, 'data', 'runs', run1.run_id, 'request.json'), 'utf8'))
        assert.equal(req1.model, 'per-ep-m')
        await paidan(env, ['cancel', run1.run_id])
        await waitForWorkerExit(env.PAIDAN_DATA_DIR, run1.run_id)
        // the --model flag wins over everything
        const run2 = await paidan(env, ['run', '--endpoint', 'fake-sleeper', '--cwd', work, '--task', 'x', '--model', 'flag-m'])
        assert.equal(run2.ok, true, JSON.stringify(run2))
        const req2 = JSON.parse(await fs.readFile(nodePath.join(root, 'data', 'runs', run2.run_id, 'request.json'), 'utf8'))
        assert.equal(req2.model, 'flag-m')
        await paidan(env, ['cancel', run2.run_id])
        await waitForWorkerExit(env.PAIDAN_DATA_DIR, run2.run_id)
        // no per-endpoint entry -> native default (null), never a global fallback
        await fs.writeFile(nodePath.join(home, 'config.json'), JSON.stringify({
            endpoints: { enabled: ['fake-sleeper'] },
            defaults: { endpoint: 'fake-sleeper' },
        }))
        const run3 = await paidan(env, ['run', '--endpoint', 'fake-sleeper', '--cwd', work, '--task', 'x'])
        assert.equal(run3.ok, true, JSON.stringify(run3))
        const req3 = JSON.parse(await fs.readFile(nodePath.join(root, 'data', 'runs', run3.run_id, 'request.json'), 'utf8'))
        assert.equal(req3.model, null)
        await paidan(env, ['cancel', run3.run_id])
        await waitForWorkerExit(env.PAIDAN_DATA_DIR, run3.run_id)
        // the removed global key strips with a warning (migration), never applies
        await fs.writeFile(nodePath.join(home, 'config.json'), JSON.stringify({
            endpoints: { enabled: ['fake-sleeper'] },
            defaults: { endpoint: 'fake-sleeper', model: 'global-m' },
        }))
        const run4 = await paidan(env, ['run', '--endpoint', 'fake-sleeper', '--cwd', work, '--task', 'x'])
        assert.equal(run4.ok, true, JSON.stringify(run4))
        const req4 = JSON.parse(await fs.readFile(nodePath.join(root, 'data', 'runs', run4.run_id, 'request.json'), 'utf8'))
        assert.equal(req4.model, null)
        await paidan(env, ['cancel', run4.run_id])
        await waitForWorkerExit(env.PAIDAN_DATA_DIR, run4.run_id)
    } finally {
        await fs.rm(root, { recursive: true, force: true })
    }
})

test('loadConfig: defaults.effort / defaults.efforts parse; bad shapes are hard errors', async () => {
    const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'paidan-cfg-effort-'))
    try {
        const p = nodePath.join(root, 'config.json')
        await fs.writeFile(p, JSON.stringify({ defaults: { effort: 'high', efforts: { omp: 'max' } } }))
        // the global effort key was removed from the schema — strips with a warning (migration), value never applies
        const migrated = loadConfig(p)
        assert.equal('effort' in migrated.defaults, false)
        assert.deepEqual(migrated.defaults.efforts, { omp: 'max' })
        await fs.writeFile(p, JSON.stringify({ defaults: { efforts: { omp: 'max' } } }))
        const cfg = loadConfig(p)
        assert.deepEqual(cfg.defaults.efforts, { omp: 'max' })
        await fs.writeFile(p, JSON.stringify({ defaults: { efforts: { omp: 5 } } }))
        assert.throws(() => loadConfig(p), /defaults\.efforts\.omp/)
        await fs.writeFile(p, JSON.stringify({ defaults: { efforts: ['omp'] } }))
        assert.throws(() => loadConfig(p), /defaults\.efforts/)
        await fs.writeFile(p, '{"defaults":{"efforts":{"__proto__":"x"}}}')
        assert.throws(() => loadConfig(p), /not allowed/)
    } finally {
        await fs.rm(root, { recursive: true, force: true })
    }
})

test('run resolves --effort ?? defaults.efforts[endpoint] ?? native; bad values rejected at submit', async () => {
    const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'paidan-effort-'))
    try {
        const { work, home, env } = await mkEnv(root)
        await fs.writeFile(nodePath.join(home, 'config.json'), JSON.stringify({
            endpoints: { enabled: ['fake-sleeper'] },
            defaults: { endpoint: 'fake-sleeper', efforts: { 'fake-sleeper': 'high' } },
        }))
        // per-endpoint entry wins
        const run1 = await paidan(env, ['run', '--endpoint', 'fake-sleeper', '--cwd', work, '--task', 'x'])
        assert.equal(run1.ok, true, JSON.stringify(run1))
        const req1 = JSON.parse(await fs.readFile(nodePath.join(root, 'data', 'runs', run1.run_id, 'request.json'), 'utf8'))
        assert.equal(req1.effort, 'high')
        await paidan(env, ['cancel', run1.run_id])
        await waitForWorkerExit(env.PAIDAN_DATA_DIR, run1.run_id)
        // the flag wins over everything
        const run2 = await paidan(env, ['run', '--endpoint', 'fake-sleeper', '--cwd', work, '--task', 'x', '--effort', 'low'])
        const req2 = JSON.parse(await fs.readFile(nodePath.join(root, 'data', 'runs', run2.run_id, 'request.json'), 'utf8'))
        assert.equal(req2.effort, 'low')
        await paidan(env, ['cancel', run2.run_id])
        await waitForWorkerExit(env.PAIDAN_DATA_DIR, run2.run_id)
        // a value outside the manifest options is EFFORT_INVALID at submit
        const bad = await paidan(env, ['run', '--endpoint', 'fake-sleeper', '--cwd', work, '--task', 'x', '--effort', 'ultra'])
        assert.equal(bad.ok, false)
        assert.equal(bad.error.code, 'EFFORT_INVALID')
    } finally {
        await fs.rm(root, { recursive: true, force: true })
    }
})

test('run --effort against an endpoint without an effort block is EFFORT_UNSUPPORTED', async () => {
    const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'paidan-effort-unsup-'))
    try {
        const endpointsDir = nodePath.join(root, 'endpoints')
        const work = nodePath.join(root, 'work')
        await fs.mkdir(endpointsDir, { recursive: true })
        await fs.mkdir(work, { recursive: true })
        const fakeBin = nodePath.join(repoRoot, 'test', 'fixtures', 'fake-sleeper.cjs')
        await fs.writeFile(nodePath.join(endpointsDir, 'fake-plain.json'), JSON.stringify({
            schema_version: '1.0.0',
            name: 'fake-plain',
            detect: { bin: fakeBin },
            command: { argv: ['{bin}', '-p', '{prompt}'], prompt_delivery: 'argv' },
            permission: { presets: { 'workspace-write': 'supported' } },
            parser: 'kimi-print',
        }))
        const env = {
            ...process.env,
            PAIDAN_HOME: nodePath.join(root, 'home'),
            PAIDAN_DATA_DIR: nodePath.join(root, 'data'),
            PAIDAN_ENDPOINTS_DIR: endpointsDir,
        }
        const res = await paidan(env, ['run', '--endpoint', 'fake-plain', '--cwd', work, '--task', 'x', '--effort', 'high'])
        assert.equal(res.ok, false)
        assert.equal(res.error.code, 'EFFORT_UNSUPPORTED')
    } finally {
        await fs.rm(root, { recursive: true, force: true })
    }
})

test('run with a configured model against an endpoint without model_arg is MODEL_UNSUPPORTED', async () => {
    const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'paidan-model-unsup-'))
    try {
        const endpointsDir = nodePath.join(root, 'endpoints')
        const work = nodePath.join(root, 'work')
        const home = nodePath.join(root, 'home')
        await fs.mkdir(endpointsDir, { recursive: true })
        await fs.mkdir(work, { recursive: true })
        await fs.mkdir(home, { recursive: true })
        const fakeBin = nodePath.join(repoRoot, 'test', 'fixtures', 'fake-sleeper.cjs')
        await fs.writeFile(nodePath.join(endpointsDir, 'fake-nomodel.json'), JSON.stringify({
            schema_version: '1.0.0',
            name: 'fake-nomodel',
            detect: { bin: fakeBin },
            command: { argv: ['{bin}', '-p', '{prompt}'], prompt_delivery: 'argv' },
            permission: { presets: { 'workspace-write': 'supported' } },
            parser: 'kimi-print',
        }))
        const env = {
            ...process.env,
            PAIDAN_HOME: home,
            PAIDAN_DATA_DIR: nodePath.join(root, 'data'),
            PAIDAN_ENDPOINTS_DIR: endpointsDir,
        }
        // a per-endpoint default against an endpoint that cannot take a model headless —
        // the gate must name the repair, not leak a ManifestError flavor
        await fs.writeFile(nodePath.join(home, 'config.json'), JSON.stringify({
            endpoints: { enabled: ['fake-nomodel'] },
            defaults: { endpoint: 'fake-nomodel', models: { 'fake-nomodel': 'some-model' } },
        }))
        const res = await paidan(env, ['run', '--endpoint', 'fake-nomodel', '--cwd', work, '--task', 'x'])
        assert.equal(res.ok, false)
        assert.equal(res.error.code, 'MODEL_UNSUPPORTED')
        assert.match(res.error.message, /no headless model selection/)
        assert.match(res.error.message, /Repair:/)
        // a run with no model configured at all passes the gate
        await fs.writeFile(nodePath.join(home, 'config.json'), JSON.stringify({ endpoints: { enabled: ['fake-nomodel'] } }))
        const ok = await paidan(env, ['run', '--endpoint', 'fake-nomodel', '--cwd', work, '--task', 'x'])
        assert.equal(ok.ok, true, JSON.stringify(ok))
        await paidan(env, ['cancel', ok.run_id])
        await waitForWorkerExit(env.PAIDAN_DATA_DIR, ok.run_id)
    } finally {
        await fs.rm(root, { recursive: true, force: true })
    }
})
