import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { fileURLToPath } from 'node:url'
import { parseKimiModelsJson, readKimiNativeDefaults } from '../dist/endpoints/kimi-models.js'
import { waitForWorkerExit } from './helpers/worker.mjs'

const exec = promisify(execFile)
const repo = fileURLToPath(new URL('..', import.meta.url))
const catalog = {
    providers: { login: { type: 'kimi', oauth: { key: 'private-login' } }, api: { type: 'kimi', apiKey: 'private-api' }, third: { type: 'openai', env: { OPENAI_API_KEY: 'private-env' } } },
    models: {
        'friendly/login': { provider: 'login', model: 'k3', capabilities: ['always_thinking'], supportEfforts: ['low'], overrides: { supportEfforts: ['low', 'high', 'max'], defaultEffort: 'max' } },
        'friendly/api': { provider: 'api', model: 'k3', capabilities: ['thinking'], supportEfforts: ['low', 'high'], defaultEffort: 'low' },
        'friendly/third': { provider: 'third', model: 'third-model', capabilities: ['thinking'], supportEfforts: ['low', 'high'] },
    },
}

test('Kimi metadata applies model overrides, exposes actual mapping, and distinguishes native effort from selectable effort', () => {
    const found = parseKimiModelsJson(JSON.stringify(catalog))
    assert.deepEqual(found.models[0].effort_options, ['low', 'high', 'max'])
    assert.equal(found.models[0].default_effort, 'max')
    assert.equal(found.models[0].resolved_model, 'k3')
    assert.equal(found.models[0].connection, 'login')
    assert.equal(found.models[0].thinking_required, true)
    assert.equal(found.models[0].effort_selectable, true)
    assert.equal(found.models[2].effort_selectable, false)
    assert.equal(found.connections[2].auth_type, 'api-key')
    assert.ok(!JSON.stringify(found).includes('private-'))
    const empty = structuredClone(catalog)
    empty.models['friendly/login'].overrides.supportEfforts = []
    assert.deepEqual(parseKimiModelsJson(JSON.stringify(empty)).models[0].effort_options, [])
})

test('Kimi snapshots include environment model and thinking state without claiming non-kimi forced effort worked', () => {
    const raw = `default_model='simple' # chosen\n[models.simple]\nprovider='p'\n[providers.p]\ntype='kimi'\n[thinking]\nenabled=false\neffort='low'\n`
    const normal = readKimiNativeDefaults(raw)
    assert.equal(normal.model, 'simple'); assert.equal(normal.connection, 'p')
    assert.equal(normal.thinking_enabled, false)
    const env = readKimiNativeDefaults(raw, { KIMI_MODEL_NAME: 'third-model', KIMI_MODEL_PROVIDER_TYPE: 'openai', KIMI_MODEL_THINKING_EFFORT: 'high', KIMI_MODEL_API_KEY: 'private-env' })
    assert.equal(env.model, '__kimi_env_model__'); assert.equal(env.connection, '__kimi_env__')
    assert.equal(env.effort, 'low')
    assert.ok(!JSON.stringify(env).includes('private-env'))
    assert.equal(readKimiNativeDefaults(raw, { KIMI_MODEL_THINKING_EFFORT: 'max' }).effort, 'max')
    assert.equal(readKimiNativeDefaults('description="""\ndefault_model="false"\n"""').model, null)
})

