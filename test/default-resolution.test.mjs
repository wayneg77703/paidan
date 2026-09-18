// Submit-time selection precedence and rejection gates, through the real CLI.
// Fast local endpoints finish normally; cancellation is covered by lifecycle tests.
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
const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url))

async function fixture(t) {
    const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'paidan-defaults-'))
    t.after(async () => {
        assert.equal(nodePath.dirname(nodePath.resolve(root)), nodePath.resolve(os.tmpdir()))
        await fs.rm(root, { recursive: true, force: true })
    })
    const home = nodePath.join(root, 'home'), endpoints = nodePath.join(root, 'endpoints')
    const native = nodePath.join(root, 'native'), data = nodePath.join(root, 'data')
    await Promise.all([home, endpoints, native].map(dir => fs.mkdir(dir)))
    const bin = nodePath.join(root, 'quick.cjs')
    await fs.writeFile(bin, 'console.log(JSON.stringify({type:"result",subtype:"success",result:JSON.stringify(process.argv.slice(2)),session_id:"fixture"}))')
    const manifest = {
        schema_version: '1.0.0', name: 'fake', detect: { bin },
        command: { argv: ['{bin}', '{prompt}'], prompt_delivery: 'argv', model_arg: ['--model', '{model}'] },
        effort: { options: ['low', 'high'], arg: ['--thinking', '{effort}'] },
        permission: { 'fs.read': { status: 'supported' }, 'fs.write': { status: 'supported' }, presets: { 'workspace-write': 'supported' } },
        parser: 'claude-stream-json',
    }
    const writeManifest = () => fs.writeFile(nodePath.join(endpoints, 'fake.json'), JSON.stringify(manifest))
    await writeManifest()
    const writeConfig = defaults => fs.writeFile(nodePath.join(home, 'config.json'), JSON.stringify({
        endpoints: { enabled: ['fake'] }, defaults: { endpoint: 'fake', ...defaults },
    }))
    const env = { ...process.env, PAIDAN_HOME: home, PAIDAN_DATA_DIR: data, PAIDAN_ENDPOINTS_DIR: endpoints,
        PAIDAN_HOST_HOME: native, CLAUDE_CONFIG_DIR: native }
    const cli = async args => {
        try { return JSON.parse((await execFileAsync(process.execPath, [CLI, ...args], { env, timeout: 30_000 })).stdout) }
        catch (error) { if (error.stdout) return JSON.parse(error.stdout); throw error }
    }
    const submit = (label, flags = []) => cli(['run', '--cwd', root, '--task', label, ...flags])
    const complete = async (label, flags = []) => {
        const run = await submit(label, flags)
        assert.equal(run.ok, true, JSON.stringify(run))
        const got = await cli(['get', run.run_id, '--wait', '--timeout', '20'])
        assert.equal(got.terminal, true, JSON.stringify(got))
        await waitForWorkerExit(data, run.run_id)
        assert.equal(got.run.state, 'completed')
        return { request: JSON.parse(await fs.readFile(nodePath.join(data, 'runs', run.run_id, 'request.json'), 'utf8')),
            argv: JSON.parse(got.result.final_text) }
    }
    return { manifest, writeManifest, writeConfig, submit, complete, data }
}

test('loadConfig: defaults.models parses; non-string entries and typos are hard errors', async () => {
    const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'paidan-cfg-'))
    try {
        const p = nodePath.join(root, 'config.json')
        await fs.writeFile(p, JSON.stringify({ defaults: { models: { codex: 'gpt-6-astra', 'kimi-code': 'k3' } } }))
        const cfg = loadConfig(p)
        assert.deepEqual(cfg.defaults.models, { codex: 'gpt-6-astra', 'kimi-code': 'k3' })
        await fs.writeFile(p, JSON.stringify({ defaults: { model: 'legacy-global-model' } }))
        assert.equal('model' in loadConfig(p).defaults, false, 'legacy global model is ignored')
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

test('model and effort flags override saved defaults; native selection omits both arguments', async t => {
    const f = await fixture(t)
    await f.writeConfig({ models: { fake: 'saved-model' }, efforts: { fake: 'high' } })
    for (const [label, flags, model, effort] of [
        ['saved', [], 'saved-model', 'high'],
        ['flags', ['--model', 'flag-model', '--effort', 'low'], 'flag-model', 'low'],
        ['model-only', ['--model', 'flag-model'], 'flag-model', 'high'],
        ['effort-only', ['--effort', 'low'], 'saved-model', 'low'],
        ['native', ['--native'], null, null],
        ['unset', [], null, null],
    ]) {
        if (label === 'unset') await f.writeConfig({})
        const { request, argv } = await f.complete(label, flags)
        assert.equal(request.model, model, label)
        assert.equal(request.effort, effort, label)
        assert.deepEqual(argv, [...(model ? ['--model', model] : []), ...(effort ? ['--thinking', effort] : []), label], label)
    }
})

test('unsupported or invalid selections fail before creating a run; native selection still works', async t => {
    const f = await fixture(t)
    await f.writeConfig({})
    assert.equal((await f.submit('invalid', ['--effort', 'ultra'])).error.code, 'EFFORT_INVALID')
    delete f.manifest.effort
    delete f.manifest.command.model_arg
    await f.writeManifest()
    assert.equal((await f.submit('no-effort', ['--effort', 'high'])).error.code, 'EFFORT_UNSUPPORTED')
    await f.writeConfig({ models: { fake: 'saved-model' } })
    const blocked = await f.submit('no-model')
    assert.equal(blocked.error.code, 'MODEL_UNSUPPORTED')
    assert.match(blocked.error.message, /no headless model selection/)
    assert.match(blocked.error.message, /Repair:/)
    const runs = await fs.readdir(nodePath.join(f.data, 'runs')).catch(error => {
        if (error.code === 'ENOENT') return []
        throw error
    })
    assert.deepEqual(runs.filter(name => name.startsWith('run_')), [])
    await f.writeConfig({})
    const { request, argv } = await f.complete('allowed-native')
    assert.equal(request.model, null)
    assert.equal(request.effort, null)
    assert.deepEqual(argv, ['allowed-native'])
})
