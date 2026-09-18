// init wizard logic (engine/init-plan.ts) + CLI shell behavior:
// non-TTY refusal envelope and --yes non-interactive mode (isolated PAIDAN_HOME).
// NOTE: this file also carries CLI-level integration cases (init --yes writes
// config.json, skill install into fixture hosts) — keep them here as the
// wizard's regression net.

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { test } from 'node:test'
import { buildInitConfig, defaultInitAnswers, initConfigToJson, mergeInitConfig, planEndpointDefaultQuestions, parseMultiSelect } from '../dist/engine/init-plan.js'

const execFileAsync = promisify(execFile)
const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const CLI = nodePath.join(repoRoot, 'dist', 'cli.js')

async function initEnv(root) {
    const endpointsDir = nodePath.join(root, 'endpoints')
    await fs.mkdir(endpointsDir, { recursive: true })
    // Detection/version checks use Node itself, never agents installed on the host.
    await fs.writeFile(nodePath.join(endpointsDir, 'fake-init.json'), JSON.stringify({
        schema_version: '1.0.0',
        name: 'fake-init',
        detect: { bin: process.execPath, version_args: ['--version'] },
        command: { argv: ['{bin}', '-p', '{prompt}'], prompt_delivery: 'argv' },
        permission: { presets: { 'workspace-write': 'supported' } },
        parser: 'kimi-print',
    }))
    return {
        ...process.env,
        PAIDAN_HOME: nodePath.join(root, 'home'),
        PAIDAN_DATA_DIR: nodePath.join(root, 'data'),
        PAIDAN_HOST_HOME: nodePath.join(root, 'hosts'),
        PAIDAN_ENDPOINTS_DIR: endpointsDir,
    }
}

