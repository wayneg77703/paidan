// Explicit capability-set mode (contracts §2, --capabilities): set parsing,
// checkPermission against the manifest map, fingerprint canonicalization,
// buildArgs tier-flag exclusion, and the CLI mutex/unsupported paths.

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { test } from 'node:test'
import { waitForWorkerExit } from './helpers/worker.mjs'
import { buildArgs, checkPermission, parseCapabilitySet } from '../dist/endpoints/registry.js'
import { canonicalMode } from '../dist/engine/types.js'
import { requestFingerprint } from '../dist/engine/run-store.js'

const execFileAsync = promisify(execFile)
const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const CLI = nodePath.join(repoRoot, 'dist', 'cli.js')

function manifestWith(permission) {
    return {
        schema_version: '1.0.0',
        name: 'fake',
        detect: { bin: 'fake' },
        command: { argv: ['{bin}', '-p', '{prompt}'], prompt_delivery: 'argv' },
        permission: { presets: { 'workspace-write': 'supported' }, ...permission },
        parser: 'kimi-print',
    }
}

test('parseCapabilitySet: true/options-object required, false dropped; junk rejected', () => {
    assert.deepEqual(parseCapabilitySet({ 'fs.write': true, 'shell.exec': false, 'fs.read': { roots: ['D:/w'] } }), {
        'fs.write': true,
        'shell.exec': false,
        'fs.read': { roots: ['D:/w'] },
    })
    for (const bad of [null, [], 'x', {}, { '': true }, { 'fs.read': 1 }, { 'fs.read': false }]) {
        assert.equal(parseCapabilitySet(bad), null, JSON.stringify(bad))
    }
})

test('checkPermission with an explicit set: unsupported names the missing cap; soft/unverified warn', () => {
    const m = manifestWith({
        'fs.read': { status: 'supported' },
        'fs.write': { status: 'soft', verified_at: '2026-09-10' },
        'shell.exec': { status: 'unsupported' },
    })
    const ok = checkPermission(m, { 'fs.read': true, 'fs.write': true })
    assert.equal(ok.ok, true)
    assert.deepEqual(ok.missing, [])
    assert.ok(ok.warnings.some((w) => w.includes('fs.write') && w.includes('soft')))

    const nope = checkPermission(m, { 'shell.exec': true, 'net.fetch': true })
    assert.equal(nope.ok, false)
    assert.deepEqual(nope.missing, ['shell.exec']) // undeclared net.fetch warns, not rejects
    assert.ok(nope.warnings.some((w) => w.includes('net.fetch') && w.includes('undeclared')))
})

test('canonicalMode is key-order independent; fingerprints match across orders', () => {
    const a = { 'fs.write': true, 'fs.read': { roots: ['D:/w', 'E:/x'] } }
    const b = { 'fs.read': { roots: ['D:/w', 'E:/x'] }, 'fs.write': true }
    assert.equal(canonicalMode(a), canonicalMode(b))
    assert.equal(
        requestFingerprint('fake', 'D:/w', 'task', a),
        requestFingerprint('fake', 'D:/w', 'task', b),
    )
    assert.notEqual(requestFingerprint('fake', 'D:/w', 'task', a), requestFingerprint('fake', 'D:/w', 'task', 'workspace-write'))
})

test('buildArgs with an explicit set splices no mode_args but keeps cwd_arg', () => {
    const m = {
        schema_version: '1.0.0',
        name: 'opencode',
        detect: { bin: 'opencode' },
        command: {
            argv: ['{bin}', '--format', 'json'],
            prompt_delivery: 'stdin',
            mode_args: {
                'read-only': ['run', '--agent', 'plan'],
                'workspace-write': ['run', '--agent', 'build'],
                unattended: ['run', '--agent', 'build', '--auto'],
            },
            cwd_arg: ['--dir', '{cwd}'],
        },
        permission: { presets: { 'workspace-write': 'supported' } },
        parser: 'opencode-run',
    }
    const req = {
        schema_version: '1.0.0',
        run_id: 'run_20260910_00000000',
        fingerprint: 'sha256:x',
        endpoint: 'opencode',
        cwd: 'D:/run/root',
        add_dirs: [],
        task_file: null,
        task_text: 'do it',
        mode: { 'fs.write': true },
        model: null,
        effort: null,
        resume_session: null,
        run_timeout_sec: 1800,
        deliverables: [],
        created_at: '2026-09-10T00:00:00.000Z',
        warnings: [],
    }
    // no tier -> no 'run --agent ...' subcommand; the cwd pin still lands
    assert.deepEqual(buildArgs(m, req), ['--dir', 'D:/run/root', '--format', 'json'])
})

