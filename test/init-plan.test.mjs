// init wizard logic (engine/init-plan.ts) + CLI shell behavior:
// non-TTY refusal envelope and --yes non-interactive mode (isolated PAIDAN_HOME).

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
    { name: 'claude-code', detected: true, version: '2.1.260', models: [] },
    { name: 'codex', detected: true, version: '0.153.3', models: [{ alias: 'gpt-5', connection: 'chatgpt-login' }] },
    { name: 'kimi-code', detected: true, version: '0.42.0', models: [{ alias: 'kimi-for-coding/k3', connection: 'kimi-for-coding' }] },
    { name: 'zcode', detected: false, version: null, models: [] },
]

test('--yes defaults: enable detected only, default = first detected + its first model', () => {
    const answers = defaultInitAnswers(INFO)
    assert.deepEqual(answers.enabled, ['claude-code', 'codex', 'kimi-code'])
    assert.equal(answers.default_endpoint, 'claude-code')
    assert.equal(answers.default_model, null) // claude has no discovered models
    const cfg = buildInitConfig(INFO, answers)
    assert.deepEqual(cfg.endpoints.enabled, ['claude-code', 'codex', 'kimi-code'])
    const json = initConfigToJson(cfg)
    assert.deepEqual(json, { endpoints: { enabled: ['claude-code', 'codex', 'kimi-code'] }, defaults: { endpoint: 'claude-code' } })
})

test('buildInitConfig rejects impossible answers', () => {
    assert.throws(() => buildInitConfig(INFO, { enabled: ['nope'], default_endpoint: null, default_model: null }), /unknown endpoint/)
    assert.throws(() => buildInitConfig(INFO, { enabled: ['codex'], default_endpoint: 'kimi-code', default_model: null }), /not enabled/)
    assert.throws(
        () => buildInitConfig(INFO, { enabled: ['codex'], default_endpoint: 'codex', default_model: 'not-a-model' }),
        /not a discovered alias/,
    )
})

test('nothing detected -> empty enabled, null defaults, valid config', () => {
    const answers = defaultInitAnswers(INFO.map((e) => ({ ...e, detected: false })))
    const json = initConfigToJson(buildInitConfig(INFO, answers))
    assert.deepEqual(json, { endpoints: { enabled: [] } })
})

test('CLI init on a non-TTY refuses interaction and prints state JSON', async () => {
    const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'paidan-init-'))
    try {
        const env = { ...process.env, PAIDAN_HOME: nodePath.join(root, 'home'), PAIDAN_DATA_DIR: nodePath.join(root, 'data') }
        // execFile pipes stdin -> not a TTY
        const err = await execFileAsync(process.execPath, [CLI, 'init'], { env, timeout: 60_000 }).catch((e) => e)
        assert.equal(err.code, 1)
        const envelope = JSON.parse(err.stdout.trim())
        assert.equal(envelope.ok, false)
        assert.equal(envelope.error.code, 'INIT_INTERACTIVE_REQUIRED')
        assert.ok(Array.isArray(envelope.state.endpoints))
        assert.equal(envelope.state.config_exists, false)
        // nothing written
        assert.equal(existsSync(envelope.state.config_path), false)
    } finally {
        await fs.rm(root, { recursive: true, force: true })
    }
})

test('CLI init --yes writes config.json with detected endpoints and defaults', async () => {
    const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'paidan-init-'))
    try {
        const env = { ...process.env, PAIDAN_HOME: nodePath.join(root, 'home'), PAIDAN_DATA_DIR: nodePath.join(root, 'data') }
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
        // the written config must load cleanly through the real loader
        const doctor = JSON.parse((await execFileAsync(process.execPath, [CLI, 'doctor'], { env, timeout: 60_000 })).stdout)
        assert.equal(doctor.ok, true)
    } finally {
        await fs.rm(root, { recursive: true, force: true })
    }
})
