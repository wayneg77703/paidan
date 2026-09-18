// Connection switches are native configuration changes, not paidan fallbacks.
// Queries must reflect the current source without changing pinned choices.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { test } from 'node:test'

const exec = promisify(execFile)
const repo = fileURLToPath(new URL('..', import.meta.url))

async function setup(root, endpoint, parser, modelSource) {
    const home = path.join(root, 'home')
    const native = path.join(root, 'native')
    const endpoints = path.join(root, 'endpoints')
    await Promise.all([home, native, endpoints].map((dir) => fs.mkdir(dir)))
    const bin = path.join(root, 'entry.cjs')
    await fs.writeFile(bin, 'console.log("1.0.0")')
    await fs.writeFile(path.join(endpoints, `${endpoint}.json`), JSON.stringify({
        schema_version: '1.0.0', name: endpoint,
        detect: { bin, version_args: ['--version'] },
        command: { argv: ['{bin}', '{prompt}'], prompt_delivery: 'argv', model_arg: ['--model', '{model}'] },
        permission: { presets: { 'workspace-write': 'supported' } },
        models: { command: null, parse: modelSource }, parser,
    }))
    const configFile = path.join(home, 'config.json')
    await fs.writeFile(configFile, JSON.stringify({
        endpoints: { enabled: [endpoint], overrides: { [endpoint]: { bin } } },
        defaults: { endpoint, models: { [endpoint]: 'user-pinned-model' } },
    }))
    const env = {
        ...process.env, PAIDAN_HOME: home, PAIDAN_DATA_DIR: path.join(root, 'data'),
        PAIDAN_ENDPOINTS_DIR: endpoints, PAIDAN_HOST_HOME: native,
        CODEX_HOME: native, USERPROFILE: native, HOME: native,
    }
    const cli = async (...args) => {
        try {
            return JSON.parse((await exec(process.execPath, [path.join(repo, 'dist', 'cli.js'), ...args],
                { env, timeout: 15_000 })).stdout)
        } catch (err) {
            if (err.stdout) return JSON.parse(err.stdout)
            throw err
        }
    }
    return { native, bin, configFile, cli, cache: path.join(root, 'data', 'models-cache', `${endpoint}.json`) }
}

async function cleanup(root) {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()))
    await fs.rm(root, { recursive: true, force: true })
}

test('Codex connection changes replace candidates without --refresh or altering fixed choices', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paidan-current-models-'))
    try {
        const { native, configFile, cli, cache } = await setup(root, 'codex', 'codex-exec', 'codex-native-config')
        const saved = await fs.readFile(configFile, 'utf8')
        const nativeConfig = path.join(native, 'config.toml')
        // A leftover login file must not mislabel a different configured provider.
        await fs.writeFile(path.join(native, 'auth.json'), '{"token":"fixture-secret-never-expose"}')
        await fs.writeFile(nativeConfig, 'model="model-a"\nmodel_provider="provider-a"\nmodel_reasoning_effort="high"\n')
        const a = await cli('models', '--endpoint', 'codex')
        assert.equal(a.ok, true)
        assert.equal(a.from_cache, false)
        assert.deepEqual(a.models, [{ alias: 'model-a', connection: 'provider-a', source: 'native-config' }])
        await fs.writeFile(nativeConfig, 'model="model-b"\nmodel_provider="provider-b"\nmodel_reasoning_effort="low"\n')
        const b = await cli('models', '--endpoint', 'codex')
        assert.equal(b.ok, true)
        assert.equal(b.from_cache, false)
        assert.deepEqual(b.models, [{ alias: 'model-b', connection: 'provider-b', source: 'native-config' }])
        assert.ok(!JSON.stringify(b).includes('fixture-secret-never-expose'))
        assert.ok(!JSON.stringify(b.models).includes('chatgpt-login'))
        const doctor = await cli('doctor')
        assert.equal(doctor.endpoints[0].native_defaults.connection, 'provider-b')
        assert.equal(doctor.endpoints[0].native_defaults.effort, 'low')
        assert.equal(doctor.endpoints[0].configured_defaults.model, 'user-pinned-model')
        assert.equal(await fs.readFile(configFile, 'utf8'), saved)
        await fs.writeFile(nativeConfig, 'profile="alternate"\nmodel="base-model"\n')
        const unknown = await cli('models', '--endpoint', 'codex', '--refresh')
        assert.deepEqual(unknown.models, [])
        assert.deepEqual(JSON.parse(await fs.readFile(cache, 'utf8')).models, [])
    } finally { await cleanup(root) }
})

for (const [endpoint, parser, catalog, emptyCatalog] of [
    ['opencode', 'opencode-run', 'old-provider/old-model\n{}', ''],
    ['omp', 'omp-print', JSON.stringify({ models: [{ selector: 'old-provider/old-model', provider: 'old-provider' }] }), '{"models":[]}'],
    ['agy', 'agy-print', 'old-provider/old-model\tOld model', ''],
]) test(`${endpoint}: failed discovery never returns the previous cache; an empty success clears it`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paidan-model-failure-'))
    try {
        const { bin, cli, cache, configFile } = await setup(root, endpoint, parser, `${endpoint}-models-command`)
        const saved = await fs.readFile(configFile, 'utf8')
        const writeCatalog = body => fs.writeFile(bin, `
            const args = process.argv.slice(2);
            if(args.includes('--version')) console.log('1.0.0');
            else if(args[0] === 'debug' && args[1] === 'paths') console.log('data ' + ${JSON.stringify(root)});
            else if(args[0] === 'config' && args[1] === 'path') console.log(${JSON.stringify(root)});
            else if(args[0] === 'debug' || args[0] === 'config') console.log('{}');
            else console.log(${JSON.stringify(body)});
        `)
        await writeCatalog(catalog)
        const first = await cli('models', '--endpoint', endpoint)
        assert.equal(first.ok, true)
        assert.equal(first.models[0].alias, 'old-provider/old-model')
        const snapshot = await fs.readFile(cache, 'utf8')
        await fs.writeFile(bin, 'if(process.argv.includes("--version")) console.log("1.0.0"); else {console.error("fixture: current connection is not logged in");process.exit(1)}')
        for (const extra of [[], ['--refresh']]) {
            const failure = await cli('models', '--endpoint', endpoint, ...extra)
            assert.equal(failure.ok, false)
            assert.equal(failure.error.code, 'MODELS_QUERY_FAILED')
            assert.equal(failure.models, undefined)
            assert.equal(failure.from_cache, undefined)
        }
        assert.equal(await fs.readFile(cache, 'utf8'), snapshot, 'historical snapshot is kept, not reused or destroyed')
        await writeCatalog(emptyCatalog)
        const empty = await cli('models', '--endpoint', endpoint)
        assert.equal(empty.ok, true)
        assert.deepEqual(empty.models, [])
        assert.deepEqual(JSON.parse(await fs.readFile(cache, 'utf8')).models, [])
        assert.equal(await fs.readFile(configFile, 'utf8'), saved, 'discovery never changes the saved choice')
    } finally { await cleanup(root) }
})
