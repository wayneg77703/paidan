import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { discoverClaudeModels, readClaudeNativeDefaults } from '../dist/endpoints/claude-models.js'
import { createParser } from '../dist/endpoints/claude-stream-json.js'
import { waitForWorkerExit } from './helpers/worker.mjs'
import { RunStore } from '../dist/engine/run-store.js'

const exec = promisify(execFile)
const repo = fileURLToPath(new URL('..', import.meta.url))

test('Claude menus distinguish alias mappings and fixed IDs, with per-model effort metadata', () => {
    const settings = JSON.stringify({ model: 'saved-model', env: {
        ANTHROPIC_MODEL: 'claude-fable-5-1[1M]', ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-fable-5-1[1M]',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-opus-4-6', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-4-5',
        ANTHROPIC_CUSTOM_MODEL_OPTION: 'custom-deployment', ANTHROPIC_AUTH_TOKEN: 'private-token', ANTHROPIC_BASE_URL: 'https://private.invalid',
    } })
    const result = discoverClaudeModels(settings)
    assert.equal(result.native_defaults.model, 'claude-fable-5-1[1M]')
    assert.equal(result.models.find(m => m.alias === 'opus').resolved_model, 'claude-fable-5-1[1M]')
    assert.deepEqual(result.models.find(m => m.alias === 'sonnet').effort_options, ['low', 'medium', 'high', 'max'])
    assert.deepEqual(result.models.find(m => m.alias === 'haiku').effort_options, [])
    assert.equal(result.models.find(m => m.alias === 'custom-deployment').effort_options, null)
    assert.equal(result.models.filter(m => m.alias === 'claude-fable-5-1[1M]').length, 1)
    assert.ok(!JSON.stringify(result).includes('private-') && !JSON.stringify(result).includes('private.invalid'))
    assert.equal(readClaudeNativeDefaults('{"env":{"ANTHROPIC_DEFAULT_MODEL":"new-default"}}').model, 'new-default')
})

test('Claude result error details survive parsing for concrete failure diagnosis', () => {
    const parser = createParser()
    parser.acceptStdoutLine(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['403 quota exhausted'] }))
    const result = parser.finish('', '')
    assert.ok(result.warnings.some(v => v.includes('403 quota exhausted')))
    assert.equal(result.degraded, false)
})

