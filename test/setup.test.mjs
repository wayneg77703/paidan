// First-install and repair flows, using only temporary homes and metadata-only fake CLIs.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { buildZcodeProfile } from '../dist/endpoints/zcode-setup.js'
import { updateDshSettings } from '../dist/endpoints/dsh-setup.js'
import { readDshNativeDefaults } from '../dist/endpoints/dsh-models.js'
import { installationFile, readInstallationReceipt, applyInstallationFiles } from '../dist/engine/installation-files.js'

const repo = fileURLToPath(new URL('..', import.meta.url)), exec = promisify(execFile)

async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paidan-setup-'))
    t.after(async () => { assert.equal(path.dirname(root), os.tmpdir()); await fs.rm(root, { recursive: true, force: true }) })
    const home = path.join(root, 'paidan'), native = path.join(root, 'native'), manifests = path.join(root, 'endpoints')
    await Promise.all([native, manifests].map(p => fs.mkdir(p)))
    const marker = path.join(root, 'calls.jsonl')
    const bin = path.join(root, 'entry.cjs')
    await fs.writeFile(bin, `const fs=require('node:fs');const a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(marker)}, JSON.stringify(a)+'\\n');
        if(a.includes('--version')) console.log('1.0.0');
        else if(a[0]==='models') console.log(JSON.stringify({models:[
          {selector:'deepseek/deepseek-flash',name:'DeepSeek V4.1 Flash',provider:'deepseek',thinking:['low','high','max']},
          {selector:'deepseek/deepseek-v4-flash',name:'DeepSeek V4 Flash',provider:'deepseek',thinking:['low','high','max']}]}));
        else if(a[0]==='config'&&a[1]==='path') console.log(${JSON.stringify(native)});
        else if(a[0]==='config') console.log(JSON.stringify({modelRoles:{value:{default:'deepseek/deepseek-flash'}},defaultThinkingLevel:{value:'max'}}));
        else { console.error('Model invocation forbidden in setup');process.exit(90) }`)
    const second = path.join(root, 'other-entry.cjs')
    await fs.copyFile(bin, second)
    const env = { ...process.env, PAIDAN_HOME: home, PAIDAN_DATA_DIR: path.join(home, 'data'), PAIDAN_HOST_HOME: native,
        PAIDAN_ENDPOINTS_DIR: manifests, USERPROFILE: native, HOME: native, ZCODE_DATA_BASE_DIR: native,
        SETUP_FIRST: bin, SETUP_SECOND: second }
    delete env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE
    delete env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE
    const manifest = async (name, bins) => {
        const value = JSON.parse(await fs.readFile(path.join(repo, 'endpoints', name + '.json'), 'utf8'))
        value.detect = { bin: 'not-a-real-cli-name', known_paths: bins }
        await fs.writeFile(path.join(manifests, name + '.json'), JSON.stringify(value))
    }
    const cli = async (...args) => {
        try { return JSON.parse((await exec(process.execPath, [path.join(repo, 'dist/cli.js'), ...args], { env, timeout: 30000 })).stdout) }
        catch (e) { if (e.stdout) return JSON.parse(e.stdout); throw e }
    }
    const choicesFile = path.join(root, 'choices.json')
    const choose = data => fs.writeFile(choicesFile, JSON.stringify(data))
    const setup = (...flags) => cli('setup', '--choices', choicesFile, ...flags)
    const source = path.join(native, '.zcode', 'v2', 'provider_config.json')
    await fs.mkdir(path.dirname(source), { recursive: true })
    const provider = id => ({ providerId: id, enabled: true, config: { access: { type: 'api-key', apiKey: 'fixture-credential-' + id }, personalModelIds: ['GLM'] } })
    const personal = { schemaVersion: 1, config: { providerConfigRules: { providerRules: [provider('selected'), provider('other')] },
        modelConfigRules: { providerModelRules: [{ providerId: 'selected', modelId: 'GLM', config: { optionSpecs: { reasoningLevel: { values: ['low', 'max'] } } } }],
            manualProviderModelRules: [{ providerId: 'selected', modelId: 'GLM', config: { maxTokens: 123 } }, { providerId: 'other', modelId: 'GLM', config: {} }] } } }
    await fs.writeFile(source, JSON.stringify(personal))
    return { root, home, native, env, bin, second, marker, manifest, cli, choose, setup, source, personal }
}

