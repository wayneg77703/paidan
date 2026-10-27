import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { readDshNativeDefaults, readDshPatchDefaults, readNativeDefaults, discoverDshModels, dshSettingsPath } from '../dist/endpoints/dsh-models.js'
import { updateDshSettings } from '../dist/endpoints/dsh-setup.js'
const base = '- insert:\n    - id: agent-default-model\n      name: "@deepseek-ai/dsh-agent-default-model"\n      config:\n        provider: route\n        model: base\n        reasoningEffort: high\n'
const patch = '- id: agent-default-model\n  config:\n    provider: route\n    model: changed\n'
test('patch order replaces whole config rather than retaining old effort', () => {
    const result = readDshPatchDefaults([base, patch, '- id: agent-default-model\n  config:\n    provider: home\n    model: last\n'])
    assert.deepEqual([result.connection, result.model, result.effort], ['home', 'last', null])
    assert.equal(readDshNativeDefaults(base).effort, 'high')
})
test('unsupported syntax is unknown and never evaluated or leaked', () => {
    for (const raw of ['agent-default-model:\n  model: obsolete\n', patch.replace('changed', '!!js process.env.SECRET'), patch.replace('changed', '*alias'), '- id: agent-default-model\n  config: {model: inline}\n', '- id: "*"\n  disabled: true\n']) {
        const r = discoverDshModels(raw); assert.equal(r.native_defaults.model, null); assert.deepEqual(r.models, [])
        assert.ok(!JSON.stringify(r).includes('process.env.SECRET'))
    }
})
test('literal text containing a fake model row does not override selection', () => {
    const raw = base + '- id: system-prompt\n  config:\n    text: |\n      - id: agent-default-model\n        config:\n          model: fake\n'
    assert.equal(readDshNativeDefaults(raw).model, 'base')
})
test('disabled default cannot be reported as active', () => {
    assert.equal(readDshPatchDefaults([base, '- id: agent-default-model\n  disabled: true\n']).model, null)
})
test('setup preserves unrelated bytes, targets profile only, and rejects higher precedence', () => {
    const original = '- insert:\n    - id: mcp-fixture\n      name: fixture\n      config:\n        apiKey: fixture-secret\n'
    const result = updateDshSettings(original, { provider: 'route', model: 'chosen', effort: 'max' })
    assert.ok(result.startsWith(original)); assert.equal(readDshNativeDefaults(result).model, 'chosen')
    assert.throws(() => updateDshSettings(original, { provider: 'route', model: 'chosen' }, patch), /home patch/)
    assert.throws(() => updateDshSettings('agent-default-model: {}', { provider: 'route', model: 'chosen' }), /普通块式/)
    assert.equal(readDshNativeDefaults(updateDshSettings('# empty\n[]\n', { provider: 'route', model: 'chosen', effort: 'high' })).model, 'chosen')
})
test('native discovery reads bundle/profile/home stack and ignores stale settings.yaml', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paidan-dsh-layers-')), old = process.env.DSH_HOME
    process.env.DSH_HOME = root
    t.after(async () => { if (old === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = old; await fs.rm(root, { recursive: true, force: true }) })
    const profile = path.join(root, 'profiles/headless'), bundle = path.join(root, 'profiles/node_modules/fixture-base')
    await fs.mkdir(profile, { recursive: true }); await fs.mkdir(bundle, { recursive: true })
    await fs.writeFile(path.join(profile, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['fixture-base'] } } }))
    await fs.writeFile(path.join(bundle, 'package.json'), '{}'); await fs.writeFile(path.join(bundle, 'cordis.patch.yml'), base)
    await fs.writeFile(path.join(root, 'settings.yaml'), 'agent-default-model:\n  model: obsolete\n')
    await fs.writeFile(dshSettingsPath(), patch)
    assert.equal((await readNativeDefaults()).model, 'changed')
    await fs.writeFile(path.join(root, 'cordis.patch.yml'), patch.replace('changed', 'home'))
    assert.equal((await readNativeDefaults()).model, 'home')
    await fs.unlink(path.join(bundle, 'cordis.patch.yml'))
    assert.equal((await readNativeDefaults()).model, null)
})

test('setup preserves omitted effort and repeated selection is byte-idempotent', () => {
    const updated = updateDshSettings(base, { provider: 'route', model: 'chosen' })
    assert.equal(readDshNativeDefaults(updated).effort, 'high')
    assert.equal(updateDshSettings(updated, { provider: 'route', model: 'chosen' }), updated)
    assert.equal(updateDshSettings(updated, { provider: 'route', model: 'chosen', effort: 'high' }), updated)
    const profileOnly = '# no model override\n[]\n'
    assert.throws(() => updateDshSettings(profileOnly, { provider: 'route', model: 'chosen' }), /省略 effort/)
    const inherited = updateDshSettings(profileOnly, { provider: 'route', model: 'chosen' }, null, { provider: 'route', model: 'base', reasoningEffort: 'max' })
    assert.equal(readDshNativeDefaults(inherited).effort, 'max')
    assert.throws(() => updateDshSettings(patch + '    futureField: value\n', { provider: 'route', model: 'chosen', effort: 'high' }), /普通块式/)
})

test('provider sync copies only the safe llm-pi-ai block and refuses direct credentials', async () => {
    const { syncDshProviderSettings } = await import('../dist/endpoints/dsh-setup.js')
    const source = '# source\n- id: llm-deepseek\n  config:\n    alias: *legacy\n- id: llm-pi-ai\n  config:\n    providers:\n      wb_lan:\n        apiKeyEnv: WB_LAN_API_KEY\n        headers:\n          Authorization: Bearer ${WB_LAN_API_KEY}\n        models:\n          - id: cn:deepseek-v4.1-flash\n          - id: target-model\n      other_route:\n        models:\n          - id: other-model\n- id: agent-default-model\n  config:\n    provider: do-not-copy\n    model: do-not-copy\n'
    const target = '# target\n- id: agent-default-model\n  config:\n    provider: wb_lan\n    model: target-model\n- insert:\n    - id: mcp-fixture\n      name: fixture\n'
    const choice = { provider: 'wb_lan', model: 'target-model' }
    const result = syncDshProviderSettings(target, source, 'web', choice)
    assert.ok(result.includes('wb_lan'))
    assert.ok(result.includes('mcp-fixture'))
    assert.ok(!result.includes('do-not-copy'))
    assert.equal(readDshNativeDefaults(result).model, 'target-model')
    assert.throws(() => syncDshProviderSettings(target, source, 'web', { provider: 'wb_lan', model: 'other-model' }), /缺少目标模型/)
    assert.throws(() => syncDshProviderSettings(target, source, 'web', { provider: 'other_route', model: 'target-model' }), /缺少目标模型/)
    assert.throws(() => syncDshProviderSettings(target, source.replace('apiKeyEnv: WB_LAN_API_KEY', 'apiKey: direct-secret'), 'web', choice), /直接凭据/)
    assert.throws(() => syncDshProviderSettings(target, source.replace('models:', 'models: !!js'), 'web', choice), /未复制/)
})
