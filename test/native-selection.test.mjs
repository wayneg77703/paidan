import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { opencodeSnapshot } from '../dist/endpoints/opencode-models.js'
import { ompSnapshot } from '../dist/endpoints/omp-models.js'
import { discoverDshModels } from '../dist/endpoints/dsh-models.js'
import { RunStore } from '../dist/engine/run-store.js'
import { waitForWorkerExit } from './helpers/worker.mjs'

const exec = promisify(execFile), repo = fileURLToPath(new URL('..', import.meta.url))

test('native metadata binds routes, omits credentials, and does not pretend a provider is an account', () => {
    const config = { model: 'route/model', provider: { route: { options: { baseURL: 'https://private.invalid/v1', apiKey: 'fixture-secret' } } } }
    const a = opencodeSnapshot(config, { route: { type: 'api', key: 'fixture-secret' } }, 'entry')
    config.provider.route.options.apiKey = 'rotated-secret'
    assert.equal(opencodeSnapshot(config, { route: { type: 'api', key: 'rotated-secret' } }, 'entry').native.selection_context, a.native.selection_context)
    config.provider.route.options.baseURL = 'https://different.invalid/v1'
    assert.notEqual(opencodeSnapshot(config, { route: { type: 'api' } }, 'entry').native.selection_context, a.native.selection_context)
    assert.ok(!JSON.stringify(a).includes('private.invalid'))
    assert.ok(!JSON.stringify(a).includes('secret'))
    const omp = ompSnapshot({ modelRoles: { value: { default: 'route/model', smol: 'other/small' } } }, [
        { provider: 'route', credential_type: 'oauth', disabled: 0 },
        { provider: 'route', credential_type: 'api_key', disabled: 0 },
    ], 'profile')
    assert.equal(omp.native.model, 'route/model')
    assert.equal(omp.connections[0].auth_type, 'unknown', 'multiple native account types cannot be labelled as one OAuth route')
    assert.equal(ompSnapshot({ modelRoles: { value: { default: 'fuzzy-name' } } }, [], 'profile').native.model, null)
})

test('DSH lists configured routes without exposing credentials or inventing headless overrides', () => {
    const found = discoverDshModels('agent-default-model:\n  provider: gateway\n  model: model-a\n  reasoningEffort: high\nllm-pi-ai:\n  providers:\n    gateway:\n      apiKeyEnv: TEST_KEY\n      apiKey: fixture-secret\n      models:\n        - id: model-a\n        - id: model-b\n')
    assert.deepEqual(found.models.map(m => m.alias), ['gateway/model-a', 'gateway/model-b'])
    assert.ok(found.models.every(m => m.effort_selectable === false))
    assert.equal(found.connections[0].auth_type, 'api-key')
    assert.equal(found.native_defaults.profile, 'headless')
    assert.ok(!JSON.stringify(found).includes('fixture-secret'))
})