test('permission-only setup preserves binary discovery, stable entry paths and fixed model choices', async t => {
    for (const pinned of [false, true]) {
        const f = await fixture(t)
        await f.manifest('omp', ['{env:SETUP_FIRST}'])
        await fs.mkdir(f.home)
        const original = { endpoints: { enabled: ['omp'], overrides: pinned ? {
            omp: { bin: path.dirname(f.bin) + path.sep + '.' + path.sep + path.basename(f.bin) }
        } : {} }, defaults: { endpoint: 'omp', models: { omp: 'old-choice' }, efforts: { omp: 'max' },
            selection_contexts: { omp: 'sha256:' + 'a'.repeat(64) }, modes: {} } }
        const file = path.join(f.home, 'config.json')
        await fs.writeFile(file, JSON.stringify(original))
        await f.choose({ endpoints: { omp: { mode: 'unattended' } } })
        const preview = await f.setup()
        assert.equal(preview.ok, true, JSON.stringify(preview))
        assert.equal(await fs.readFile(file, 'utf8'), JSON.stringify(original))
        const result = await f.setup('--apply', '--expect', preview.confirmation)
        assert.equal(result.applied, true, JSON.stringify(result))
        original.defaults.modes.omp = 'unattended'
        assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), original)
    }
})

test('setup enumerates both bundled ZCode entries, deduplicates paths and waits for a choice', async t => {
    const f = await fixture(t)
    await f.manifest('zcode', ['{env:SETUP_FIRST}', '{env:SETUP_SECOND}', '{env:SETUP_FIRST}'])
    const result = await f.cli('setup', '--endpoint', 'zcode')
    assert.equal(result.ok, true)
    assert.equal(result.endpoints[0].candidates.length, 2)
    assert.equal(result.endpoints[0].selection_required, true)
    assert.equal(result.endpoints[0].selected_bin, null)
    assert.deepEqual(result.endpoints[0].models, [], 'no query against a silently chosen installation')
    assert.equal(await fs.stat(f.home).then(() => true, () => false), false, 'inspection writes no paidan data or config')
    const selected = await f.cli('setup', '--endpoint', 'zcode', '--bin', f.second)
    assert.equal(selected.endpoints[0].selected_bin, await fs.realpath(f.second))
    assert.ok(selected.endpoints[0].models.some(m => m.alias === 'selected/GLM'))
    assert.ok(!JSON.stringify(selected).includes('fixture-credential'))
    const custom = path.join(f.root, 'other drive', 'ZCode'), entry = path.join(custom, 'resources/glm/zcode.cjs')
    await fs.mkdir(path.dirname(entry), { recursive: true })
    await fs.copyFile(f.bin, entry)
    await fs.writeFile(path.join(custom, 'ZCode.exe'), '')
    const hinted = await f.cli('setup', '--endpoint', 'zcode', '--location', path.join(custom, 'ZCode.exe'))
    const realEntry = await fs.realpath(entry)
    assert.ok(hinted.endpoints[0].candidates.some(c => c.bin === realEntry && c.source === 'location-hint'))
    assert.equal(hinted.endpoints[0].selection_required, true, 'a hint does not authorize picking among multiple installations')
    await fs.writeFile(f.second, 'process.exit(9)')
    const failedVersion = (await f.cli('setup', '--endpoint', 'zcode', '--bin', f.second)).endpoints[0]
    assert.equal(failedVersion.selected_bin, await fs.realpath(f.second))
    assert.equal(failedVersion.selection_required, false, 'a failed version command is not an ambiguous selection')
    assert.match(failedVersion.version_error, /9/)
    await f.choose({ endpoints: { zcode: { bin: f.second, native: true } } })
    assert.equal((await f.setup()).error.code, 'SETUP_VERSION_FAILED')
    assert.equal(await fs.stat(f.home).then(() => true, () => false), false)
})

