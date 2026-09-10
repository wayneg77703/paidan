// native_preflight (src/endpoints/native-preflight.ts): fixture settings files
// in tmp dirs cover complete / missing-rules / broken-JSON / absent-file; e2e
// proves a submit warns (never refuses) and doctor reports the status.
// The real ~/.gemini tree is never touched.

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { test } from 'node:test'
import { checkNativePreflight } from '../dist/endpoints/native-preflight.js'

const execFileAsync = promisify(execFile)
const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const CLI = nodePath.join(repoRoot, 'dist', 'cli.js')

const RULES = ['read_file(*)', 'write_file(*)', 'command(*)']

async function settingsFile(root, content, name = 'settings.json') {
    const file = nodePath.join(root, name)
    if (content !== null) {
        await fs.mkdir(nodePath.dirname(file), { recursive: true })
        await fs.writeFile(file, content, 'utf8')
    }
    return file
}

test('complete settings -> ok', async () => {
    const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'paidan-preflight-'))
    try {
        const file = await settingsFile(root, JSON.stringify({ permissions: { allow: [...RULES, 'read_url(*)'] } }))
        const r = await checkNativePreflight({ file, require_allow: RULES })
        assert.equal(r.status, 'ok')
        assert.equal(r.file, nodePath.normalize(file))
    } finally {
        await fs.rm(root, { recursive: true, force: true })
    }
})

test('missing rules are named; absent permissions section counts as all-missing', async () => {
    const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'paidan-preflight-'))
    try {
        const partial = await settingsFile(root, JSON.stringify({ permissions: { allow: ['read_file(*)'] } }))
        const r = await checkNativePreflight({ file: partial, require_allow: RULES })
        assert.equal(r.status, 'missing')
        assert.deepEqual(r.missing, ['write_file(*)', 'command(*)'])

        const noPerms = await settingsFile(root, JSON.stringify({ model: 'x' }))
        const r2 = await checkNativePreflight({ file: noPerms, require_allow: RULES })
        assert.equal(r2.status, 'missing')
        assert.deepEqual(r2.missing, RULES)
    } finally {
        await fs.rm(root, { recursive: true, force: true })
    }
})

test('broken JSON / absent file / unexpandable template -> unreadable, never a throw', async () => {
    const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'paidan-preflight-'))
    try {
        const broken = await settingsFile(root, '{not json')
        assert.equal((await checkNativePreflight({ file: broken, require_allow: RULES })).status, 'unreadable')

        const absent = await settingsFile(root, null, 'absent.json')
        const r = await checkNativePreflight({ file: absent, require_allow: RULES })
        assert.equal(r.status, 'unreadable')
        assert.match(r.detail, /does not exist/)

        const r2 = await checkNativePreflight({ file: '{env:PAIDAN_DEFINITELY_UNSET}/settings.json', require_allow: RULES }, {})
        assert.equal(r2.status, 'unreadable')
        assert.equal(r2.file, null)
    } finally {
        await fs.rm(root, { recursive: true, force: true })
    }
})

test('e2e: submit warns on missing native rules (still submits); doctor reports the status', async () => {
    const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'paidan-preflight-e2e-'))
    try {
        const endpointsDir = nodePath.join(root, 'endpoints')
        const work = nodePath.join(root, 'work')
        await fs.mkdir(endpointsDir, { recursive: true })
        await fs.mkdir(work, { recursive: true })
        // registry validation requires a {home}/{env:} template; ride PAIDAN_HOME
        const settings = await settingsFile(nodePath.join(root, 'home'), JSON.stringify({ permissions: { allow: ['read_file(*)'] } }))
        assert.ok(settings.endsWith('settings.json'))
        const fakeBin = nodePath.join(repoRoot, 'test', 'fixtures', 'fake-kimi.cjs')
        await fs.writeFile(nodePath.join(endpointsDir, 'fake-preflight.json'), JSON.stringify({
            schema_version: '1.0.0',
            name: 'fake-preflight',
            detect: { bin: fakeBin },
            command: { argv: ['{bin}', '-p', '{prompt}'], prompt_delivery: 'argv' },
            permission: {
                'fs.read': { status: 'supported' },
                'fs.write': { status: 'supported' },
                presets: { 'workspace-write': 'supported' },
            },
            parser: 'kimi-print',
            native_preflight: { file: '{env:PAIDAN_HOME}/settings.json', require_allow: RULES },
        }))
        const env = {
            ...process.env,
            PAIDAN_HOME: nodePath.join(root, 'home'),
            PAIDAN_DATA_DIR: nodePath.join(root, 'data'),
            PAIDAN_ENDPOINTS_DIR: endpointsDir,
        }
        // submit: soft warning, run still created
        const runOut = await execFileAsync(process.execPath, [
            CLI, 'run', '--endpoint', 'fake-preflight', '--cwd', work, '--task', 'x',
        ], { env, timeout: 60_000 })
        const run = JSON.parse(runOut.stdout.trim())
        assert.equal(run.ok, true, JSON.stringify(run))
        assert.ok(
            run.warnings.some((w) => w.includes('native preflight') && w.includes('write_file(*)') && w.includes('command(*)')),
            `warnings: ${JSON.stringify(run.warnings)}`,
        )
        const got = JSON.parse((await execFileAsync(process.execPath, [CLI, 'get', run.run_id, '--wait', '--timeout', '60'], { env, timeout: 60_000 })).stdout.trim())
        assert.equal(got.run.state, 'completed')

        // doctor: machine-readable status per endpoint
        const doctor = JSON.parse((await execFileAsync(process.execPath, [CLI, 'doctor'], { env, timeout: 60_000 })).stdout.trim())
        const entry = doctor.endpoints.find((e) => e.name === 'fake-preflight')
        assert.equal(entry.native_preflight.status, 'missing')
        assert.deepEqual(entry.native_preflight.missing, ['write_file(*)', 'command(*)'])
    } finally {
        await fs.rm(root, { recursive: true, force: true })
    }
})
