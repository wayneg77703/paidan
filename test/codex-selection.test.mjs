import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { fileURLToPath } from 'node:url'
import { parseCodexCatalog, codexConfigMetadata } from '../dist/endpoints/codex-models.js'
import { RunStore } from '../dist/engine/run-store.js'
import { waitForWorkerExit } from './helpers/worker.mjs'

const exec = promisify(execFile)
const repo = fileURLToPath(new URL('..', import.meta.url))

test('native Codex menu retains model-specific efforts and hides internal entries', () => {
    const rows = parseCodexCatalog(JSON.stringify({ models: [
        { slug: 'model-a', visibility: 'list', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'ultra' }], default_reasoning_level: 'low', secret: 'not-output' },
        { slug: 'model-b', visibility: 'list', supported_reasoning_levels: [] },
        { slug: 'hidden', visibility: 'hide' },
        { slug: '--bad', visibility: 'list' },
    ] }), 'openai')
    assert.deepEqual(rows.map(r => [r.alias, r.effort_options]), [['model-a', ['low', 'ultra']], ['model-b', []]])
    assert.ok(!JSON.stringify(rows).includes('not-output'))
    assert.throws(() => parseCodexCatalog('{}', 'openai'), /schema/)
    const parsed = codexConfigMetadata('instructions = """\nmodel_provider="fake"\n"""\nmodel="real"\n[model_providers.ds]\nbase_url="https://example.invalid"\napi_key="secret"\n')
    assert.equal(parsed.values.model_provider, undefined)
    assert.equal(parsed.values.model, 'real')
    assert.ok(!JSON.stringify(parsed).includes('secret'))
})

async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paidan-codex-select-'))
    t.after(async () => {
        assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()))
        await fs.rm(root, { recursive: true, force: true })
    })
    const home = path.join(root, 'home'), native = path.join(root, 'native'), manifests = path.join(root, 'endpoints')
    await Promise.all([home, native, manifests].map(p => fs.mkdir(p)))
    const bin = path.join(root, 'codex.cjs'), marker = path.join(root, 'spawns.jsonl')
    await fs.writeFile(bin, `
const fs = require('node:fs'); const path = require('node:path');
const a=process.argv.slice(2);
if(a.includes('--version')) { console.log('codex-cli 0.154.0'); process.exit(0); }
if(a[0]==='debug') { console.log(JSON.stringify({models:[{slug:'model-a',visibility:'list',supported_reasoning_levels:[{effort:'low'},{effort:'high'},{effort:'ultra'}],default_reasoning_level:'low'},{slug:'model-b',visibility:'list',supported_reasoning_levels:[{effort:'low'}]},{slug:'hidden',visibility:'hide'}]})); process.exit(0); }
fs.appendFileSync(${JSON.stringify(marker)},JSON.stringify(a)+'\\n');
process.stdin.resume(); process.stdin.on('end',()=>{
const emit=o=>console.log(JSON.stringify(o)); emit({type:'thread.started',thread_id:'fixture-thread'});
if(fs.existsSync(path.join(process.env.CODEX_HOME,'fail'))) { emit({type:'turn.failed',error:{message:'401 authentication rejected by selected provider'}});process.exitCode=1; }
else { emit({type:'item.completed',item:{type:'agent_message',text:'OK'}}); emit({type:'turn.completed',usage:{input_tokens:1,cached_input_tokens:0,output_tokens:1}}); }
});
`)
    const manifest = JSON.parse(await fs.readFile(path.join(repo, 'endpoints/codex.json'), 'utf8'))
    await fs.writeFile(path.join(manifests, 'codex.json'), JSON.stringify(manifest))
    const config = { endpoints: { enabled: ['codex'], overrides: { codex: { bin } } }, defaults: {} }
    const configFile = path.join(home, 'config.json'), nativeFile = path.join(native, 'config.toml')
    const save = () => fs.writeFile(configFile, JSON.stringify(config))
    await save()
    await fs.writeFile(nativeFile, 'model="model-a"\nmodel_reasoning_effort="high"\n')
    await fs.writeFile(path.join(native, 'auth.json'), '{"auth_mode":"chatgpt","tokens":{"access_token":"private-token"}}')
    const env = { ...process.env, PAIDAN_HOME: home, PAIDAN_DATA_DIR: path.join(root, 'data'), PAIDAN_ENDPOINTS_DIR: manifests, CODEX_HOME: native }
    for (const k of ['OPENAI_BASE_URL', 'OPENAI_API_KEY', 'CODEX_API_KEY']) delete env[k]
    const cli = async (...args) => {
        try { return JSON.parse((await exec(process.execPath, [path.join(repo, 'dist/cli.js'), ...args], { env, timeout: 30_000 })).stdout) }
        catch (e) { if (e.stdout) return JSON.parse(e.stdout); throw e }
    }
    const run = async (task, ...args) => cli('run', '--endpoint', 'codex', '--cwd', root, '--task', task, ...args)
    const done = async (task, ...args) => {
        const started = await run(task, ...args); assert.equal(started.ok, true, JSON.stringify(started))
        const result = await cli('get', started.run_id, '--wait', '--timeout', '20')
        assert.equal(result.terminal, true, JSON.stringify(result))
        await waitForWorkerExit(env.PAIDAN_DATA_DIR, started.run_id)
        return { started, result }
    }
    return { root, native, nativeFile, config, configFile, save, env, cli, run, done, marker }
}