test('reviewed setup maps model names exactly, merges config, builds one-provider profiles and preserves source rules', async t => {
    const f = await fixture(t)
    await f.manifest('omp', ['{env:SETUP_FIRST}'])
    await f.manifest('zcode', ['{env:SETUP_SECOND}'])
    await fs.mkdir(f.home)
    const configFile = path.join(f.home, 'config.json')
    const original = { ttlDays: 17, endpoints: { enabled: ['other'], overrides: { other: { bin: '/untouched/entry' } } }, defaults: { modes: { other: 'read-only' }, run_timeout_sec: 37 } }
    await fs.writeFile(configFile, JSON.stringify(original))
    const choices = { endpoints: { omp: { model: 'DeepSeek V4.1 Flash', effort: 'high' },
        zcode: { provider: 'selected', model: 'GLM', effort: 'max' } }, default_endpoint: 'omp', hosts: ['codex'] }
    await f.choose(choices)
    const preview = await f.setup()
    assert.equal(preview.ok, true, JSON.stringify(preview))
    assert.equal(preview.decisions[0].model, 'deepseek/deepseek-flash')
    assert.ok(!JSON.stringify(preview).includes('fixture-credential'))
    assert.equal(await fs.readFile(configFile, 'utf8'), JSON.stringify(original))
    const profile = path.join(f.native, '.zcode', 'paidan', 'provider_config.json')
    assert.equal(await fs.stat(profile).then(() => true, () => false), false)
    original.ttlDays = 18
    await fs.writeFile(configFile, JSON.stringify(original))
    assert.equal((await f.setup('--apply', '--expect', preview.confirmation)).error.code, 'SETUP_CHANGED')
    assert.equal(await fs.stat(profile).then(() => true, () => false), false, 'stale approval causes no partial writes')
    const current = await f.setup()
    const applied = await f.setup('--apply', '--expect', current.confirmation)
    assert.equal(applied.applied, true, JSON.stringify(applied))
    const saved = JSON.parse(await fs.readFile(configFile, 'utf8'))
    assert.equal(saved.ttlDays, 18)
    assert.equal(saved.defaults.run_timeout_sec, 37)
    assert.equal(saved.defaults.modes.other, 'read-only')
    assert.deepEqual(saved.endpoints.enabled, ['other', 'omp', 'zcode'])
    assert.equal(saved.defaults.models.omp, 'deepseek/deepseek-flash')
    assert.equal(saved.defaults.efforts.omp, 'high')
    assert.match(saved.defaults.selection_contexts.omp, /^sha256:/)
    assert.equal(saved.endpoints.overrides.omp.bin, await fs.realpath(f.bin))
    assert.equal(saved.endpoints.overrides.zcode.bin, await fs.realpath(f.second))
    const dedicated = JSON.parse(await fs.readFile(profile, 'utf8'))
    assert.deepEqual(dedicated.config.providerConfigRules.providerRules.map(p => p.providerId), ['selected'])
    assert.equal(dedicated.config.modelConfigRules.manualProviderModelRules.length, 1)
    assert.equal(dedicated.config.modelConfigRules.manualProviderModelRules[0].config.maxTokens, 123)
    assert.equal(await fs.readFile(f.source, 'utf8'), JSON.stringify(f.personal))
    assert.ok(!JSON.stringify(saved).includes('fixture-credential'))
    const receiptFile = path.join(f.home, 'install-receipt.json')
    const receipt = JSON.parse(await fs.readFile(receiptFile, 'utf8'))
    assert.equal(receipt.files[profile].owner, 'zcode')
    assert.ok(receipt.files[configFile].entries.omp.bin)
    assert.ok(!JSON.stringify(receipt).includes('fixture-credential'))
    assert.equal((await f.setup('--apply', '--expect', current.confirmation)).applied, true, 'repeating an already applied choice is a no-op')
    const inventory = await f.cli('setup', '--endpoint', 'zcode')
    assert.equal(inventory.choices.endpoints.zcode.native, undefined, 'existing dedicated selection is not reset to native')
    const skill = path.join(f.native, '.codex', 'skills', 'paidan', 'SKILL.md')
    await fs.writeFile(skill, '# user custom skill\n')
    assert.equal((await f.setup()).error.code, 'SETUP_SKILL_CONFLICT')
    assert.equal(await fs.readFile(skill, 'utf8'), '# user custom skill\n')
    choices.endpoints = {}
    choices.hosts = [{ name: 'codex', replace: true }]
    delete choices.default_endpoint
    await f.choose(choices)
    const skillOnly = await f.setup()
    assert.deepEqual(skillOnly.files.map(f => f.kind), ['skill'])
    const configBeforeSkill = await fs.readFile(configFile, 'utf8')
    const installed = await f.setup('--apply', '--expect', skillOnly.confirmation)
    assert.equal(installed.applied, true)
    assert.equal(await fs.readFile(installed.written[0].backup, 'utf8'), '# user custom skill\n')
    assert.equal(await fs.readFile(configFile, 'utf8'), configBeforeSkill, 'skill-only setup does not touch config')
    assert.deepEqual(JSON.parse(await fs.readFile(receiptFile, 'utf8')).files[profile], receipt.files[profile], 'local maintenance preserves other receipt entries')
    assert.ok((await fs.readFile(f.marker, 'utf8')).split('\n').filter(Boolean).every(s => ['--version', 'models', 'config'].includes(JSON.parse(s)[0])))
})

