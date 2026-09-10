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
import { buildInitConfig, defaultInitAnswers, initConfigToJson } from '../dist/engine/init-plan.js'

const execFileAsync = promisify(execFile)
const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const CLI = nodePath.join(repoRoot, 'dist', 'cli.js')

const INFO = [
    { name: 'claude-code', detected: true, version: '2.1.260', models: [], effort_options: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { name: 'codex', detected: true, version: '0.153.3', models: [{ alias: 'gpt-5', connection: 'chatgpt-login' }] },
    { name: 'kimi-code', detected: true, version: '0.42.0', models: [{ alias: 'kimi-for-coding/k3', connection: 'kimi-for-coding' }] },
    { name: 'zcode', detected: false, version: null, models: [] },
]

test('buildInitConfig: per-endpoint efforts are validated against declared options', async () => {
    const { mergeInitConfig } = await import('../dist/engine/init-plan.js')
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
    // merge: global effort survives (not wizard-owned), per-endpoint efforts are cleared
    const merged = mergeInitConfig(
        { endpoints: { enabled: ['claude-code'] }, defaults: { endpoint: 'claude-code', effort: 'high', efforts: { 'claude-code': 'max' }, run_timeout_sec: 900 } },
        { endpoints: { enabled: ['claude-code'] }, defaults: { endpoint: 'claude-code', model: null, models: {}, efforts: {} } },
    )
    assert.deepEqual(merged.defaults, { endpoint: 'claude-code', effort: 'high', run_timeout_sec: 900 })
})

test('--yes defaults: enable detected only, default = first detected; models stay native (no override layer)', () => {
    const answers = defaultInitAnswers(INFO)
    assert.deepEqual(answers.enabled, ['claude-code', 'codex', 'kimi-code'])
    assert.equal(answers.default_endpoint, 'claude-code')
    // pure reuse: --yes never writes default models — the endpoints' native
    // homes carry them; a paidan-side first-discovered default silently
    // changes native behavior
    assert.deepEqual(answers.models, {})
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

test('buildInitConfig rejects impossible answers', () => {
    assert.throws(() => buildInitConfig(INFO, { enabled: ['nope'], default_endpoint: null }), /not detected/)
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
        const env = { ...process.env, PAIDAN_HOME: nodePath.join(root, 'home'), PAIDAN_DATA_DIR: nodePath.join(root, 'data'), PAIDAN_HOST_HOME: nodePath.join(root, 'hosts') }
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
        const env = { ...process.env, PAIDAN_HOME: nodePath.join(root, 'home'), PAIDAN_DATA_DIR: nodePath.join(root, 'data'), PAIDAN_HOST_HOME: hostHome }
        const { stdout } = await execFileAsync(process.execPath, [CLI, 'init', '--yes'], { env, timeout: 120_000 })
        const envelope = JSON.parse(stdout.trim())
        assert.equal(envelope.ok, true)
        assert.equal(envelope.written, true)
        const configPath = nodePath.join(root, 'home', 'config.json')
        const cfg = JSON.parse(await fs.readFile(configPath, 'utf8'))
        assert.ok(Array.isArray(cfg.endpoints.enabled))
        assert.ok(cfg.endpoints.enabled.length > 0)
        assert.ok(cfg.endpoints.enabled.includes('kimi-code'))
        assert.equal(cfg.defaults.endpoint, envelope.defaults.endpoint)
        // --yes installs the skill into every detected host (fixture home only)
        assert.ok(Array.isArray(envelope.skills))
        assert.deepEqual(envelope.skills.map((s) => [s.host, s.status]), [['kimi-code', 'created']])
        const installed = nodePath.join(hostHome, '.kimi-code', 'skills', 'paidan', 'SKILL.md')
        const source = await fs.readFile(nodePath.join(repoRoot, 'skills', 'paidan', 'SKILL.md'), 'utf8')
        assert.equal(await fs.readFile(installed, 'utf8'), source)
        // a second --yes run is idempotent: unchanged, not duplicated
        const again = JSON.parse((await execFileAsync(process.execPath, [CLI, 'init', '--yes'], { env, timeout: 120_000 })).stdout)
        assert.deepEqual(again.skills.map((s) => [s.host, s.status]), [['kimi-code', 'unchanged']])
        // the written config must load cleanly through the real loader
        const doctor = JSON.parse((await execFileAsync(process.execPath, [CLI, 'doctor'], { env, timeout: 60_000 })).stdout)
        assert.equal(doctor.ok, true)
    } finally {
        await fs.rm(root, { recursive: true, force: true })
    }
})

test('--yes defaults install the skill into every detected host', () => {
    const answers = defaultInitAnswers(INFO, ['kimi-code', 'zcode'])
    assert.deepEqual(answers.skill_hosts, ['kimi-code', 'zcode'])
    // skill selection is an action, never persisted into config.json
    const json = initConfigToJson(buildInitConfig(INFO, answers))
    assert.ok(!('skill_hosts' in json) && !('skills' in json))
})

test('skill_hosts defaults to empty when no hosts are detected', () => {
    const answers = defaultInitAnswers(INFO)
    assert.deepEqual(answers.skill_hosts, [])
})

test('mergeInitConfig preserves machine-local keys across re-init', async () => {
    const { mergeInitConfig } = await import('../dist/engine/init-plan.js')
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

test('mergeInitConfig clears stale wizard-owned defaults and replaces models wholesale', async () => {
    const { mergeInitConfig } = await import('../dist/engine/init-plan.js')
    const existing = {
        endpoints: { enabled: ['codex', 'kimi-code'] },
        defaults: { endpoint: 'codex', model: 'gpt-5', models: { codex: 'gpt-5', 'kimi-code': 'k3' }, run_timeout_sec: 900 },
    }
    // re-init: default moves to claude-code (no discovered models -> no model keys),
    // kimi-code disabled -> its models entry must not survive
    const merged = mergeInitConfig(existing, {
        endpoints: { enabled: ['codex', 'claude-code'] },
        defaults: { endpoint: 'claude-code', model: null, models: { codex: 'gpt-6' } },
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

test('CLI init --yes twice preserves endpoints.overrides written between runs', async () => {
    const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'paidan-init-'))
    try {
        const hostHome = nodePath.join(root, 'hosts')
        await fs.mkdir(nodePath.join(hostHome, '.kimi-code', 'skills'), { recursive: true })
        const env = { ...process.env, PAIDAN_HOME: nodePath.join(root, 'home'), PAIDAN_DATA_DIR: nodePath.join(root, 'data'), PAIDAN_HOST_HOME: hostHome }
        const configPath = nodePath.join(root, 'home', 'config.json')
        await execFileAsync(process.execPath, [CLI, 'init', '--yes'], { env, timeout: 120_000 })
        // user hand-edits machine-local overrides in between
        const cfg1 = JSON.parse(await fs.readFile(configPath, 'utf8'))
        cfg1.endpoints.overrides = { dsh: { bin: 'C:/custom/dsh/bin.js' } }
        await fs.writeFile(configPath, JSON.stringify(cfg1, null, 2))
        await execFileAsync(process.execPath, [CLI, 'init', '--yes'], { env, timeout: 120_000 })
        const cfg2 = JSON.parse(await fs.readFile(configPath, 'utf8'))
        assert.deepEqual(cfg2.endpoints.overrides, { dsh: { bin: 'C:/custom/dsh/bin.js' } })
    } finally {
        await fs.rm(root, { recursive: true, force: true })
    }
})

test('buildInitConfig refuses to enable an endpoint that was not detected', () => {
    assert.throws(
        () => buildInitConfig(INFO, { enabled: ['zcode'], default_endpoint: null, skill_hosts: [] }),
        /not detected/,
    )
    // detected subset still validates
    const cfg = buildInitConfig(INFO, { enabled: ['codex'], default_endpoint: 'codex', skill_hosts: [] })
    assert.deepEqual(cfg.endpoints.enabled, ['codex'])
})

test('parseMultiSelect: empty=fallback, all/none, numbers with dedupe+sort, invalid rejected', async () => {
    const { parseMultiSelect } = await import('../dist/engine/init-plan.js')
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