test('Kimi selection validates current aliases and effort before dispatch; native bypass preserves saved choices', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paidan-kimi-select-'))
    t.after(async () => { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); await fs.rm(root, { recursive: true, force: true }) })
    const home = path.join(root, 'home'), native = path.join(root, 'native'), endpoints = path.join(root, 'endpoints')
    await Promise.all([home, native, endpoints].map(p => fs.mkdir(p)))
    const catalogPath = path.join(native, 'catalog.json'), marker = path.join(root, 'calls.jsonl'), bin = path.join(root, 'kimi.cjs')
    await fs.writeFile(catalogPath, JSON.stringify(catalog))
    await fs.writeFile(bin, `const fs=require('node:fs');const a=process.argv.slice(2);if(a.includes('--version')){console.log('0.43.1')}else if(a[0]==='provider'){console.log(fs.readFileSync(${JSON.stringify(catalogPath)},'utf8'))}else{fs.appendFileSync(${JSON.stringify(marker)},JSON.stringify({args:a,effort:process.env.KIMI_MODEL_THINKING_EFFORT})+'\\n');console.log(JSON.stringify({role:'assistant',content:'OK'}));}`)
    await fs.copyFile(path.join(repo, 'endpoints/kimi-code.json'), path.join(endpoints, 'kimi-code.json'))
    const configFile = path.join(home, 'config.json'), nativeFile = path.join(native, 'config.toml')
    const config = { endpoints: { enabled: ['kimi-code'], overrides: { 'kimi-code': { bin } } } }
    await fs.writeFile(configFile, JSON.stringify(config))
    const nativeText = alias => `default_model="${alias}"\n[thinking]\nenabled=true\neffort="low"\n[models."${alias}"]\nprovider="${catalog.models[alias].provider}"\n`
    await fs.writeFile(nativeFile, nativeText('friendly/login'))
    const env = { ...process.env, PAIDAN_HOME: home, PAIDAN_DATA_DIR: path.join(root, 'data'), PAIDAN_ENDPOINTS_DIR: endpoints, KIMI_CODE_HOME: native }
    for (const key of Object.keys(env)) if (key.startsWith('KIMI_MODEL_')) delete env[key]
    const cli = async (...args) => {
        try { return JSON.parse((await exec(process.execPath, [path.join(repo, 'dist/cli.js'), ...args], { env, timeout: 30_000 })).stdout) }
        catch (e) { if (e.stdout) return JSON.parse(e.stdout); throw e }
    }
    const run = (...args) => cli('run', '--endpoint', 'kimi-code', '--cwd', root, '--task', 'test selection', ...args)
    const finish = async start => {
        assert.equal(start.ok, true, JSON.stringify(start))
        const end = await cli('get', start.run_id, '--wait', '--timeout', '20')
        assert.equal(end.run.state, 'completed', JSON.stringify(end))
        await waitForWorkerExit(env.PAIDAN_DATA_DIR, start.run_id)
    }
    for (const [alias, effort] of [['friendly/login', 'max'], ['friendly/api', 'high']]) await finish(await run('--model', alias, '--effort', effort))
    const callsBefore = await fs.readFile(marker, 'utf8')
    assert.equal((await run('--model', 'missing')).error.code, 'MODEL_UNAVAILABLE')
    assert.equal((await run('--model', 'friendly/api', '--effort', 'max')).error.code, 'EFFORT_INVALID')
    assert.equal((await run('--model', 'friendly/login', '--effort', 'medium')).error.code, 'EFFORT_INVALID')
    assert.equal((await run('--model', 'friendly/third', '--effort', 'high')).error.code, 'EFFORT_UNSUPPORTED')
    await fs.writeFile(nativeFile, nativeText('friendly/api').replace('enabled=true', 'enabled=false'))
    assert.equal((await run('--model', 'friendly/api', '--effort', 'high')).error.code, 'EFFORT_UNSUPPORTED')
    assert.equal(await fs.readFile(marker, 'utf8'), callsBefore, 'invalid selections never start the task')
    await fs.writeFile(nativeFile, nativeText('friendly/third'))
    config.defaults = { models: { 'kimi-code': 'removed-alias' }, efforts: { 'kimi-code': 'max' } }
    await fs.writeFile(configFile, JSON.stringify(config))
    const saved = await fs.readFile(configFile, 'utf8'), nativeSaved = await fs.readFile(nativeFile, 'utf8')
    const menu = await cli('models', '--endpoint', 'kimi-code')
    assert.equal(menu.native_defaults.connection, 'third')
    assert.equal(menu.native_defaults.auth_type, 'api-key')
    assert.equal((await run()).error.code, 'MODEL_UNAVAILABLE')
    await finish(await run('--native'))
    const last = JSON.parse((await fs.readFile(marker, 'utf8')).trim().split('\n').at(-1))
    assert.ok(!last.args.includes('-m')); assert.equal(last.effort, undefined)
    assert.equal(await fs.readFile(configFile, 'utf8'), saved)
    assert.equal(await fs.readFile(nativeFile, 'utf8'), nativeSaved)
})