test('npx DSH discovery and native edits are scoped; adding and disabling another endpoint preserves existing choices', async t => {
    const f = await fixture(t)
    f.env.NPM_CONFIG_CACHE = path.join(f.root, 'npm-cache')
    f.env.npm_config_cache = f.env.NPM_CONFIG_CACHE // npm test exports a lowercase value on POSIX.
    f.env.DSH_HOME = path.join(f.native, '.dsh')
    const settings = path.join(f.env.DSH_HOME, 'profiles/headless/cordis.patch.yml')
    await fs.mkdir(path.dirname(settings), { recursive: true })
    const original = '- id: agent-default-model\r\n  config:\r\n    provider: old # keep\r\n    model: old-model\r\n    reasoningEffort: low\r\n- id: other\r\n  config:\r\n    untouched: yes\r\n'
    await fs.writeFile(settings, original)
    const entry = path.join(f.env.NPM_CONFIG_CACHE, '_npx', 'fixture-hash', 'node_modules/@deepseek-ai/dsh/lib/bin.js')
    await fs.mkdir(path.dirname(entry), { recursive: true })
    await fs.copyFile(f.bin, entry)
    await fs.writeFile(path.join(path.dirname(entry), '../package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '1.0.0' }))
    await f.manifest('dsh', [])
    const found = await f.cli('setup', '--endpoint', 'dsh')
    assert.equal(found.endpoints[0].selected_bin, await fs.realpath(entry))
    assert.equal(found.endpoints[0].candidates[0].source, 'npm-cache')
    await f.choose({ endpoints: { dsh: { bin: entry, native_settings: { provider: 'route', model: 'chosen', effort: 'high' } } } })
    const preview = await f.setup()
    assert.equal(preview.ok, true, JSON.stringify(preview))
    assert.equal(preview.decisions[0].affects_other_native_sessions, true)
    assert.equal(await fs.readFile(settings, 'utf8'), original)
    const applied = await f.setup('--apply', '--expect', preview.confirmation)
    assert.equal(applied.applied, true, JSON.stringify(applied))
    assert.equal(await fs.readFile(applied.written[0].backup, 'utf8'), original)
    assert.equal(await fs.readFile(settings, 'utf8'), updateDshSettings(original, { provider: 'route', model: 'chosen', effort: 'high' }))
    const readBack = readDshNativeDefaults(await fs.readFile(settings, 'utf8'))
    assert.deepEqual([readBack.connection, readBack.model, readBack.effort], ['route', 'chosen', 'high'])
    const configFile = path.join(f.home, 'config.json'), saved = JSON.parse(await fs.readFile(configFile, 'utf8'))
    assert.equal(saved.defaults.models.dsh, undefined)
    await f.manifest('opencode', ['{env:SETUP_SECOND}'])
    await fs.writeFile(f.marker, '')
    await f.choose({ endpoints: { opencode: { native: true, mode: 'workspace-write' } } })
    const addition = await f.setup()
    assert.equal((await f.setup('--apply', '--expect', addition.confirmation)).applied, true)
    const added = JSON.parse(await fs.readFile(configFile, 'utf8'))
    assert.equal(added.defaults.endpoint, 'dsh')
    assert.deepEqual(added.endpoints.overrides.dsh, saved.endpoints.overrides.dsh)
    assert.deepEqual(added.endpoints.enabled, ['dsh', 'opencode'])
    assert.ok(!(await fs.readFile(f.marker, 'utf8')).includes('headless'))
    await fs.rm(entry)
    const missing = await f.cli('setup', '--endpoint', 'dsh')
    assert.equal(missing.endpoints[0].selection_required, true, 'lost cache does not silently select or download a replacement')
    await f.choose({ endpoints: { dsh: { enabled: false } }, default_endpoint: 'opencode' })
    const disabled = await f.setup()
    assert.equal((await f.setup('--apply', '--expect', disabled.confirmation)).applied, true)
    const after = JSON.parse(await fs.readFile(configFile, 'utf8'))
    assert.deepEqual(after.endpoints.enabled, ['opencode'])
    assert.deepEqual(after.endpoints.overrides.dsh, saved.endpoints.overrides.dsh)
    for (const raw of ['agent-default-model: {model: old}\n', original + 'agent-default-model:\n', original + '"agent-default-model":\n  model: other\n', original.replace('    model: old-model', '    model: *alias'), original.replace('    model:', '    "model":')]) {
        assert.throws(() => updateDshSettings(raw, { provider: 'route', model: 'chosen' }), /普通块式/)
    }
})

test('DSH native-settings-only repair preserves the configured profile entry instead of its cache target', async t => {
    const f = await fixture(t)
    const previousDshHome = process.env.DSH_HOME
    f.env.DSH_HOME = path.join(f.native, '.dsh')
    process.env.DSH_HOME = f.env.DSH_HOME
    t.after(() => {
        if (previousDshHome === undefined) delete process.env.DSH_HOME
        else process.env.DSH_HOME = previousDshHome
    })
    const settings = path.join(f.env.DSH_HOME, 'profiles/headless/cordis.patch.yml')
    await fs.mkdir(path.dirname(settings), { recursive: true })
    await fs.writeFile(settings, '- id: agent-default-model\n  config:\n    provider: old\n    model: old-model\n    reasoningEffort: low\n')
    const source = path.join(f.env.DSH_HOME, 'profiles/web/cordis.patch.yml')
    await fs.mkdir(path.dirname(source), { recursive: true })
    await fs.writeFile(source, '- id: llm-pi-ai\n  config:\n    providers:\n      wb_lan:\n        apiKeyEnv: WB_LAN_API_KEY\n        models:\n          - id: cn:deepseek-v4.1-flash\n')
    const stableBin = path.join(f.env.DSH_HOME, 'profiles/node_modules/@deepseek-ai/dsh/lib/bin.js')
    const targetBin = path.join(f.root, 'npm-cache/_npx/hash/node_modules/@deepseek-ai/dsh/lib/bin.js')
    const configFile = path.join(f.home, 'config.json')
    await fs.mkdir(f.home, { recursive: true })
    await fs.writeFile(configFile, JSON.stringify({ endpoints: { enabled: ['dsh'], overrides: { dsh: { bin: stableBin } } },
        defaults: { endpoint: 'dsh', models: {}, efforts: {}, selection_contexts: {}, modes: {} } }))
    await f.manifest('dsh', [])
    const { loadConfig } = await import('../dist/engine/config.js')
    const { EndpointRegistry } = await import('../dist/endpoints/registry.js')
    const { planInstallation, applyInstallation } = await import('../dist/installation.js')
    const ctx = { config: loadConfig(configFile), configPath: configFile, dataDir: path.join(f.home, 'data'),
        registry: await EndpointRegistry.load(f.env.PAIDAN_ENDPOINTS_DIR) }
    const surveyed = [{ name: 'dsh', selected_bin: targetBin, version_error: null, runtime_resources: null,
        candidates: [{ bin: targetBin, source: 'config-override', version: '1.0.0', version_error: null }],
        native_defaults: null, configured_defaults: { model: null, effort: null, provider_config: null },
        connections: [], models: [], selection_context: null, notes: [], error: null }]
    const plan = await planInstallation(ctx, { endpoints: { dsh: {
        native_settings: { provider: 'wb_lan', model: 'cn:deepseek-v4.1-flash', effort: 'max', source_profile: 'web' },
    } } }, f.root, surveyed)
    assert.ok(plan.files.find(f => f.kind === 'dsh-settings').payload.includes('wb_lan'))
    const applied = await applyInstallation(plan, plan.preview.confirmation)
    assert.equal(applied.applied, true, JSON.stringify(applied))
    assert.ok(applied.written.some(f => f.kind === 'dsh-settings'))
    const saved = JSON.parse(await fs.readFile(configFile, 'utf8'))
    assert.equal(saved.endpoints.overrides.dsh.bin, stableBin)
    assert.notEqual(saved.endpoints.overrides.dsh.bin, targetBin)
    assert.equal(readDshNativeDefaults(await fs.readFile(settings, 'utf8')).model, 'cn:deepseek-v4.1-flash')
    assert.ok((await fs.readFile(settings, 'utf8')).includes('llm-pi-ai'))
})

test('multi-endpoint setup surveys run sequentially instead of racing native CLIs', async t => {
    const f = await fixture(t)
    const timeline = path.join(f.root, 'timeline.jsonl')
    f.env.SETUP_TIMELINE = timeline
    const fake = (kind) => `const fs=require('node:fs');const a=process.argv.slice(2);const timeline=process.env.SETUP_TIMELINE;
        const log=(event)=>fs.appendFileSync(timeline,JSON.stringify({event,pid:process.pid,kind:${JSON.stringify(kind)},args:a})+'\\n');log('start');
        setTimeout(()=>{${kind === 'codex'
            ? `if(a.includes('--version'))console.log('codex-cli 1.0.0');else if(a[0]==='debug')console.log('{"models":[]}');`
            : `if(a.includes('--version'))console.log('omp/1.0.0');else if(a[0]==='models')console.log('{"models":[]}');else if(a[0]==='config'&&a[1]==='path')console.log(${JSON.stringify(f.native)});else if(a[0]==='config')console.log('{}');`}
            log('end')},75)`
    await fs.writeFile(f.bin, fake('codex'))
    await fs.writeFile(f.second, fake('omp'))
    await f.manifest('codex', ['{env:SETUP_FIRST}'])
    await f.manifest('omp', ['{env:SETUP_SECOND}'])
    const found = await f.cli('setup', '--endpoint', 'codex', '--endpoint', 'omp')
    assert.equal(found.ok, true, JSON.stringify(found))
    const events = (await fs.readFile(timeline, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    const lastCodex = events.findLastIndex(e => e.kind === 'codex')
    const firstOmp = events.findIndex(e => e.kind === 'omp')
    assert.ok(lastCodex >= 0 && firstOmp > lastCodex, JSON.stringify(events))
})

test('installation records completed writes on partial failure and refuses malformed receipts before writing', async t => {
    const f = await fixture(t), config = path.join(f.home, 'config.json')
    if (process.platform === 'win32') {
        const moduleUrl = new URL('../dist/engine/approved-write.js', import.meta.url).href
        const code = `import { assertUnlinkedTarget } from ${JSON.stringify(moduleUrl)}; await assertUnlinkedTarget(${JSON.stringify(f.native.toUpperCase())},${JSON.stringify(path.join(f.native.toLowerCase(), 'case-check.txt'))});`
        await exec(process.execPath, ['--input-type=module', '-e', code], { timeout: 5000 })
    }
    const receipt = await readInstallationReceipt(config)
    const first = await installationFile(f.native, path.join(f.native, 'owned.txt'), 'reviewed', 'skill', 'codex')
    const second = await installationFile(f.native, path.join(f.native, 'changed.txt'), 'planned', 'skill', 'omp')
    await fs.writeFile(second.target, 'user changed it')
    await assert.rejects(applyInstallationFiles([first, second], receipt, 'test'), e => e.code === 'SETUP_WRITE_FAILED' && e.details.written.length === 1)
    const saved = JSON.parse(await fs.readFile(receipt.target, 'utf8'))
    assert.deepEqual(Object.keys(saved.files), [first.target])
    assert.equal(await fs.readFile(second.target, 'utf8'), 'user changed it')
    await fs.writeFile(receipt.target, '{broken')
    await assert.rejects(readInstallationReceipt(config), e => e.code === 'SETUP_RECEIPT_INVALID')
})

test('setup refuses guessed model names, unsupported efforts and provider/model mismatches before writing', async t => {
    const f = await fixture(t)
    await f.manifest('omp', ['{env:SETUP_FIRST}'])
    await f.manifest('zcode', ['{env:SETUP_SECOND}'])
    for (const [endpoint, choice, code] of [
        ['omp', { model: 'V4.1 maybe', effort: 'high' }, 'MODEL_UNAVAILABLE'],
        ['omp', { model: 'DeepSeek V4.1 Flash', effort: 'xhigh' }, 'EFFORT_INVALID'],
        ['zcode', { provider: 'selected', model: 'other/GLM', effort: 'max' }, 'EFFORT_INVALID'],
    ]) {
        await f.choose({ endpoints: { [endpoint]: choice } })
        assert.equal((await f.setup()).error.code, code)
    }
    assert.equal(await fs.stat(f.home).then(() => true, () => false), false)
    const broken = structuredClone(f.personal)
    broken.config.providerConfigRules.providerRules.push(broken.config.providerConfigRules.providerRules[0])
    assert.throws(() => buildZcodeProfile(broken, { provider: 'selected', model: 'GLM', effort: 'max' }), /唯一/)
    broken.config.providerConfigRules.providerRules.pop()
    broken.config.providerConfigRules.providerRules[0].config.access.type = 'oauth'
    assert.throws(() => buildZcodeProfile(broken, { provider: 'selected', model: 'GLM', effort: 'max' }), /API/)
    const outside = path.join(f.root, 'outside')
    await fs.mkdir(outside)
    await fs.symlink(outside, path.join(f.native, '.zcode', 'paidan'), 'junction')
    await f.choose({ endpoints: { zcode: { provider: 'selected', model: 'GLM', effort: 'max' } } })
    const unsafe = await f.setup()
    assert.equal(unsafe.error.code, 'SETUP_UNSAFE_TARGET')
    assert.match(unsafe.error.message, /link/)
    assert.deepEqual(await fs.readdir(outside), [])
})