test('fixed Codex defaults require the selected configuration; native override and recovery never rewrite configuration', async t => {
    const f = await fixture(t)
    const menu = await f.cli('models', '--endpoint', 'codex')
    assert.equal(menu.ok, true)
    assert.equal(menu.native_defaults.auth_type, 'oauth')
    assert.deepEqual(menu.models.map(m => m.alias), ['model-a', 'model-b'])
    assert.deepEqual(menu.models[0].effort_options, ['low', 'high', 'ultra'])
    assert.ok(!JSON.stringify(menu).includes('private-token'))
    f.config.defaults = { models: { codex: 'model-a' }, efforts: { codex: 'high' }, selection_contexts: { codex: menu.selection_context } }
    await f.save()
    const saved = await fs.readFile(f.configFile, 'utf8')
    assert.equal((await f.done('first')).result.run.state, 'completed')
    const count = (await fs.readFile(f.marker, 'utf8')).split('\n').filter(Boolean).length
    await fs.writeFile(f.nativeFile, 'model="ds-model"\nmodel_provider="ds"\nmodel_reasoning_effort="low"\n[model_providers.ds]\nbase_url="https://private.invalid/v1"\n')
    for (const args of [[], ['--model', 'ds-model'], ['--model', 'ds-model', '--effort', 'low', '--selection-context', menu.selection_context]]) {
        const blocked = await f.run('changed', ...args)
        assert.equal(blocked.error.code, 'SELECTION_RECONFIRM_REQUIRED')
        assert.equal(blocked.error.details.native_defaults.connection, 'ds')
        assert.equal(blocked.run_id, undefined)
    }
    assert.equal((await fs.readFile(f.marker, 'utf8')).split('\n').filter(Boolean).length, count)
    const current = await f.cli('models', '--endpoint', 'codex')
    assert.deepEqual(current.models.map(m => m.alias), ['ds-model'])
    assert.equal(current.native_defaults.auth_type, 'unknown', 'leftover OAuth file does not label the custom route')
    assert.ok(!JSON.stringify(current).includes('private.invalid'))
    const native = await f.done('native selected by user', '--native')
    const req = JSON.parse(await fs.readFile(path.join(f.env.PAIDAN_DATA_DIR, 'runs', native.started.run_id, 'request.json'), 'utf8'))
    assert.equal(req.model, null); assert.equal(req.effort, null)
    assert.equal(req.native_selection.connection, 'ds')
    await f.done('explicit new selection', '--model', 'ds-model', '--effort', 'low', '--selection-context', current.selection_context)
    await fs.writeFile(path.join(f.native, 'fail'), '')
    const failed = await f.done('auth failure', '--native')
    assert.equal(failed.result.run.state, 'failed')
    assert.ok(failed.result.result.evidence.notes.some(n => n.includes('401 authentication rejected')))
    assert.equal(failed.result.recovery.native_at_submission.connection, 'ds')
    assert.equal(await fs.readFile(f.configFile, 'utf8'), saved)
})

test('unbound old pins stop once; unrelated permissions do not invalidate a selection; worker checks submit/spawn race', async t => {
    const f = await fixture(t)
    f.config.defaults = { efforts: { codex: 'low' } }; await f.save()
    assert.equal((await f.run('legacy fixed effort')).error.code, 'SELECTION_RECONFIRM_REQUIRED')
    const probe = await f.cli('probe', '--endpoint', 'codex', '--timeout', '1')
    assert.ok(probe.probes.every(p => p.verdict !== 'pass'), JSON.stringify(probe))
    assert.equal(await fs.stat(f.marker).then(() => true, () => false), false, 'probe cannot bypass the fixed-selection guard')
    const first = await f.cli('models', '--endpoint', 'codex')
    await fs.appendFile(f.nativeFile, 'approval_policy="never"\n')
    assert.equal((await f.cli('models', '--endpoint', 'codex')).selection_context, first.selection_context)
    const store = new RunStore(f.env.PAIDAN_DATA_DIR)
    const { request } = await store.create({ endpoint: 'codex', cwd: f.root, task_text: 'race', task_file: null,
        add_dirs: [], mode: 'workspace-write', model: 'model-a', effort: null, resume_session: null,
        selection_context: first.selection_context, run_timeout_sec: 15, deliverables: [], warnings: [] })
    await fs.appendFile(f.nativeFile, 'model_provider="different"\n')
    await exec(process.execPath, [path.join(repo, 'dist/worker.js'), request.run_id], { env: f.env, timeout: 20_000 })
    const result = await store.readResult(request.run_id)
    assert.equal(result.state, 'failed')
    assert.ok(result.evidence.notes.some(n => n.includes('SELECTION_RECONFIRM_REQUIRED')))
    assert.equal(await fs.stat(f.marker).then(() => true, () => false), false)
})
