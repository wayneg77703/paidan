import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { readClaudeNativeDefaults, discoverClaudeModels } from '../dist/endpoints/claude-models.js'
import { readKimiNativeDefaults } from '../dist/endpoints/kimi-models.js'
import { discoverZcodeConfiguration, discoverStoredConfiguration as discoverZcodeLive, readNativeDefaults as readZcodeDefaults } from '../dist/endpoints/zcode-print.js'
import { parseVerboseModelsOutput } from '../dist/endpoints/opencode-models.js'
import { readDshNativeDefaults } from '../dist/endpoints/dsh-models.js'
import { prepareZcodeRuntime } from '../dist/endpoints/zcode-runtime.js'
import { EndpointRegistry } from '../dist/endpoints/registry.js'
import { assertSafeSubstitutionValue, supportsEffort } from '../dist/endpoints/invocation.js'
import { waitForWorkerExit } from './helpers/worker.mjs'

const repo = fileURLToPath(new URL('..', import.meta.url))
const exec = promisify(execFile)
async function temporary(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paidan-config-contract-'))
    t.after(async () => {
        assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()))
        await fs.rm(root, { recursive: true, force: true })
    })
    return root
}

test('Claude environment defaults and alias remapping do not disclose routes or secrets', () => {
    const raw = JSON.stringify({ model: 'old-model', env: {
        ANTHROPIC_MODEL: 'gateway-model[1M]', CLAUDE_CODE_EFFORT_LEVEL: 'max',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'gateway-model[1M]', ANTHROPIC_DEFAULT_SONNET_MODEL: 'gateway-model[1M]',
        ANTHROPIC_BASE_URL: 'https://user:private-password@private-host.invalid', ANTHROPIC_AUTH_TOKEN: 'private-token',
    } })
    const native = readClaudeNativeDefaults(raw)
    assert.equal(native.model, 'gateway-model[1M]')
    assert.equal(native.effort, 'max')
    assert.equal(native.connection, 'custom-base-url')
    const catalog = discoverClaudeModels(raw)
    for (const alias of ['opus', 'sonnet']) assert.equal(catalog.models.find(m => m.alias === alias).resolved_model, 'gateway-model[1M]')
    assert.ok(!JSON.stringify({ native, catalog }).includes('private-'))
    const conflicting = readClaudeNativeDefaults(raw, { ANTHROPIC_MODEL: 'different-model' })
    assert.equal(conflicting.model, null)
    assert.ok(conflicting.notes.some(n => n.includes('Conflicting')))
    assert.equal(readClaudeNativeDefaults(null, { ANTHROPIC_MODEL: 'environment-only' }).model, 'environment-only')
})

test('Kimi home snapshot resolves real provider and inherited effort without guessing alias prefix', () => {
    const raw = 'default_model = "friendly/k3"\n[thinking]\neffort = "high"\n[models."friendly/k3"]\nprovider = "managed:login"\n[providers."managed:login"]\ntype="kimi"\n'
    const native = readKimiNativeDefaults(raw, { KIMI_MODEL_THINKING_EFFORT: 'max' })
    assert.equal(native.connection, 'managed:login')
    assert.equal(native.effort, 'max')
    assert.equal(readKimiNativeDefaults('default_model = "friendly/k3"').connection, null)
})

test('ZCode new desktop rules cannot masquerade as configured CLI models or revive legacy providers', () => {
    const cli = JSON.stringify({ provider: { login: { options: { apiKey: 'private-login' }, models: { glm: { reasoning: { variants: ['high', 'max'], defaultVariant: 'max' } } } } } })
    const legacy = JSON.stringify({ provider: { retired: { models: { old: {} } } } })
    const rules = JSON.stringify({ config: {
        providerConfigRules: { providerRules: [
            { providerId: 'api', config: { access: { type: 'api-key', apiKey: 'private-api' } } },
            { providerId: 'plan-key', config: { access: { type: 'zhipu-coding-plan-api-key' } } },
            { providerId: 'disabled', enabled: false },
        ] },
        modelConfigRules: { providerModelRules: [{ providerId: 'api', modelId: 'new' }, { providerId: 'disabled', modelId: 'hidden' }] },
    } })
    const catalog = discoverZcodeConfiguration(cli, legacy, rules)
    assert.deepEqual(catalog.models.map(m => [m.alias, m.source]), [['api/new', 'desktop-config']])
    const legacyCatalog = discoverZcodeConfiguration(cli, legacy, null)
    assert.deepEqual(legacyCatalog.models[0].effort_options, ['high', 'max'])
    assert.equal(legacyCatalog.connections[0].auth_type, 'unknown', 'a subscription can also store apiKey')
    assert.equal(catalog.connections[0].auth_type, 'api-key')
    assert.equal(catalog.connections[1].auth_type, 'api-key')
    assert.equal(catalog.connections[1].access_type, 'zhipu-coding-plan-api-key', 'Coding Plan key is not OAuth')
    assert.ok(!JSON.stringify(catalog).includes('private-'))
    assert.throws(() => discoverZcodeConfiguration(cli, legacy, '{broken'), /invalid JSON/, 'do not fall back to stale legacy sources')
})