test('Claude explicit effort overrides only its invocation; native and resumed runs preserve settings', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paidan-claude-select-'))
    t.after(async () => { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); await fs.rm(root, { recursive: true, force: true }) })
    for (const dir of ['home', 'native', 'endpoints']) await fs.mkdir(path.join(root, dir))
    const nativeFile = path.join(root, 'native/settings.json'), marker = path.join(root, 'calls.jsonl'), bin = path.join(root, 'claude.cjs')
    const native = JSON.stringify({ effortLevel: 'high', env: { ANTHROPIC_MODEL: 'claude-opus-4-6', ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-opus-4-6', ANTHROPIC_AUTH_TOKEN: 'private-token' } })
    await fs.writeFile(nativeFile, native)
    await fs.copyFile(path.join(repo, 'endpoints/claude-code.json'), path.join(root, 'endpoints/claude-code.json'))
    await fs.writeFile(bin, `const fs=require('node:fs');const a=process.argv.slice(2);if(a.includes('--version')){console.log('2.1.270');process.exit(0)}fs.appendFileSync(${JSON.stringify(marker)},JSON.stringify(a)+'\\n');const emit=o=>console.log(JSON.stringify(o));emit({type:'system',subtype:'init',session_id:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'});if(fs.existsSync(${JSON.stringify(path.join(root, 'fail'))})){emit({type:'result',is_error:true,subtype:'error_during_execution',errors:['403 quota exhausted; Bearer fixture-secret-token']});process.exitCode=1}else emit({type:'result',subtype:'success',result:'OK'});`)
    const configFile = path.join(root, 'home/config.json')
    const config = { endpoints: { enabled: ['claude-code'], overrides: { 'claude-code': { bin } } }, defaults: { models: { 'claude-code': 'sonnet' }, efforts: { 'claude-code': 'low' } } }
    await fs.writeFile(configFile, JSON.stringify(config))
    const env = { ...process.env, PAIDAN_HOME: path.join(root, 'home'), PAIDAN_DATA_DIR: path.join(root, 'data'), PAIDAN_ENDPOINTS_DIR: path.join(root, 'endpoints'), CLAUDE_CONFIG_DIR: path.join(root, 'native') }
    for (const k of Object.keys(env)) if (k.startsWith('ANTHROPIC_') || k === 'CLAUDE_CODE_EFFORT_LEVEL') delete env[k]
    const cli = async (...args) => {
        try { return JSON.parse((await exec(process.execPath, [path.join(repo, 'dist/cli.js'), ...args], { env, timeout: 30_000 })).stdout) }
        catch (e) { if (e.stdout) return JSON.parse(e.stdout); throw e }
    }
    const run = (...args) => cli('run', '--endpoint', 'claude-code', '--cwd', root, '--task', 'test selection', ...args)
    const done = async (...args) => {
        const start = await run(...args); assert.equal(start.ok, true, JSON.stringify(start))
        const end = await cli('get', start.run_id, '--wait', '--timeout', '20')
        assert.equal(end.terminal, true)
        await waitForWorkerExit(env.PAIDAN_DATA_DIR, start.run_id)
        return end
    }
    assert.equal((await run()).error.code, 'SELECTION_RECONFIRM_REQUIRED', 'old unbound defaults require a choice')
    const chosen = await cli('models', '--endpoint', 'claude-code')
    config.defaults.selection_contexts = { 'claude-code': chosen.selection_context }
    await fs.writeFile(configFile, JSON.stringify(config))
    assert.equal((await done()).run.state, 'completed')
    await done('--resume', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
    const calls = (await fs.readFile(marker, 'utf8')).trim().split('\n').map(JSON.parse)
    for (const args of calls) {
        assert.equal(args[args.indexOf('--effort') + 1], 'low')
        assert.ok(!args.includes('--settings'), 'paidan must not override native environment settings')
        assert.ok(!JSON.stringify(args).includes('private-token'))
    }
    assert.equal((await run('--effort', 'xhigh')).error.code, 'EFFORT_INVALID')
    assert.equal((await run('--model', 'claude-haiku-4-5', '--effort', 'high')).error.code, 'EFFORT_INVALID')
    await done('--native')
    const last = JSON.parse((await fs.readFile(marker, 'utf8')).trim().split('\n').at(-1))
    assert.ok(!last.includes('--settings') && !last.includes('--effort'))
    await fs.writeFile(path.join(root, 'fail'), '')
    const failed = await done()
    assert.equal(failed.run.state, 'failed')
    assert.ok(failed.result.evidence.notes.some(n => n.includes('403 quota exhausted')))
    assert.ok(!JSON.stringify(failed).includes('fixture-secret-token'))
    assert.equal(await fs.readFile(nativeFile, 'utf8'), native)
    assert.equal(await fs.readFile(configFile, 'utf8'), JSON.stringify(config))

    // A switcher's edit changes route/aliases but keeps the old paidan defaults.
    const changed = JSON.parse(native)
    changed.env.ANTHROPIC_BASE_URL = 'https://private-gateway.invalid'
    changed.env.ANTHROPIC_MODEL = 'ds-model'
    changed.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'ds-model'
    await fs.writeFile(nativeFile, JSON.stringify(changed))
    const callsBefore = await fs.readFile(marker, 'utf8')
    const blocked = await run()
    assert.equal(blocked.error.code, 'SELECTION_RECONFIRM_REQUIRED')
    assert.equal(blocked.error.details.native_defaults.model, 'ds-model')
    assert.equal(await fs.readFile(marker, 'utf8'), callsBefore)
    const current = await cli('models', '--endpoint', 'claude-code')
    assert.notEqual(current.selection_context, chosen.selection_context)
    assert.equal(current.models.find(m => m.alias === 'sonnet').resolved_model, 'ds-model')
    assert.ok(!JSON.stringify(current).includes('private-gateway.invalid'))
    assert.ok((await cli('doctor', '--endpoint', 'claude-code')).issues.some(i => i.includes('重新选择')))
    assert.equal((await run('--selection-context', chosen.selection_context)).error.code, 'SELECTION_RECONFIRM_REQUIRED')
    await fs.rm(path.join(root, 'fail'))
    await done('--native')
    await done('--model', 'ds-model', '--effort', 'low', '--selection-context', current.selection_context)
    assert.equal(await fs.readFile(configFile, 'utf8'), JSON.stringify(config), 'one-run choices do not overwrite saved defaults')
    // Cosmetic preferences and credential rotation alone do not invalidate model selection.
    changed.env.ANTHROPIC_AUTH_TOKEN = 'rotated-private-token'
    changed.theme = 'dark'
    await fs.writeFile(nativeFile, JSON.stringify(changed))
    assert.equal((await cli('models', '--endpoint', 'claude-code')).selection_context, current.selection_context)
    changed.env.ANTHROPIC_BASE_URL = 'https://another-private-gateway.invalid'
    await fs.writeFile(nativeFile, JSON.stringify(changed))
    const latest = await cli('models', '--endpoint', 'claude-code')
    assert.notEqual(latest.selection_context, current.selection_context, 'same route label with a new API address is still a change')
    config.defaults.models['claude-code'] = 'ds-model'
    config.defaults.selection_contexts['claude-code'] = latest.selection_context
    await fs.writeFile(configFile, JSON.stringify(config))
    await done() // the user's new persistent choice works without one-run flags
    assert.equal(await fs.readFile(nativeFile, 'utf8'), JSON.stringify(changed))

    const store = new RunStore(env.PAIDAN_DATA_DIR)
    const draft = await store.create({ endpoint: 'claude-code', cwd: root, task_text: 'before-spawn race', task_file: null,
        add_dirs: [], mode: 'workspace-write', model: 'ds-model', effort: 'low', resume_session: null,
        selection_context: latest.selection_context, run_timeout_sec: 15, deliverables: [], warnings: [] })
    changed.env.ANTHROPIC_BASE_URL = 'https://changed-before-spawn.invalid'
    await fs.writeFile(nativeFile, JSON.stringify(changed))
    const callsAtSubmit = await fs.readFile(marker, 'utf8')
    await exec(process.execPath, [path.join(repo, 'dist/worker.js'), draft.request.run_id], { env, timeout: 20_000 })
    const refused = await store.readResult(draft.request.run_id)
    assert.ok(refused.evidence.notes.some(n => n.includes('SELECTION_RECONFIRM_REQUIRED')))
    assert.equal(await fs.readFile(marker, 'utf8'), callsAtSubmit)
})