const INFO = [
    { name: 'claude-code', detected: true, version: '2.1.260', models: [], effort_options: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { name: 'codex', detected: true, version: '0.153.3', models: [{ alias: 'gpt-5', connection: 'chatgpt-login' }] },
    { name: 'kimi-code', detected: true, version: '0.42.0', models: [{ alias: 'kimi-for-coding/k3', connection: 'kimi-for-coding' }] },
    { name: 'zcode', detected: false, version: null, models: [] },
]

test('buildInitConfig: per-endpoint efforts are validated against declared options', () => {
    // valid: declared endpoint + listed option
    const ok = buildInitConfig(INFO, {
        enabled: ['claude-code', 'codex'],
        default_endpoint: 'codex',
        models: { codex: 'gpt-5' },
        efforts: { 'claude-code': 'high' },
        skill_hosts: [],
    })
    assert.deepEqual(ok.defaults.efforts, { 'claude-code': 'high' })
    // not enabled -> rejected
    assert.throws(
        () => buildInitConfig(INFO, { enabled: ['codex'], default_endpoint: 'codex', efforts: { 'claude-code': 'high' } }),
        /not enabled/,
    )
    // endpoint without declared options -> rejected
    assert.throws(
        () => buildInitConfig(INFO, { enabled: ['codex'], default_endpoint: 'codex', efforts: { codex: 'high' } }),
        /has no effort selection/,
    )
    // value outside options -> rejected
    assert.throws(
        () => buildInitConfig(INFO, { enabled: ['claude-code'], default_endpoint: 'claude-code', efforts: { 'claude-code': 'ultra' } }),
        /not one of claude-code's options/,
    )
    // native default (null entry) passes and emits nothing
    const native = buildInitConfig(INFO, {
        enabled: ['claude-code'],
        default_endpoint: 'claude-code',
        efforts: { 'claude-code': null },
        skill_hosts: [],
    })
    assert.deepEqual(native.defaults.efforts, {})
})

test('model questions: native first choice, single candidate still asked, keep-current for out-of-lineup values', () => {
    const config = { dataDir: null, endpoints: { enabled: null, overrides: {} }, defaults: { endpoint: null, models: {}, efforts: {}, modes: {}, selection_contexts: {}, run_timeout_sec: null }, ttlDays: 30 }
    // multi-candidate: native first, configured-in-lineup value preselects
    const multi = planEndpointDefaultQuestions(
        { name: 'kimi-code', detected: true, version: null, models: [{ alias: 'kimi-code/k3', connection: null }, { alias: 'kimi-code/k3-256k', connection: null }], model_selectable: true, native: { model: 'kimi-code/k3', effort: null } },
        config,
    )
    assert.equal(multi.model.kind, 'ask')
    assert.deepEqual(multi.model.options, ['(native default, currently kimi-code/k3)', 'kimi-code/k3', 'kimi-code/k3-256k'])
    assert.equal(multi.model.fallback, '(native default, currently kimi-code/k3)')
    // single candidate: still asked (no auto-pick — an auto-pick is a silent native override)
    const single = planEndpointDefaultQuestions(
        { name: 'codex', detected: true, version: null, models: [{ alias: 'gpt-6-astra', connection: null }], model_selectable: true, native: null },
        config,
    )
    assert.equal(single.model.kind, 'ask')
    assert.equal(single.model.options[0], '(native default)')
    // configured value outside the lineup: keep-current entry, not a silent drop
    const stale = planEndpointDefaultQuestions(
        { name: 'kimi-code', detected: true, version: null, models: [{ alias: 'kimi-code/k3', connection: null }], model_selectable: true, native: null },
        { ...config, defaults: { ...config.defaults, models: { 'kimi-code': 'kimi-code/k4-secret' } } },
    )
    assert.equal(stale.model.kind, 'ask')
    assert.equal(stale.model.staleModelValue, 'kimi-code/k4-secret')
    assert.ok(stale.model.options.includes('(keep current: kimi-code/k4-secret)'))
    // buildInitConfig admits the kept current value with the config passed
    const cfg = buildInitConfig(
        [{ name: 'kimi-code', detected: true, version: null, models: [{ alias: 'kimi-code/k3', connection: null }], model_selectable: true }],
        { enabled: ['kimi-code'], default_endpoint: 'kimi-code', models: { 'kimi-code': 'kimi-code/k4-secret' }, skill_hosts: [] },
        { ...config, defaults: { ...config.defaults, models: { 'kimi-code': 'kimi-code/k4-secret' } } },
    )
    assert.equal(cfg.defaults.models['kimi-code'], 'kimi-code/k4-secret')
})

test('--yes defaults: enable detected only, default = first detected; models stay native (no override layer)', () => {
    const answers = defaultInitAnswers(INFO)
    assert.deepEqual(answers.enabled, ['claude-code', 'codex', 'kimi-code'])
    assert.equal(answers.default_endpoint, 'claude-code')
    // pure reuse: --yes never writes default models — the endpoints' native
    // homes carry them; a paidan-side first-discovered default silently
    // changes native behavior
    assert.deepEqual(answers.models, {})
    assert.deepEqual(answers.skill_hosts, [])
    const cfg = buildInitConfig(INFO, answers)
    assert.deepEqual(cfg.endpoints.enabled, ['claude-code', 'codex', 'kimi-code'])
    const json = initConfigToJson(cfg)
    assert.deepEqual(json, {
        endpoints: { enabled: ['claude-code', 'codex', 'kimi-code'] },
        defaults: { endpoint: 'claude-code' },
    })
})

test('--yes --effort <level>: applied only to endpoints whose declared options include it', () => {
    const answers = defaultInitAnswers(INFO, [], 'high')
    assert.deepEqual(answers.models, {})
    // claude-code declares low..max -> applied; codex/kimi-code declare nothing -> stay native
    assert.deepEqual(answers.efforts, { 'claude-code': 'high' })
    // a level no endpoint carries applies nowhere (honest no-op, reported by the CLI shell)
    const none = defaultInitAnswers(INFO, [], 'ultra')
    assert.deepEqual(none.efforts, {})
    const cfg = buildInitConfig(INFO, answers)
    assert.deepEqual(cfg.defaults.efforts, { 'claude-code': 'high' })
})

test('--yes --hosts <names>: the skill installs into exactly that subset (an agent-collected answer must be faithful)', () => {
    const detected = ['kimi-code', 'codex', 'zcode']
    const answers = defaultInitAnswers(INFO, detected, undefined, ['kimi-code', 'zcode'])
    assert.deepEqual(answers.skill_hosts, ['kimi-code', 'zcode'])
    // No filter selects all detected hosts; installation choices never become config fields.
    const all = defaultInitAnswers(INFO, detected)
    assert.deepEqual(all.skill_hosts, detected)
    const json = initConfigToJson(buildInitConfig(INFO, all))
    assert.ok(!('skill_hosts' in json) && !('skills' in json))
})

test('buildInitConfig rejects impossible answers', () => {
    for (const name of ['nope', 'zcode']) {
        assert.throws(() => buildInitConfig(INFO, { enabled: [name], default_endpoint: null }), /not detected/)
    }
    assert.throws(() => buildInitConfig(INFO, { enabled: ['codex'], default_endpoint: 'kimi-code' }), /not enabled/)
    // per-endpoint models: must target an enabled, headless-selectable endpoint and its own aliases
    assert.throws(
        () => buildInitConfig(INFO, { enabled: ['codex'], default_endpoint: 'codex', models: { 'kimi-code': 'k3' } }),
        /not enabled/,
    )
    assert.throws(
        () => buildInitConfig(INFO, { enabled: ['codex'], default_endpoint: 'codex', models: { codex: 'kimi-for-coding/k3' } }),
        /not a discovered alias of codex/,
    )
    // endpoints with no headless model selection reject a default model outright
    const withZcode = INFO.map((e) => (e.name === 'zcode' ? { ...e, detected: true, model_selectable: false, models: [{ alias: 'glm-x', connection: null }] } : e))
    assert.throws(
        () => buildInitConfig(withZcode, { enabled: ['zcode'], default_endpoint: 'zcode', models: { zcode: 'glm-x' } }),
        /no headless model selection/,
    )
    // the wizard never writes the global defaults.model (it would poison endpoints
    // with no headless model selection); per-endpoint models only
    const noGlobal = buildInitConfig(INFO, { enabled: ['codex'], default_endpoint: 'codex', models: { codex: 'gpt-5' }, skill_hosts: [] })
    assert.ok(!('model' in noGlobal.defaults))
    // null entries mean "native default" and pass validation
    const cfg = buildInitConfig(INFO, {
        enabled: ['codex', 'kimi-code'],
        default_endpoint: 'codex',
        models: { codex: 'gpt-5', 'kimi-code': null },
        skill_hosts: [],
    })
    assert.deepEqual(cfg.defaults.models, { codex: 'gpt-5' })
})

test('nothing detected -> empty enabled, null defaults, valid config', () => {
    const answers = defaultInitAnswers(INFO.map((e) => ({ ...e, detected: false })))
    const json = initConfigToJson(buildInitConfig(INFO, answers))
    assert.deepEqual(json, { endpoints: { enabled: [] } })
})

test('CLI init on a non-TTY refuses interaction and prints state JSON', async () => {
    const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'paidan-init-'))
    try {
        const env = await initEnv(root)
        // one fixture host is "installed" (its skills dir exists)
        await fs.mkdir(nodePath.join(root, 'hosts', '.kimi-code', 'skills'), { recursive: true })
        // execFile pipes stdin -> not a TTY
        const err = await execFileAsync(process.execPath, [CLI, 'init'], { env, timeout: 60_000 }).catch((e) => e)
        assert.equal(err.code, 1)
        const envelope = JSON.parse(err.stdout.trim())
        assert.equal(envelope.ok, false)
        assert.equal(envelope.error.code, 'INIT_INTERACTIVE_REQUIRED')
        assert.ok(Array.isArray(envelope.state.endpoints))
        assert.equal(envelope.state.config_exists, false)
        // host skill state rides the envelope
        const hosts = envelope.state.hosts
        assert.ok(Array.isArray(hosts))
        assert.equal(hosts.find((h) => h.name === 'kimi-code')?.detected, true)
        assert.equal(hosts.find((h) => h.name === 'zcode')?.detected, false)
        // nothing written
        assert.equal(existsSync(envelope.state.config_path), false)
    } finally {
        await fs.rm(root, { recursive: true, force: true })
    }
})

