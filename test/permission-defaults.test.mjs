import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../dist/engine/config.js'
import { EndpointRegistry, validateManifest } from '../dist/endpoints/registry.js'
import { buildArgs, buildEnv, checkPermission, resolvePermissionMode } from '../dist/endpoints/invocation.js'
import { waitForWorkerExit } from './helpers/worker.mjs'

const repo = fileURLToPath(new URL('..', import.meta.url))
const exec = promisify(execFile)
const registry = await EndpointRegistry.load(path.join(repo, 'endpoints'))
const request = (endpoint, mode, resume_session = null) => ({
    endpoint, mode, resume_session, model: null, effort: null, cwd: process.cwd(), add_dirs: [], task_text: 'fixture',
})
async function temporary(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paidan-permissions-'))
    t.after(async () => {
        assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()))
        await fs.rm(root, { recursive: true, force: true })
    })
    return root
}

test('endpoint defaults retain existing tiers, with ZCode yolo rather than unsupported workspace-write', () => {
    for (const manifest of registry.list()) {
        const mode = resolvePermissionMode(manifest)
        assert.equal(mode, manifest.name === 'zcode' ? 'unattended' : 'workspace-write')
        assert.equal(checkPermission(manifest, mode).ok, true, manifest.name)
    }
    const zcode = registry.get('zcode')
    assert.equal(resolvePermissionMode(zcode, 'read-only'), 'read-only')
    assert.equal(checkPermission(zcode, resolvePermissionMode(zcode, 'read-only')).ok, false)
    assert.equal(resolvePermissionMode(zcode, 'read-only', 'unattended'), 'unattended')
    const broken = structuredClone(zcode)
    broken.permission.default_mode = 'workspace-write'
    assert.throws(() => validateManifest(broken, 'zcode.json'), /permission.default_mode/)
})

test('Codex and Claude do not inherit interactive approval requests on fresh or resumed calls', () => {
    for (const resume of [null, 'session_12345678']) {
        const codex = registry.get('codex')
        const c = buildArgs(codex, request('codex', resolvePermissionMode(codex), resume))
        assert.ok(c.includes('approval_policy="never"'))
        assert.ok(!c.includes('on-request'))
        const claude = registry.get('claude-code')
        const a = buildArgs(claude, request('claude-code', resolvePermissionMode(claude), resume))
        assert.equal(a[a.indexOf('--permission-prompts') + 1], 'none')
        assert.equal(a[a.indexOf('--permission-mode') + 1], 'acceptEdits')
        assert.ok(!a.includes('bypassPermissions'))
    }
})

test('DSH keeps native defaults, overrides only explicit read-only, and rejects unattended', () => {
    const dsh = registry.get('dsh')
    assert.deepEqual(buildEnv(dsh, {}, 'workspace-write').DSH_PERMISSION_MODE, undefined)
    assert.equal(buildEnv(dsh, { DSH_PERMISSION_MODE: 'read-only' }, 'workspace-write').DSH_PERMISSION_MODE, 'read-only')
    assert.equal(buildEnv(dsh, { DSH_PERMISSION_MODE: 'workspace-write' }, 'read-only').DSH_PERMISSION_MODE, 'read-only')
    const args = buildArgs(dsh, request('dsh', resolvePermissionMode(dsh)))
    assert.deepEqual(args, ['--profile', 'headless', 'fixture'])
    assert.equal(checkPermission(dsh, 'unattended').ok, false)
})

test('persistent permission defaults validate supported presets', async (t) => {
    const root = await temporary(t)
    const file = path.join(root, 'config.json')
    const existing = { defaults: { modes: { codex: 'read-only' }, models: { codex: 'old' } } }
    await fs.writeFile(file, JSON.stringify(existing))
    assert.deepEqual(loadConfig(file).defaults.modes, { codex: 'read-only' })
    for (const modes of [[], null, { codex: 'on-request' }, { codex: true }, JSON.parse('{"__proto__":"read-only"}')]) {
        await fs.writeFile(file, JSON.stringify({ defaults: { modes } }))
        assert.throws(() => loadConfig(file), /defaults.modes/)
    }
})