test('e2e: --capabilities unsupported -> PERMISSION_UNSUPPORTED naming the cap; mutex with --mode', async () => {
    const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'paidan-capset-'))
    try {
        const endpointsDir = nodePath.join(root, 'endpoints')
        const work = nodePath.join(root, 'work')
        await fs.mkdir(endpointsDir, { recursive: true })
        await fs.mkdir(work, { recursive: true })
        const fakeBin = nodePath.join(repoRoot, 'test', 'fixtures', 'fake-kimi.cjs')
        await fs.writeFile(nodePath.join(endpointsDir, 'fake-caps.json'), JSON.stringify({
            schema_version: '1.0.0',
            name: 'fake-caps',
            detect: { bin: fakeBin },
            command: { argv: ['{bin}', '-p', '{prompt}'], prompt_delivery: 'argv' },
            permission: {
                'fs.read': { status: 'supported' },
                'fs.write': { status: 'supported' },
                'shell.exec': { status: 'unsupported' },
                presets: { 'workspace-write': 'supported' },
            },
            parser: 'kimi-print',
        }))
        const env = {
            ...process.env,
            PAIDAN_HOME: nodePath.join(root, 'home'),
            PAIDAN_DATA_DIR: nodePath.join(root, 'data'),
            PAIDAN_ENDPOINTS_DIR: endpointsDir,
        }
        const paidan = async (args) => {
            try {
                const { stdout } = await execFileAsync(process.execPath, [CLI, ...args], { env, timeout: 60_000 })
                return JSON.parse(stdout.trim())
            } catch (err) {
                if (err.stdout) return JSON.parse(err.stdout.trim())
                throw err
            }
        }
        const mutex = await paidan(['run', '--endpoint', 'fake-caps', '--cwd', work, '--task', 'x', '--mode', 'read-only', '--capabilities', '{"fs.read":true}'])
        assert.equal(mutex.ok, false)
        assert.equal(mutex.error.code, 'ARGS_INVALID')
        assert.match(mutex.error.message, /mutually exclusive/)

        const denied = await paidan(['run', '--endpoint', 'fake-caps', '--cwd', work, '--task', 'x', '--capabilities', '{"shell.exec":true}'])
        assert.equal(denied.ok, false)
        assert.equal(denied.error.code, 'PERMISSION_UNSUPPORTED')
        assert.match(denied.error.message, /shell\.exec/)

        const okRun = await paidan(['run', '--endpoint', 'fake-caps', '--cwd', work, '--task', 'x', '--capabilities', '{"fs.read":true,"fs.write":true}', '--deliverable', 'fake-deliverable.txt'])
        assert.equal(okRun.ok, true, JSON.stringify(okRun))
        const got = await paidan(['get', okRun.run_id, '--wait', '--timeout', '60'])
        await waitForWorkerExit(env.PAIDAN_DATA_DIR, okRun.run_id)
        assert.equal(got.run.state, 'completed', JSON.stringify(got))
        const req = JSON.parse(await fs.readFile(nodePath.join(root, 'data', 'runs', okRun.run_id, 'request.json'), 'utf8'))
        assert.deepEqual(req.mode, { 'fs.read': true, 'fs.write': true })
    } finally {
        await fs.rm(root, { recursive: true, force: true })
    }
})