test('CLI init --yes writes config.json with detected endpoints and defaults', async () => {
    const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'paidan-init-'))
    try {
        const hostHome = nodePath.join(root, 'hosts')
        await fs.mkdir(nodePath.join(hostHome, '.kimi-code', 'skills'), { recursive: true })
        const env = await initEnv(root)
        const { stdout } = await execFileAsync(process.execPath, [CLI, 'init', '--yes'], { env, timeout: 120_000 })
        const envelope = JSON.parse(stdout.trim())
        assert.equal(envelope.ok, true)
        assert.equal(envelope.written, true)
        const configPath = nodePath.join(root, 'home', 'config.json')
        const cfg = JSON.parse(await fs.readFile(configPath, 'utf8'))
        assert.deepEqual(cfg.endpoints.enabled, ['fake-init'])
        assert.equal(cfg.defaults.endpoint, 'fake-init')
        assert.equal(cfg.defaults.endpoint, envelope.defaults.endpoint)
        // --yes installs the skill into every detected host (fixture home only)
        assert.ok(Array.isArray(envelope.skills))
        assert.deepEqual(envelope.skills.map((s) => [s.host, s.status]), [['kimi-code', 'created']])
        const installed = nodePath.join(hostHome, '.kimi-code', 'skills', 'paidan', 'SKILL.md')
        const source = await fs.readFile(nodePath.join(repoRoot, 'skills', 'paidan', 'variants', 'kimi-code.SKILL.md'), 'utf8')
        assert.equal(await fs.readFile(installed, 'utf8'), source)
        // User edits survive re-init; the installed skill remains unchanged.
        cfg.endpoints.overrides = { dsh: { bin: 'C:/custom/dsh/bin.js' } }
        await fs.writeFile(configPath, JSON.stringify(cfg))
        const again = JSON.parse((await execFileAsync(process.execPath, [CLI, 'init', '--yes'], { env, timeout: 120_000 })).stdout)
        assert.deepEqual(again.skills.map((s) => [s.host, s.status]), [['kimi-code', 'unchanged']])
        assert.deepEqual(JSON.parse(await fs.readFile(configPath, 'utf8')).endpoints.overrides, cfg.endpoints.overrides)
        // the written config must load cleanly through the real loader
        const doctor = JSON.parse((await execFileAsync(process.execPath, [CLI, 'doctor'], { env, timeout: 60_000 })).stdout)
        assert.equal(doctor.ok, true)
    } finally {
        await fs.rm(root, { recursive: true, force: true })
    }
})

