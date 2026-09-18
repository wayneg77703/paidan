import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../dist/engine/config.js'
import { discoverZcodeApiCandidates } from '../dist/endpoints/zcode-models.js'
import { prepareZcodeRuntime } from '../dist/endpoints/zcode-runtime.js'
import { readExecutionSelection } from '../dist/endpoints/zcode-ledger.js'
import { waitForWorkerExit } from './helpers/worker.mjs'

const repo = fileURLToPath(new URL('..', import.meta.url))
const rules = (provider = 'api', model = 'glm', effort = 'max') => ({ schemaVersion: 1, config: {
    providerConfigRules: { providerRules: [{ providerId: provider, providerName: `Name ${provider}`, templateId: 'fixture', config: { access: { type: 'api-key', apiKey: 'fixture-secret-never-emit' } } }] },
    modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
    defaultModelSelection: { providerId: provider, modelId: model, options: { reasoningLevel: effort } },
} })
async function temporary(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paidan-zcode-profile-'))
    t.after(async () => {
        assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()))
        await fs.rm(root, { recursive: true, force: true })
    })
    return root
}

test('dedicated provider path is ZCode-only and must be absolute', async t => {
    const root = await temporary(t), file = path.join(root, 'config.json')
    await fs.writeFile(file, JSON.stringify({ endpoints: { overrides: { zcode: { provider_config: path.join(root, 'native.json') } } } }))
    assert.equal(loadConfig(file).endpoints.overrides.zcode.bin, null)
    for (const overrides of [{ zcode: { provider_config: 'relative.json' } }, { codex: { provider_config: path.join(root, 'native.json') } }]) {
        await fs.writeFile(file, JSON.stringify({ endpoints: { overrides } }))
        assert.throws(() => loadConfig(file), /provider_config/)
    }
})

test('profile applies only to child env and an invalid explicit profile never falls back', async t => {
    const root = await temporary(t), file = path.join(root, 'native.json')
    await fs.writeFile(file, JSON.stringify(rules()))
    const env = { USERPROFILE: root, ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: path.join(root, 'other.json') }
    const plan = { endpoint_bin: null }
    const r = await prepareZcodeRuntime(plan, env, root, file)
    assert.equal(r.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE, file)
    assert.equal(env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE, path.join(root, 'other.json'))
    assert.deepEqual(r.expected, { provider: 'api', provider_name: 'Name api', model: 'glm', effort: 'max' })
    assert.ok(!JSON.stringify(r).includes('fixture-secret'))
    await assert.rejects(prepareZcodeRuntime(plan, env, root, path.join(root, 'missing.json')), /未切换/)
    const disabled = rules(); disabled.config.providerConfigRules.providerRules[0].enabled = false
    await fs.writeFile(file, JSON.stringify(disabled))
    await assert.rejects(prepareZcodeRuntime(plan, env, root, file), /一个启用 provider/)
    const emptyEffort = rules('api', 'glm', '')
    await fs.writeFile(file, JSON.stringify(emptyEffort))
    await assert.rejects(prepareZcodeRuntime(plan, env, root, file), /缺少完整/)
    await fs.writeFile(file, '{"apiKey":"fixture-secret-never-emit",')
    await assert.rejects(prepareZcodeRuntime(plan, env, root, file), e => !e.message.includes('fixture-secret') && /JSON/.test(e.message))
    const native = await prepareZcodeRuntime(plan, env, root, null)
    assert.equal(native.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE, undefined)
})

