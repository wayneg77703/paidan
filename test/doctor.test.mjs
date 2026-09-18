// Agent-guided setup: diagnostic feedback and standalone skill locations,
// without running init or touching any real native home/configuration.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { test } from 'node:test'

const exec = promisify(execFile)
const repo = fileURLToPath(new URL('..', import.meta.url))

test('doctor supports direct configuration and skill installation without rewriting defaults', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paidan-doctor-'))
    try {
        const home = path.join(root, 'home')
        const nativeHome = path.join(root, 'native')
        const endpoints = path.join(root, 'endpoints')
        await fs.mkdir(home)
        await fs.mkdir(path.join(nativeHome, '.kimi-code'), { recursive: true })
        await fs.mkdir(endpoints)
        await fs.writeFile(path.join(endpoints, 'fake.json'), JSON.stringify({
            schema_version: '1.0.0', name: 'fake',
            detect: { bin: process.execPath, version_args: ['--version'] },
            command: { argv: ['{bin}', '-p', '{prompt}'], prompt_delivery: 'argv' },
            permission: { presets: { 'workspace-write': 'supported' } },
            parser: 'kimi-print',
        }))
        const configFile = path.join(home, 'config.json')
        const config = {
            endpoints: { enabled: ['fake'], overrides: { fake: { bin: process.execPath } } },
            defaults: { endpoint: 'fake', models: {}, efforts: {}, run_timeout_sec: 42 },
            ttlDays: 9,
        }
        const env = {
            ...process.env, PAIDAN_HOME: home, PAIDAN_DATA_DIR: path.join(root, 'data'),
            PAIDAN_ENDPOINTS_DIR: endpoints, PAIDAN_HOST_HOME: nativeHome,
            USERPROFILE: nativeHome, HOME: nativeHome,
        }
        const doctor = async () => JSON.parse((await exec(process.execPath,
            [path.join(repo, 'dist', 'cli.js'), 'doctor'], { env, timeout: 15_000 })).stdout)
        await fs.writeFile(configFile, JSON.stringify(config))
        const before = await fs.readFile(configFile, 'utf8')
        const result = await doctor()
        assert.equal(result.ok, true)
        assert.equal(result.data_dir, env.PAIDAN_DATA_DIR)
        assert.equal(result.usage_db.ok, true)
        const ep = result.endpoints[0]
        assert.equal(ep.spawn_supported, true)
        assert.equal(ep.resolved_from, 'config-override')
        assert.equal(ep.model_selectable, false)
        assert.deepEqual(ep.configured_defaults, { model: null, effort: null, mode: null })
        assert.deepEqual(result.issues, [])
        const host = result.hosts.find((h) => h.name === 'kimi-code')
        assert.equal(host.detected, true)
        assert.equal(host.installed, false)
        assert.equal(host.source, path.join(repo, 'skills', 'paidan', 'variants', 'kimi-code.SKILL.md'))
        assert.equal(host.target, path.join(nativeHome, '.kimi-code', 'skills', 'paidan', 'SKILL.md'))
        // The installation guide's independent copy needs no init/config rewrite.
        await fs.mkdir(path.dirname(host.target), { recursive: true })
        await fs.copyFile(host.source, host.target)
        const afterCopy = await doctor()
        assert.equal(afterCopy.hosts.find((h) => h.name === host.name).installed, true)
        assert.deepEqual(await fs.readFile(host.target), await fs.readFile(host.source))
        assert.equal(await fs.readFile(configFile, 'utf8'), before)

        config.endpoints.enabled = ['typo']
        config.endpoints.overrides.fake.bin = nativeHome // directory, not a file
        config.defaults.models.fake = 'a-model'
        config.defaults.efforts.fake = 'high'
        await fs.writeFile(configFile, JSON.stringify(config))
        const bad = await doctor()
        assert.equal(bad.ok, true, 'diagnostic problems must remain inspectable')
        assert.equal(bad.endpoints[0].spawn_supported, false)
        assert.equal(bad.endpoints[0].bin_resolved, null)
        assert.match(bad.endpoints[0].repair_hint, /full path/)
        assert.ok(bad.issues.some((s) => s.includes('unknown endpoint "typo"')))
        assert.ok(bad.issues.some((s) => s.includes('not in endpoints.enabled')))
        assert.ok(bad.issues.some((s) => s.includes('defaults.models is unsupported')))
        assert.ok(bad.issues.some((s) => s.includes('defaults.efforts value "high" is unsupported')))
    } finally {
        assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()))
        await fs.rm(root, { recursive: true, force: true })
    }
})

test('doctor scopes version probes to selected endpoints while keeping the full survey optional', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paidan-doctor-scope-'))
    try {
        const endpoints = path.join(root, 'endpoints')
        await fs.mkdir(endpoints)
        const marker = path.join(root, 'unselected-was-probed')
        const otherBin = path.join(root, 'other.cjs')
        await fs.writeFile(otherBin, 'require("node:fs").writeFileSync(process.env.PAIDAN_DOCTOR_PROBE_MARKER,"probed"); console.log("1.0.0")')
        for (const name of ['fake', 'second', 'other']) {
            await fs.writeFile(path.join(endpoints, `${name}.json`), JSON.stringify({
                schema_version: '1.0.0', name,
                detect: { bin: name === 'other' ? otherBin : process.execPath, version_args: ['--version'] },
                command: { argv: ['{bin}', '{prompt}'], prompt_delivery: 'argv' },
                permission: { presets: { 'workspace-write': 'supported' } }, parser: 'kimi-print',
            }))
        }
        const env = {
            ...process.env, PAIDAN_HOME: path.join(root, 'home'), PAIDAN_DATA_DIR: path.join(root, 'data'),
            PAIDAN_ENDPOINTS_DIR: endpoints, PAIDAN_HOST_HOME: root, USERPROFILE: root, HOME: root,
            PAIDAN_DOCTOR_PROBE_MARKER: marker,
        }
        const doctor = async (...args) => {
            try {
                return JSON.parse((await exec(process.execPath,
                    [path.join(repo, 'dist', 'cli.js'), 'doctor', ...args], { env, timeout: 15_000 })).stdout)
            } catch (err) {
                if (err.stdout) return JSON.parse(err.stdout)
                throw err
            }
        }
        const selected = await doctor('--endpoint', 'fake', '--endpoint', 'second', '--endpoint', 'fake')
        assert.deepEqual(selected.endpoints.map((e) => e.name), ['fake', 'second'])
        assert.ok(selected.config_path)
        assert.ok(Array.isArray(selected.hosts))
        assert.equal(await fs.stat(marker).then(() => true, () => false), false)
        assert.equal((await doctor('--endpoint', 'missing')).error.code, 'ENDPOINT_UNKNOWN')
        assert.equal((await doctor('--bogus')).error.code, 'ARGS_INVALID')
        assert.equal(await fs.stat(marker).then(() => true, () => false), false)
        const all = await doctor()
        assert.deepEqual(all.endpoints.map((e) => e.name), ['fake', 'other', 'second'])
        assert.equal(await fs.readFile(marker, 'utf8'), 'probed')
    } finally {
        assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()))
        await fs.rm(root, { recursive: true, force: true })
    }
})