test('mergeInitConfig preserves machine-local keys across re-init', () => {
    const existing = {
        endpoints: { enabled: ['kimi-code'], overrides: { zcode: { bin: 'E:/custom/zcode.cjs' } } },
        defaults: { endpoint: 'kimi-code', run_timeout_sec: 600 },
        run_timeout_sec: 600,
    }
    const merged = mergeInitConfig(existing, {
        endpoints: { enabled: ['kimi-code', 'codex'] },
        defaults: { endpoint: 'codex', models: { codex: 'gpt-5.3-codex-spark' }, efforts: {} },
    })
    assert.deepEqual(merged.endpoints.enabled, ['kimi-code', 'codex'])
    assert.deepEqual(merged.endpoints.overrides, { zcode: { bin: 'E:/custom/zcode.cjs' } })
    // wizard-owned defaults keys are replaced, machine-local keys inside defaults survive
    assert.deepEqual(merged.defaults, { endpoint: 'codex', models: { codex: 'gpt-5.3-codex-spark' }, run_timeout_sec: 600 })
    assert.equal(merged.run_timeout_sec, 600)
})

test('mergeInitConfig clears stale wizard-owned defaults and replaces models wholesale', () => {
    const existing = {
        endpoints: { enabled: ['codex', 'kimi-code'] },
        defaults: { endpoint: 'codex', models: { codex: 'gpt-5', 'kimi-code': 'k3' }, efforts: { codex: 'high' }, run_timeout_sec: 900 },
    }
    // re-init: default moves to claude-code (no discovered models -> no model keys),
    // kimi-code disabled -> its models entry must not survive
    const merged = mergeInitConfig(existing, {
        endpoints: { enabled: ['codex', 'claude-code'] },
        defaults: { endpoint: 'claude-code', models: { codex: 'gpt-6' } },
    })
    assert.deepEqual(merged.defaults, { endpoint: 'claude-code', models: { codex: 'gpt-6' }, run_timeout_sec: 900 })
    // nothing enabled at all -> wizard keys cleared, machine keys kept, empty defaults dropped
    const cleared = mergeInitConfig(existing, { endpoints: { enabled: [] }, defaults: { endpoint: null, model: null, models: {} } })
    assert.deepEqual(cleared.defaults, { run_timeout_sec: 900 })
    const clearedAll = mergeInitConfig(
        { endpoints: { enabled: ['codex'] }, defaults: { endpoint: 'codex', model: 'gpt-5' } },
        { endpoints: { enabled: [] }, defaults: { endpoint: null, model: null, models: {} } },
    )
    assert.ok(!('defaults' in clearedAll))
})

test('parseMultiSelect: empty=fallback, all/none, numbers with dedupe+sort, invalid rejected', () => {
    assert.deepEqual(parseMultiSelect('', 3, [0, 2]), [0, 2])
    assert.deepEqual(parseMultiSelect('all', 3, []), [0, 1, 2])
    assert.deepEqual(parseMultiSelect('A', 3, []), [0, 1, 2])
    assert.deepEqual(parseMultiSelect('none', 3, [0]), [])
    assert.deepEqual(parseMultiSelect('n', 3, [0]), [])
    assert.deepEqual(parseMultiSelect('3 1 3', 3, []), [0, 2])
    assert.deepEqual(parseMultiSelect('2, 3', 3, []), [1, 2])
    assert.throws(() => parseMultiSelect('4', 3, []), /invalid selection/)
    assert.throws(() => parseMultiSelect('x', 3, []), /invalid selection/)
})
