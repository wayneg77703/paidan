// Per-endpoint default models (defaults.models.<endpoint>): config schema
// validation and run-time resolution order (--model ?? defaults.models[ep]
// ?? defaults.model). Fully isolated via PAIDAN_HOME/PAIDAN_DATA_DIR/
// PAIDAN_ENDPOINTS_DIR pointing at tmp dirs.

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { test } from 'node:test'
import { loadConfig } from '../dist/engine/config.js'

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
        command: { argv: ['{bin}', '-p', '{prompt}'], prompt_delivery: 'argv', model_arg: ['--model', '{model}'] },
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

test('run resolves --model ?? defaults.models[endpoint] ?? defaults.model', async () => {
    const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'paidan-models-'))
    try {
        const { work, home, env } = await mkEnv(root)
        await fs.writeFile(nodePath.join(home, 'config.json'), JSON.stringify({
            endpoints: { enabled: ['fake-sleeper'] },
            defaults: { endpoint: 'fake-sleeper', model: 'global-m', models: { 'fake-sleeper': 'per-ep-m' } },
        }))
        // per-endpoint entry wins over the global default
        const run1 = await paidan(env, ['run', '--endpoint', 'fake-sleeper', '--cwd', work, '--task', 'x'])
        assert.equal(run1.ok, true, JSON.stringify(run1))
        const req1 = JSON.parse(await fs.readFile(nodePath.join(root, 'data', 'runs', run1.run_id, 'request.json'), 'utf8'))
        assert.equal(req1.model, 'per-ep-m')
        await paidan(env, ['cancel', run1.run_id])
        // the --model flag wins over everything
        const run2 = await paidan(env, ['run', '--endpoint', 'fake-sleeper', '--cwd', work, '--task', 'x', '--model', 'flag-m'])
        assert.equal(run2.ok, true, JSON.stringify(run2))
        const req2 = JSON.parse(await fs.readFile(nodePath.join(root, 'data', 'runs', run2.run_id, 'request.json'), 'utf8'))
        assert.equal(req2.model, 'flag-m')
        await paidan(env, ['cancel', run2.run_id])
        // without a per-endpoint entry the global default still applies
        await fs.writeFile(nodePath.join(home, 'config.json'), JSON.stringify({
            endpoints: { enabled: ['fake-sleeper'] },
            defaults: { endpoint: 'fake-sleeper', model: 'global-m' },
        }))
        const run3 = await paidan(env, ['run', '--endpoint', 'fake-sleeper', '--cwd', work, '--task', 'x'])
        assert.equal(run3.ok, true, JSON.stringify(run3))
        const req3 = JSON.parse(await fs.readFile(nodePath.join(root, 'data', 'runs', run3.run_id, 'request.json'), 'utf8'))
        assert.equal(req3.model, 'global-m')
        await paidan(env, ['cancel', run3.run_id])
    } finally {
        await fs.rm(root, { recursive: true, force: true })
    }
})