test('OpenCode variants are model-specific, including custom names and explicit absence', async () => {
    const text = 'provider/a\n' + JSON.stringify({ variants: { low: {}, 'budget-smart': { reasoningEffort: 'low' }, disabled: { disabled: true } }, headers: { Authorization: 'private-secret' } }, null, 2)
        + '\nprovider/b\n' + JSON.stringify({ variants: {} }, null, 2) + '\n'
    const result = parseVerboseModelsOutput(text)
    assert.deepEqual(result.models[0].effort_options, ['low', 'budget-smart'])
    assert.deepEqual(result.models[1].effort_options, [])
    assert.ok(!JSON.stringify(result).includes('private-secret'))
    assert.throws(() => parseVerboseModelsOutput('provider/a\n{broken'), /incomplete/)
    assert.throws(() => parseVerboseModelsOutput('unexpected output'), /unknown preamble/)
    const manifest = (await EndpointRegistry.load(path.join(repo, 'endpoints'))).get('opencode')
    assert.equal(supportsEffort(manifest, 'budget-smart'), true)
    for (const name of ['--injected', 'two words', 'high&evil', 'high\nmax']) assert.equal(supportsEffort(manifest, name), false)
})

test('ZCode rules default never falls back to legacy or an unverified model environment variable', async (t) => {
    const root = await temporary(t)
    const keys = ['USERPROFILE', 'ZCODE_PERSONAL_PROVIDER_CONFIG_FILE', 'ZCODE_MODEL']
    const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]))
    try {
        process.env.USERPROFILE = root
        process.env.ZCODE_MODEL = 'wrong-environment-model'
        delete process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE
        const legacy = path.join(root, '.zcode', 'cli', 'config.json')
        const rules = path.join(root, '.zcode', 'v2', 'provider_config.json')
        await fs.mkdir(path.dirname(legacy), { recursive: true })
        await fs.mkdir(path.dirname(rules), { recursive: true })
        await fs.writeFile(legacy, '{"model":"old-provider/old-model"}')
        assert.equal((await readZcodeDefaults()).model, 'old-provider/old-model')
        for (const raw of ['{broken', '{}', '{"config":{"defaultModelSelection":{"modelId":"incomplete"}}}']) {
            await fs.writeFile(rules, raw)
            const result = await readZcodeDefaults()
            assert.equal(result.model, null)
            assert.equal(result.connection, null)
            assert.equal(result.credential_ready, null)
        }
        await fs.writeFile(rules, JSON.stringify({ config: { defaultModelSelection: {
            providerId: 'api', modelId: 'glm', options: { reasoningLevel: 'max', apiKey: 'private-secret' },
        } } }))
        const selected = await readZcodeDefaults()
        assert.equal(selected.model, 'api/glm')
        assert.equal(selected.connection, 'api')
        assert.equal(selected.effort, 'max')
        assert.ok(selected.notes.some(n => n.includes('may fall back')))
        assert.ok(!JSON.stringify(selected).includes('private-secret'))
        const override = path.join(root, 'explicit.json')
        await fs.writeFile(override, '{}')
        process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = override
        assert.equal((await readZcodeDefaults()).model, null)
        process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = path.join(root, 'missing.json')
        await assert.rejects(readZcodeDefaults(), /refusing to substitute/)
    } finally {
        for (const key of keys) {
            if (saved[key] === undefined) delete process.env[key]
            else process.env[key] = saved[key]
        }
    }
})

test('ZCode explicit personal rules are honored and never fall back when unreadable', async (t) => {
    const root = await temporary(t)
    const keys = ['USERPROFILE', 'ZCODE_PERSONAL_PROVIDER_CONFIG_FILE']
    const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]))
    try {
        process.env.USERPROFILE = root
        const override = path.join(root, 'personal.json')
        process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = override
        await fs.writeFile(override, JSON.stringify({ config: {
            providerConfigRules: { providerRules: [{ providerId: 'selected', config: { access: { type: 'api-key' } } }] },
            modelConfigRules: { providerModelRules: [{ providerId: 'selected', modelId: 'custom' }] },
        } }))
        const found = await discoverZcodeLive()
        assert.deepEqual(found.models.map(m => m.alias), ['selected/custom'])
        process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = path.join(root, 'missing.json')
        await assert.rejects(discoverZcodeLive(), /refusing to substitute/)
    } finally {
        for (const key of keys) {
            if (saved[key] === undefined) delete process.env[key]
            else process.env[key] = saved[key]
        }
    }
})