test('API discovery inherits template models, resolves effort metadata and filters disabled providers/models', () => {
    const personal = rules()
    personal.config.providerConfigRules.providerRules.push({ ...rules('disabled').config.providerConfigRules.providerRules[0], enabled: false })
    personal.config.modelConfigRules.providerModelRules.push({ providerId: 'api', modelId: 'hidden', config: { enabled: false } })
    const builtin = { config: {
        providerConfigRules: { templateRules: [{ templateId: 'fixture', config: { access: { type: 'api-key' }, api: { type: 'anthropic-messages' }, builtinModelIds: ['GLM', 'hidden'] } }] },
        modelConfigRules: { modelRules: [{ modelMatch: '.*', config: { enabled: true, optionSpecs: { reasoningLevel: { values: ['enabled'] } } } },
            { modelMatch: 'glm', config: { optionSpecs: { reasoningLevel: { values: ['low', 'max'] } } } }] },
    } }
    const result = discoverZcodeApiCandidates(personal, builtin)
    assert.deepEqual(result.models.map(m => m.alias), ['api/GLM'])
    assert.deepEqual(result.models[0].effort_options, ['low', 'max'])
    assert.equal(result.connections[0].label, 'Name api')
    assert.ok(!JSON.stringify(result).includes('fixture-secret'))
    personal.config.modelConfigRules.manualProviderModelRules.push({ providerId: 'api', modelMatch: '.*', config: {} })
    assert.equal(discoverZcodeApiCandidates(personal, builtin).models[0].effort_options, null)
})

