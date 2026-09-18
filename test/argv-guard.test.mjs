// argv prompt-length guard (contracts §6 command.prompt_max_bytes): over-limit
// submits are refused with TASK_TOO_LONG before a run exists; the manifest can
// override the 24000-byte default. Fully isolated tmp dirs; fake endpoints only.

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { test } from 'node:test'
import { measureArgvBytes, DEFAULT_PROMPT_MAX_BYTES } from '../dist/endpoints/invocation.js'
import { waitForWorkerExit } from './helpers/worker.mjs'

const execFileAsync = promisify(execFile)
const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const CLI = nodePath.join(repoRoot, 'dist', 'cli.js')

async function paidan(env, args) {
    try {
        const { stdout } = await execFileAsync(process.execPath, [CLI, ...args], { env, timeout: 60_000 })
        return JSON.parse(stdout.trim())
    } catch (err) {
        // error envelopes are JSON on stdout too; only the exit code is non-zero
        if (err.stdout) return JSON.parse(err.stdout.trim())
        throw err
    }
}

async function setup(root, commandExtra = {}) {
    const endpointsDir = nodePath.join(root, 'endpoints')
    const work = nodePath.join(root, 'work')
    await fs.mkdir(endpointsDir, { recursive: true })
    await fs.mkdir(work, { recursive: true })
    const fakeBin = nodePath.join(repoRoot, 'test', 'fixtures', 'fake-kimi.cjs')
    await fs.writeFile(nodePath.join(endpointsDir, 'fake-argv.json'), JSON.stringify({
        schema_version: '1.0.0',
        name: 'fake-argv',
        detect: { bin: fakeBin },
        command: { argv: ['{bin}', '-p', '{prompt}'], prompt_delivery: 'argv', ...commandExtra },
        permission: {
            'fs.read': { status: 'supported' },
            'fs.write': { status: 'supported' },
            presets: { 'workspace-write': 'supported' },
        },
        parser: 'kimi-print',
    }))
    return {
        work,
        env: {
            ...process.env,
            PAIDAN_HOME: nodePath.join(root, 'home'),
            PAIDAN_DATA_DIR: nodePath.join(root, 'data'),
            PAIDAN_ENDPOINTS_DIR: endpointsDir,
        },
    }
}

test('over-limit argv submit is refused with TASK_TOO_LONG and creates no run', async () => {
    const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'paidan-argv-long-'))
    try {
        const { work, env } = await setup(root)
        const res = await paidan(env, ['run', '--endpoint', 'fake-argv', '--cwd', work, '--task', 'x'.repeat(25000)])
        assert.equal(res.ok, false)
        assert.equal(res.error.code, 'TASK_TOO_LONG')
        assert.match(res.error.message, /argv/)
        assert.match(res.error.message, /24000/)
        // the message must not pretend --task-file changes the delivery form
        assert.match(res.error.message, /--task-file only changes how paidan reads the task/)
        const runs = await fs.readdir(nodePath.join(root, 'data', 'runs')).catch(() => [])
        assert.deepEqual(runs, [], 'refused submit leaves no run dir')
    } finally {
        await fs.rm(root, { recursive: true, force: true })
    }
})

test('manifest prompt_max_bytes overrides the default guard', async () => {
    const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'paidan-argv-override-'))
    try {
        const { work, env } = await setup(root, { prompt_max_bytes: 200 })
        const res = await paidan(env, ['run', '--endpoint', 'fake-argv', '--cwd', work, '--task', 'x'.repeat(150)])
        assert.equal(res.ok, false)
        assert.equal(res.error.code, 'TASK_TOO_LONG')
        assert.match(res.error.message, /200-byte guard/)
    } finally {
        await fs.rm(root, { recursive: true, force: true })
    }
})

test('within-limit argv submit runs normally', async () => {
    const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'paidan-argv-ok-'))
    try {
        const { work, env } = await setup(root)
        const run = await paidan(env, [
            'run', '--endpoint', 'fake-argv', '--cwd', work, '--task', 'x', '--deliverable', 'fake-deliverable.txt',
        ])
        assert.equal(run.ok, true, JSON.stringify(run))
        const got = await paidan(env, ['get', run.run_id, '--wait', '--timeout', '60'])
        assert.equal(got.run.state, 'completed', JSON.stringify(got))
        await waitForWorkerExit(env.PAIDAN_DATA_DIR, run.run_id)
    } finally {
        await fs.rm(root, { recursive: true, force: true })
    }
})

test('measureArgvBytes counts UTF-8 bytes plus one separator per part', () => {
    assert.equal(measureArgvBytes(['a', 'bc']), 5)
    assert.equal(measureArgvBytes(['é']), 3) // 2 UTF-8 bytes + separator
    assert.equal(DEFAULT_PROMPT_MAX_BYTES, 24000)
})