test('DSH exposes provider/model/effort as a file snapshot, not a selectable argv override', () => {
    const native = readDshNativeDefaults('agent-default-model:\n  provider: deepseek-official\n  model: flash\n  reasoningEffort: high\n')
    assert.equal(native.connection, 'deepseek-official')
    assert.equal(native.model, 'flash')
    assert.equal(native.effort, 'high')
    assert.equal(native.credential_ready, null)
    assert.ok(native.notes.some(n => n.includes('layers may override')))
})

test('model context suffixes pass without relaxing session or shell-safety validation', () => {
    for (const model of ['claude-model[1M]', 'claude-model[200k]']) assert.doesNotThrow(() => assertSafeSubstitutionValue(model, 'model'))
    for (const model of ['claude[anything]', 'claude[1M]&echo', 'claude[1M] --help', 'claude[1M][1M]']) assert.throws(() => assertSafeSubstitutionValue(model, 'model'))
    assert.throws(() => assertSafeSubstitutionValue('session[1M]', 'session'))
})

test('ZCode resource resolution stays with selected install and preserves explicit env, even invalid', async (t) => {
    const root = await temporary(t)
    const bin = path.join(root, 'resources', 'glm', 'zcode.cjs')
    const resource = path.join(root, 'resources', 'config', 'provider', 'zcode-builtin.json')
    await fs.mkdir(path.dirname(resource), { recursive: true })
    await fs.writeFile(resource, '{}')
    const plan = { endpoint_bin: bin }
    const base = { KEEP: 'unchanged' }
    const found = await prepareZcodeRuntime(plan, base)
    assert.equal(found.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE, resource)
    assert.equal(found.check.ready, true)
    assert.deepEqual(base, { KEEP: 'unchanged' })
    const missing = path.join(root, 'missing.json')
    const explicit = await prepareZcodeRuntime(plan, { ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: missing })
    assert.equal(explicit.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE, missing)
    assert.equal(explicit.check.ready, false)
    const empty = await prepareZcodeRuntime(plan, { ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: '' })
    assert.equal(empty.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE, '')
    assert.equal(empty.check.ready, false)
    await fs.rm(resource)
    assert.equal((await prepareZcodeRuntime(plan, {})).check.ready, false)
})

test('worker injects ZCode companion path and retains redacted startup errors in result', async (t) => {
    const root = await temporary(t)
    const bin = path.join(root, 'resources', 'glm', 'zcode.cjs')
    const resource = path.join(root, 'resources', 'config', 'provider', 'zcode-builtin.json')
    const manifests = path.join(root, 'endpoints')
    for (const dir of [path.dirname(bin), path.dirname(resource), manifests]) await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(resource, '{}')
    await fs.writeFile(bin, `const fs = require('fs'); if (!fs.existsSync(process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE || 'missing')) { console.error('Error: bundled resource missing apiKey=private-value'); process.exit(1) } console.log(JSON.stringify({sessionId:'sess_fixture',traceId:'x',turnId:'x',response:'resource-found',usage:{inputTokens:0,outputTokens:0},projection:{status:'idle',turnCount:1}}));`)
    const original = JSON.parse(await fs.readFile(path.join(repo, 'endpoints', 'zcode.json'), 'utf8'))
    original.detect = { bin }
    await fs.writeFile(path.join(manifests, 'zcode.json'), JSON.stringify(original))
    const env = { ...process.env, PAIDAN_HOME: path.join(root, 'home'), PAIDAN_DATA_DIR: path.join(root, 'data'), PAIDAN_ENDPOINTS_DIR: manifests, USERPROFILE: root }
    delete env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE
    const cli = async (...args) => JSON.parse((await exec(process.execPath, [path.join(repo, 'dist', 'cli.js'), ...args], { env, timeout: 25000 })).stdout)
    const first = await cli('run', '--endpoint', 'zcode', '--mode', 'unattended', '--cwd', root, '--task', 'fixture-one')
    const success = await cli('get', first.run_id, '--wait', '--timeout', '15')
    await waitForWorkerExit(env.PAIDAN_DATA_DIR, first.run_id)
    assert.equal(success.result.final_text, 'resource-found')
    env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = path.join(root, 'missing.json')
    const second = await cli('run', '--endpoint', 'zcode', '--mode', 'unattended', '--cwd', root, '--task', 'fixture-two')
    const failed = await cli('get', second.run_id, '--wait', '--timeout', '15')
    await waitForWorkerExit(env.PAIDAN_DATA_DIR, second.run_id)
    assert.equal(failed.run.state, 'failed')
    assert.ok(failed.result.evidence.notes.some(n => n.includes('bundled resource missing')))
    assert.ok(!JSON.stringify(failed).includes('private-value'))
})