test('native ledger evidence belongs to exactly this session/trace/turn, never earlier or concurrent turns', async t => {
    const root = await temporary(t), dbPath = path.join(root, '.zcode', 'cli', 'db', 'db.sqlite')
    await fs.mkdir(path.dirname(dbPath), { recursive: true })
    const db = new DatabaseSync(dbPath)
    db.exec('CREATE TABLE model_usage (id TEXT, session_id TEXT, trace_id TEXT, turn_id TEXT, provider_id TEXT, model_id TEXT, variant TEXT, started_at INTEGER)')
    const insert = db.prepare('INSERT INTO model_usage VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    insert.run('old', 'sess', 'old-trace', 'old-turn', 'old', 'old', 'low', 0)
    insert.run('other', 'other-session', 'trace', 'turn', 'other', 'other', 'low', 1)
    insert.run('current', 'sess', 'trace', 'turn', 'api', 'glm', 'max', 2)
    db.close()
    const parsed = { sessionId: 'sess', traceId: 'trace', turnId: 'turn', degraded: false }
    const opts = { env: { USERPROFILE: root }, expected: { provider: 'api', model: 'glm', effort: 'max' } }
    const result = await readExecutionSelection(parsed, opts)
    assert.deepEqual(result.actual, [{ provider: 'api', model: 'glm', effort: 'max' }])
    assert.equal(result.matches_expected, true)
    assert.equal((await readExecutionSelection(parsed, { ...opts, expected: { ...opts.expected, effort: 'low' } })).matches_expected, false)
    assert.equal((await readExecutionSelection({ ...parsed, turnId: 'missing' }, opts)).source, 'unavailable')
    assert.equal((await readExecutionSelection({ ...parsed, turnId: null }, opts)).actual.length, 0)
})

test('worker stays on print, reports native selection, refuses missing profiles, and follows native only explicitly', async t => {
    const root = await temporary(t), nativeDir = path.join(root, '.zcode', 'v2'), manifests = path.join(root, 'endpoints')
    const home = path.join(root, 'home'), profile = path.join(root, '.zcode', 'dedicated.json'), bin = path.join(root, 'zcode.cjs')
    for (const dir of [nativeDir, manifests, home]) await fs.mkdir(dir, { recursive: true })
    const globalFile = path.join(nativeDir, 'provider_config.json')
    const globalRaw = JSON.stringify(rules('original', 'native-model', 'low'))
    const dedicatedRaw = JSON.stringify(rules())
    await fs.writeFile(globalFile, globalRaw); await fs.writeFile(profile, dedicatedRaw)
    await fs.writeFile(bin, `
const fs=require('fs'),path=require('path'),crypto=require('crypto'),{DatabaseSync}=require('node:sqlite');
if(process.argv.includes('app-server')||!process.argv.includes('-p'))throw Error('not print');
fs.appendFileSync(path.join(process.env.USERPROFILE,'launches'),'print\\n');
const file=process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE||path.join(process.env.USERPROFILE,'.zcode/v2/provider_config.json');
const wanted=JSON.parse(fs.readFileSync(file,'utf8')).config.defaultModelSelection;
const selected=process.env.FIXTURE_MISMATCH?{providerId:'fallback',modelId:'different',options:{reasoningLevel:'low'}}:wanted;
const sid=process.argv.includes('--resume')?process.argv[process.argv.indexOf('--resume')+1]:'sess_'+crypto.randomUUID();
const trace=crypto.randomUUID(),turn=crypto.randomUUID(),dbPath=path.join(process.env.USERPROFILE,'.zcode/cli/db/db.sqlite');
fs.mkdirSync(path.dirname(dbPath),{recursive:true});const db=new DatabaseSync(dbPath);
db.exec('CREATE TABLE IF NOT EXISTS model_usage (id TEXT, session_id TEXT, trace_id TEXT, turn_id TEXT, provider_id TEXT, model_id TEXT, variant TEXT, started_at INTEGER)');
db.prepare('INSERT INTO model_usage VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(crypto.randomUUID(),sid,trace,turn,selected.providerId,selected.modelId,selected.options.reasoningLevel,Date.now());db.close();
console.log(JSON.stringify({sessionId:sid,traceId:trace,turnId:turn,response:'fixture-ok',usage:{inputTokens:1,outputTokens:1},projection:{status:'idle',turnCount:1}}));
`)
    const manifest = JSON.parse(await fs.readFile(path.join(repo, 'endpoints', 'zcode.json'), 'utf8'))
    manifest.detect = { bin }; await fs.writeFile(path.join(manifests, 'zcode.json'), JSON.stringify(manifest))
    const config = { endpoints: { overrides: { zcode: { provider_config: profile } } }, defaults: {} }
    await fs.writeFile(path.join(home, 'config.json'), JSON.stringify(config))
    const env = { ...process.env, USERPROFILE: root, ZCODE_DATA_BASE_DIR: root, PAIDAN_HOME: home, PAIDAN_DATA_DIR: path.join(root, 'data'), PAIDAN_ENDPOINTS_DIR: manifests }
    delete env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE
    const exec = promisify(execFile)
    const cli = async (...args) => JSON.parse((await exec(process.execPath, [path.join(repo, 'dist', 'cli.js'), ...args], { env, timeout: 35000 })).stdout)
    const run = async (name, ...args) => {
        const r = await cli('run', '--endpoint', 'zcode', '--cwd', root, '--task', name, ...args)
        const done = await cli('get', r.run_id, '--wait', '--timeout', '20')
        await waitForWorkerExit(env.PAIDAN_DATA_DIR, r.run_id)
        return done
    }
    const first = await run('dedicated')
    assert.equal(first.result.evidence.selection.matches_expected, true)
    assert.equal(first.result.evidence.selection.actual[0].provider_name, 'Name api')
    const native = await run('native', '--native')
    assert.equal(native.result.evidence.selection.actual[0].provider, 'original')
    const resumed = await run('resume', '--resume', first.result.session_handle)
    assert.deepEqual(resumed.result.evidence.selection.actual.map(x => x.provider), ['api'])
    env.FIXTURE_MISMATCH = '1'
    const mismatch = await run('mismatch')
    assert.equal(mismatch.result.evidence.selection.matches_expected, false)
    assert.ok(mismatch.result.evidence.notes.some(n => n.includes('不能声称固定成功')))
    delete env.FIXTURE_MISMATCH
    const count = (await fs.readFile(path.join(root, 'launches'), 'utf8')).split('\n').filter(Boolean).length
    config.endpoints.overrides.zcode.provider_config = path.join(root, 'missing.json')
    await fs.writeFile(path.join(home, 'config.json'), JSON.stringify(config))
    const failed = await run('missing-profile')
    assert.equal(failed.run.state, 'failed')
    assert.equal((await fs.readFile(path.join(root, 'launches'), 'utf8')).split('\n').filter(Boolean).length, count)
    assert.ok(!JSON.stringify([first, native, mismatch, failed]).includes('fixture-secret'))
    assert.equal(await fs.readFile(globalFile, 'utf8'), globalRaw)
    assert.equal(await fs.readFile(profile, 'utf8'), dedicatedRaw)
})
