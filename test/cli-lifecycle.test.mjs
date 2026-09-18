// get --wait lifecycle contract: an attention run returns immediately with
// terminal:false instead of hanging forever (codex P1-05), and --version /
// help <verb> emit JSON envelopes (codex P2-04).

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { test } from 'node:test'

const execFileAsync = promisify(execFile)
const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const CLI = nodePath.join(repoRoot, 'dist', 'cli.js')

test('get --wait returns immediately on an attention run (no hang)', async () => {
    const home = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'paidan-attention-'))
    const env = { ...process.env, PAIDAN_HOME: home, PAIDAN_DATA_DIR: home }
    try {
        const runId = 'run_20260911_aaaaaaaa'
        const runDir = nodePath.join(home, 'runs', runId)
        await fs.mkdir(runDir, { recursive: true })
        await fs.writeFile(nodePath.join(runDir, 'request.json'), JSON.stringify({
            schema_version: '1.0.0', run_id: runId, fingerprint: 'sha256:x', endpoint: 'kimi-code',
            cwd: home, add_dirs: [], task_file: null, task_text: 'x', mode: 'workspace-write',
            model: null, effort: null, resume_session: null, run_timeout_sec: 1800,
            deliverables: [], created_at: '2026-09-11T00:00:00.000Z', warnings: [],
        }))
        await fs.writeFile(nodePath.join(runDir, 'state.json'), JSON.stringify({
            schema_version: '1.0.0', run_id: runId, state: 'attention',
            worker: { pid: 999999, started_at: '2026-09-11T00:00:00.000Z', pid_start: null, endpoint_pid: null, endpoint_pid_start: null },
            session: { handle: null, resumable: false },
            created_at: '2026-09-11T00:00:00.000Z', updated_at: '2026-09-11T00:00:01.000Z', terminal_at: null,
        }))
        const started = Date.now()
        const { stdout } = await execFileAsync('node', [CLI, 'get', runId, '--wait'], { env, timeout: 15_000 })
        const elapsed = Date.now() - started
        const envelope = JSON.parse(stdout)
        assert.equal(envelope.ok, true)
        assert.equal(envelope.run.state, 'attention')
        assert.equal(envelope.terminal, false)
        // "immediately": the old behavior looped forever on attention
        assert.ok(elapsed < 5_000, `get --wait took ${elapsed}ms on an attention run`)
    } finally {
        await fs.rm(home, { recursive: true, force: true }).catch(() => {})
    }
})

test('--version and help <verb> print JSON envelopes', async () => {
    const env = { ...process.env, PAIDAN_HOME: await fs.mkdtemp(nodePath.join(os.tmpdir(), 'paidan-ver-')) }
    try {
        const { stdout: vOut } = await execFileAsync('node', [CLI, '--version'], { env, timeout: 15_000 })
        const v = JSON.parse(vOut)
        assert.equal(v.ok, true)
        assert.match(v.version, /^\d+\.\d+\.\d+$/)
        const { stdout: hOut } = await execFileAsync('node', [CLI, 'help', 'run'], { env, timeout: 15_000 })
        const h = JSON.parse(hOut)
        assert.equal(h.ok, true)
        assert.equal(h.verb, 'run')
        assert.ok(String(h.flags).includes('--task-file'))
    } finally {
        await fs.rm(env.PAIDAN_HOME, { recursive: true, force: true }).catch(() => {})
    }
})