test('Claude read-only rejects before spawn even when native settings already allow Write and Bash', async (t) => {
    const root = await temporary(t)
    const endpoints = path.join(root, 'endpoints'), native = path.join(root, 'native')
    await fs.mkdir(endpoints)
    await fs.mkdir(native)
    const originalSettings = JSON.stringify({ permissions: { allow: ['Write', 'Edit', 'Bash(*)'] }, untouched: true })
    const settingsFile = path.join(native, 'settings.json')
    await fs.writeFile(settingsFile, originalSettings)
    const marker = path.join(root, 'endpoint-started')
    const bin = path.join(root, 'entry.cjs')
    await fs.writeFile(bin, `require('fs').writeFileSync(${JSON.stringify(marker)}, 'unexpected spawn')`)
    const manifest = structuredClone(registry.get('claude-code'))
    manifest.detect = { bin }
    await fs.writeFile(path.join(endpoints, 'claude-code.json'), JSON.stringify(manifest))
    const env = { ...process.env, PAIDAN_HOME: path.join(root, 'home'), PAIDAN_DATA_DIR: path.join(root, 'data'), PAIDAN_ENDPOINTS_DIR: endpoints, CLAUDE_CONFIG_DIR: native }
    const err = await exec(process.execPath, [path.join(repo, 'dist', 'cli.js'), 'run', '--endpoint', 'claude-code', '--mode', 'read-only', '--cwd', root, '--task', 'fixture'], { env }).catch(e => e)
    assert.equal(JSON.parse(err.stdout).error.code, 'PERMISSION_UNSUPPORTED')
    assert.equal(await fs.stat(marker).then(() => true, () => false), false)
    assert.equal(await fs.readFile(settingsFile, 'utf8'), originalSettings)
    assert.throws(() => buildArgs(manifest, request('claude-code', 'read-only')), /has no mode_args/)
})

test('CLI uses per-endpoint default without --mode, honors explicit override, and does not escalate invalid choices', async (t) => {
    const root = await temporary(t)
    const home = path.join(root, 'home'), endpoints = path.join(root, 'endpoints')
    await fs.mkdir(home)
    await fs.mkdir(endpoints)
    const bin = path.join(root, 'fake.cjs')
    await fs.writeFile(bin, 'console.log(JSON.stringify({role:"assistant",content:JSON.stringify(process.argv.slice(2))}))')
    const manifest = structuredClone(registry.get('zcode'))
    manifest.detect = { bin }
    manifest.parser = 'kimi-print'
    await fs.writeFile(path.join(endpoints, 'zcode.json'), JSON.stringify(manifest))
    const config = { endpoints: { enabled: ['zcode'] }, defaults: {} }
    const configFile = path.join(home, 'config.json')
    await fs.writeFile(configFile, JSON.stringify(config))
    const env = { ...process.env, PAIDAN_HOME: home, PAIDAN_DATA_DIR: path.join(root, 'data'), PAIDAN_ENDPOINTS_DIR: endpoints, PAIDAN_HOST_HOME: root, USERPROFILE: root, KIMI_CODE_HOME: root }
    const cli = async (...args) => {
        try { return JSON.parse((await exec(process.execPath, [path.join(repo, 'dist/cli.js'), ...args], { env, timeout: 20000 })).stdout) }
        catch (err) { if (err.stdout) return JSON.parse(err.stdout); throw err }
    }
    const first = await cli('run', '--endpoint', 'zcode', '--cwd', root, '--task', 'fixture')
    assert.equal(first.ok, true, JSON.stringify(first))
    const result = await cli('get', first.run_id, '--wait', '--timeout', '10')
    await waitForWorkerExit(env.PAIDAN_DATA_DIR, first.run_id)
    const delivered = JSON.parse(result.result.final_text)
    assert.equal(delivered[delivered.indexOf('--mode') + 1], 'yolo')
    const saved = JSON.parse(await fs.readFile(path.join(env.PAIDAN_DATA_DIR, 'runs', first.run_id, 'request.json'), 'utf8'))
    assert.equal(saved.mode, 'unattended')
    config.defaults.modes = { zcode: 'read-only' }
    await fs.writeFile(configFile, JSON.stringify(config))
    const rejected = await cli('run', '--endpoint', 'zcode', '--cwd', root, '--task', 'reject')
    assert.equal(rejected.error.code, 'PERMISSION_UNSUPPORTED')
    const doctor = await cli('doctor', '--endpoint', 'zcode')
    assert.equal(doctor.endpoints[0].permission.default_mode, 'read-only')
    assert.equal(doctor.endpoints[0].permission.default_mode_source, 'config')
    assert.ok(doctor.issues.some(s => s.includes('default permission mode')))
    const explicit = await cli('run', '--endpoint', 'zcode', '--mode', 'unattended', '--cwd', root, '--task', 'explicit')
    assert.equal(explicit.ok, true, JSON.stringify(explicit))
    await cli('get', explicit.run_id, '--wait', '--timeout', '10')
    await waitForWorkerExit(env.PAIDAN_DATA_DIR, explicit.run_id)
    const denied = await cli('run', '--endpoint', 'zcode', '--mode', 'workspace-write', '--cwd', root, '--task', 'reject-explicit')
    assert.equal(denied.error.code, 'PERMISSION_UNSUPPORTED')
})