for (const endpoint of ['opencode', 'omp', 'agy']) test(`${endpoint}: fixed selection, changed configuration, native bypass and failure recovery preserve user choices`, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paidan-native-selection-'))
    t.after(async () => { assert.equal(path.dirname(root), os.tmpdir()); await fs.rm(root, { recursive: true, force: true }) })
    const native = path.join(root, 'native'), home = path.join(root, 'home'), manifests = path.join(root, 'endpoints'), data = path.join(root, 'data')
    await Promise.all([native, home, manifests].map(dir => fs.mkdir(dir)))
    const agySettings = path.join(native, '.gemini', 'antigravity-cli', 'settings.json')
    await fs.mkdir(path.dirname(agySettings), { recursive: true })
    await fs.writeFile(agySettings, '{"model":"route/model"}')
    const manifest = JSON.parse(await fs.readFile(path.join(repo, 'endpoints', endpoint + '.json'), 'utf8'))
    await fs.writeFile(path.join(manifests, endpoint + '.json'), JSON.stringify(manifest))
    const bin = path.join(repo, 'test', 'fixtures', 'fake-native-selection.cjs')
    const state = { endpoint, models: ['route/model'], config: endpoint === 'omp'
        ? { modelRoles: { value: { default: 'route/model' } }, defaultThinkingLevel: { value: 'high' } }
        : { model: 'route/model', provider: { route: { options: { baseURL: 'https://first.invalid/v1' } } } } }
    const saveState = () => fs.writeFile(path.join(native, 'state.json'), JSON.stringify(state))
    await saveState()
    const config = { endpoints: { enabled: [endpoint], overrides: { [endpoint]: { bin } } }, defaults: { endpoint, models: {}, efforts: {}, selection_contexts: {} } }
    const configFile = path.join(home, 'config.json')
    await fs.writeFile(configFile, JSON.stringify(config))
    const env = { ...process.env, PAIDAN_HOME: home, PAIDAN_DATA_DIR: data, PAIDAN_ENDPOINTS_DIR: manifests, PAIDAN_HOST_HOME: native }
    const cli = async (...args) => {
        try { return JSON.parse((await exec(process.execPath, [path.join(repo, 'dist/cli.js'), ...args], { env, timeout: 30000 })).stdout) }
        catch (e) { if (e.stdout) return JSON.parse(e.stdout); throw e }
    }
    let serial = 0
    const run = (...flags) => cli('run', '--cwd', root, '--task', 'selection fixture ' + serial++, ...flags)
    const finish = async (...flags) => {
        const r = await run(...flags)
        assert.equal(r.ok, true, JSON.stringify(r))
        const got = await cli('get', r.run_id, '--wait', '--timeout', '20')
        await waitForWorkerExit(data, r.run_id)
        return got
    }
    const menu = await cli('models', '--endpoint', endpoint, '--cwd', root)
    assert.equal(menu.ok, true, JSON.stringify(menu))
    config.defaults.models[endpoint] = 'route/model'
    if (endpoint !== 'agy') config.defaults.efforts[endpoint] = 'high'
    await fs.writeFile(configFile, JSON.stringify(config))
    assert.equal((await run()).error.code, 'SELECTION_RECONFIRM_REQUIRED', 'old unbound defaults need user confirmation')
    config.defaults.selection_contexts[endpoint] = menu.selection_context
    await fs.writeFile(configFile, JSON.stringify(config))
    const saved = await fs.readFile(configFile, 'utf8')
    assert.equal((await finish()).run.state, 'completed')
    const before = await fs.readFile(path.join(native, 'calls.jsonl'), 'utf8')
    if (endpoint === 'agy') await fs.writeFile(agySettings, '{"model":"new-native-model"}')
    else if (endpoint === 'omp') state.config.defaultThinkingLevel.value = 'low'
    else state.config.provider.route.options.baseURL = 'https://changed.invalid/v1'
    await saveState()
    assert.equal((await run()).error.code, 'SELECTION_RECONFIRM_REQUIRED')
    assert.equal(await fs.readFile(path.join(native, 'calls.jsonl'), 'utf8'), before, 'reconfirmation happens before dispatch')
    const current = await cli('models', '--endpoint', endpoint, '--cwd', root)
    assert.notEqual(current.selection_context, menu.selection_context)
    if (endpoint !== 'agy') assert.equal((await run('--effort', 'max')).error.code, 'EFFORT_INVALID', 'global effort syntax is not per-model support')
    assert.equal((await finish('--native')).run.state, 'completed')
    state.fail = true
    await saveState()
    const failed = await finish('--selection-context', current.selection_context)
    assert.equal(failed.run.state, 'failed')
    assert.equal(failed.recovery.requested.model, 'route/model')
    assert.equal(failed.recovery.cwd, root)
    assert.equal(await fs.readFile(configFile, 'utf8'), saved)
    state.fail = false
    state.models = []
    await saveState()
    assert.equal((await run('--selection-context', current.selection_context)).error.code, 'MODEL_UNAVAILABLE')

    // Configuration can change between submission and worker launch too.
    const store = new RunStore(data)
    const draft = await store.create({ endpoint, cwd: root, task_text: 'submission race', task_file: null,
        add_dirs: [], mode: 'workspace-write', model: 'route/model', effort: null, resume_session: null,
        selection_context: menu.selection_context, run_timeout_sec: 15, deliverables: [], warnings: [] })
    await exec(process.execPath, [path.join(repo, 'dist/worker.js'), draft.request.run_id], { env, timeout: 20000 }).catch(e => { if (!Number.isInteger(e.code)) throw e })
    assert.equal((await store.readResult(draft.request.run_id)).evidence.notes.some(n => n.includes('SELECTION_RECONFIRM_REQUIRED')), true)
})
