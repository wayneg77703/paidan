// End-to-end with a fake endpoint (test/fixtures/fake-codex.cjs): proves the
// worker adopts parser-reported usage (source 'provider') into result.json and
// usage.db, and that in-band refusal evidence lands in evidence.refusals
// while deliverable evidence still outranks it (completed). Fully isolated:
// PAIDAN_HOME/PAIDAN_DATA_DIR/PAIDAN_ENDPOINTS_DIR all point at tmp dirs.

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { test } from 'node:test'
import { waitForWorkerExit } from './helpers/worker.mjs'

const execFileAsync = promisify(execFile)
const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const CLI = nodePath.join(repoRoot, 'dist', 'cli.js')

async function paidan(env, args) {
    const { stdout } = await execFileAsync(process.execPath, [CLI, ...args], { env, timeout: 60_000 })
    const result = JSON.parse(stdout.trim())
    if (result.terminal) await waitForWorkerExit(env.PAIDAN_DATA_DIR, result.run.run_id)
    return result
}

test('worker adopts parser usage into result.json + usage.db; in-band error lands in refusals', async () => {
    const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'paidan-fake-'))
    try {
        const endpointsDir = nodePath.join(root, 'endpoints')
        const work = nodePath.join(root, 'work')
        await fs.mkdir(endpointsDir, { recursive: true })
        await fs.mkdir(work, { recursive: true })
        const fakeBin = nodePath.join(repoRoot, 'test', 'fixtures', 'fake-codex.cjs')
        await fs.writeFile(nodePath.join(endpointsDir, 'fake-codex.json'), JSON.stringify({
            schema_version: '1.0.0',
            name: 'fake-codex',
            detect: { bin: fakeBin },
            command: { argv: ['{bin}', '--json', '-'], prompt_delivery: 'stdin' },
            permission: {
                'fs.read': { status: 'supported' },
                'fs.write': { status: 'supported' },
                presets: { 'workspace-write': 'supported' },
            },
            resume: { kind: 'flag', args: ['--resume', '{session}'] },
            parser: 'codex-exec',
        }))
        const env = {
            ...process.env,
            PAIDAN_HOME: nodePath.join(root, 'home'),
            PAIDAN_DATA_DIR: nodePath.join(root, 'data'),
            PAIDAN_ENDPOINTS_DIR: endpointsDir,
        }
        const run = await paidan(env, ['run', '--endpoint', 'fake-codex', '--cwd', work, '--task', 'x', '--deliverable', 'fake-deliverable.txt'])
        assert.equal(run.ok, true, JSON.stringify(run))
        assert.equal(run.created, true)

        const got = await paidan(env, ['get', run.run_id, '--wait', '--timeout', '60'])
        assert.equal(got.terminal, true, JSON.stringify(got))
        // deliverable evidence outranks the in-band refusal signal
        assert.equal(got.run.state, 'completed')
        assert.deepEqual(got.result.usage, {
            input_tokens: 100,
            output_tokens: 7,
            cached_input_tokens: 40,
            cost: null,
            source: 'provider',
        })
        assert.ok(
            got.result.evidence.refusals.some((r) => r.includes('soft transient error')),
            `refusals: ${JSON.stringify(got.result.evidence.refusals)}`,
        )
        assert.equal(got.result.session_handle, 'fake-thread-0001')
        assert.equal(got.run.session.resumable, true)

        const db = new DatabaseSync(nodePath.join(root, 'data', 'usage.db'))
        const row = db.prepare('SELECT endpoint, source, input_tokens, output_tokens, cached_input_tokens, cost FROM usage WHERE run_id = ?').get(run.run_id)
        db.close()
        // node:sqlite rows are null-prototype objects; spread for the literal compare
        assert.deepEqual({ ...row }, {
            endpoint: 'fake-codex',
            source: 'provider',
            input_tokens: 100,
            output_tokens: 7,
            cached_input_tokens: 40,
            cost: null,
        })
    } finally {
        await fs.rm(root, { recursive: true, force: true })
    }
})

test('kimi endpoint-ledger: stream-less usage is adopted from the native session wire', async () => {
    const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'paidan-fake-kimi-'))
    try {
        const endpointsDir = nodePath.join(root, 'endpoints')
        const work = nodePath.join(root, 'work')
        await fs.mkdir(endpointsDir, { recursive: true })
        await fs.mkdir(work, { recursive: true })
        // fake native kimi home: session_index + one agent wire with usage rows
        const kimiHome = nodePath.join(root, 'kimi-home')
        const sessionDir = nodePath.join(kimiHome, 'sessions', 'wd_test', 'session_fakekimi01')
        await fs.mkdir(nodePath.join(sessionDir, 'agents', 'main'), { recursive: true })
        await fs.writeFile(
            nodePath.join(kimiHome, 'session_index.jsonl'),
            JSON.stringify({ sessionId: 'session_fakekimi01', sessionDir, workDir: work }) + '\n',
        )
        await fs.writeFile(
            nodePath.join(sessionDir, 'agents', 'main', 'wire.jsonl'),
            [
                JSON.stringify({ type: 'llm.request', kind: 'loop' }),
                JSON.stringify({ type: 'usage.record', usageScope: 'turn', usage: { inputCacheRead: 50, inputOther: 200, inputCacheCreation: 30, output: 11 } }),
            ].join('\n') + '\n',
        )
        const fakeBin = nodePath.join(repoRoot, 'test', 'fixtures', 'fake-kimi.cjs')
        await fs.writeFile(nodePath.join(endpointsDir, 'fake-kimi.json'), JSON.stringify({
            schema_version: '1.0.0',
            name: 'fake-kimi',
            detect: { bin: fakeBin },
            command: { argv: ['{bin}', '-p', '{prompt}'], prompt_delivery: 'argv', prompt_cwd_hint: true },
            permission: {
                'fs.read': { status: 'supported' },
                'fs.write': { status: 'supported' },
                presets: { 'workspace-write': 'supported' },
            },
            resume: { kind: 'flag', args: ['-S', '{session}'] },
            parser: 'kimi-print',
        }))
        const env = {
            ...process.env,
            PAIDAN_HOME: nodePath.join(root, 'home'),
            PAIDAN_DATA_DIR: nodePath.join(root, 'data'),
            PAIDAN_ENDPOINTS_DIR: endpointsDir,
            KIMI_CODE_HOME: kimiHome,
        }
        const run = await paidan(env, ['run', '--endpoint', 'fake-kimi', '--cwd', work, '--task', 'x', '--deliverable', 'fake-deliverable.txt'])
        assert.equal(run.ok, true, JSON.stringify(run))

        const got = await paidan(env, ['get', run.run_id, '--wait', '--timeout', '60'])
        assert.equal(got.run.state, 'completed')
        assert.deepEqual(got.result.usage, {
            input_tokens: 230,
            output_tokens: 11,
            cached_input_tokens: 50,
            cost: null,
            source: 'endpoint-ledger',
        })
        const db = new DatabaseSync(nodePath.join(root, 'data', 'usage.db'))
        const row = db.prepare('SELECT source, input_tokens, output_tokens, cost FROM usage WHERE run_id = ?').get(run.run_id)
        db.close()
        assert.deepEqual({ ...row }, { source: 'endpoint-ledger', input_tokens: 230, output_tokens: 11, cost: null })

        // prompt_cwd_hint: request.json keeps the original text; events record the append
        const runDir = nodePath.join(root, 'data', 'runs', run.run_id)
        const reqJson = JSON.parse(await fs.readFile(nodePath.join(runDir, 'request.json'), 'utf8'))
        assert.equal(reqJson.task_text, 'x')
        const events = (await fs.readFile(nodePath.join(runDir, 'events.jsonl'), 'utf8'))
            .trim().split('\n').map((l) => JSON.parse(l))
        assert.ok(events.some((e) => e.type === 'note' && e.note === 'prompt_cwd_hint appended'), 'hint note event')
        const spawnEvent = events.find((e) => e.type === 'spawn')
        const hintedSha = createHash('sha256')
            .update(`x\n\nThe current working directory is ${work}. Use absolute paths for all file operations.`)
            .digest('hex').slice(0, 12)
        assert.ok(spawnEvent.argv.some((a) => a === `[prompt sha256:${hintedSha}]`), 'hinted prompt is what argv carried')
    } finally {
        await fs.rm(root, { recursive: true, force: true })
    }
})

test('claude total_cost_usd flows into result.json usage.cost and the usage.db cost column', async () => {
    const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'paidan-fake-claude-'))
    try {
        const endpointsDir = nodePath.join(root, 'endpoints')
        const work = nodePath.join(root, 'work')
        await fs.mkdir(endpointsDir, { recursive: true })
        await fs.mkdir(work, { recursive: true })
        const fakeBin = nodePath.join(repoRoot, 'test', 'fixtures', 'fake-claude.cjs')
        await fs.writeFile(nodePath.join(endpointsDir, 'fake-claude.json'), JSON.stringify({
            schema_version: '1.0.0',
            name: 'fake-claude',
            detect: { bin: fakeBin },
            command: { argv: ['{bin}', '-p', '{prompt}'], prompt_delivery: 'argv' },
            permission: {
                'fs.read': { status: 'supported' },
                'fs.write': { status: 'supported' },
                presets: { 'workspace-write': 'supported' },
            },
            resume: { kind: 'flag', args: ['--resume', '{session}'] },
            parser: 'claude-stream-json',
        }))
        const env = {
            ...process.env,
            PAIDAN_HOME: nodePath.join(root, 'home'),
            PAIDAN_DATA_DIR: nodePath.join(root, 'data'),
            PAIDAN_ENDPOINTS_DIR: endpointsDir,
        }
        const run = await paidan(env, ['run', '--endpoint', 'fake-claude', '--cwd', work, '--task', 'x'])
        assert.equal(run.ok, true, JSON.stringify(run))

        const got = await paidan(env, ['get', run.run_id, '--wait', '--timeout', '60'])
        assert.equal(got.run.state, 'completed', JSON.stringify(got))
        assert.deepEqual(got.result.usage, {
            input_tokens: 64,
            output_tokens: 9,
            cached_input_tokens: 30,
            cost: 0.0123,
            source: 'provider',
        })
        assert.ok(!got.result.evidence.notes.some((n) => n.includes('total_cost_usd')), 'cost note is gone')

        const db = new DatabaseSync(nodePath.join(root, 'data', 'usage.db'))
        const row = db.prepare('SELECT source, cost FROM usage WHERE run_id = ?').get(run.run_id)
        db.close()
        assert.deepEqual({ ...row }, { source: 'provider', cost: 0.0123 })
    } finally {
        await fs.rm(root, { recursive: true, force: true })
    }
})

test('kimi resume run: worker captures a pre-spawn wire cursor and usage is only the new delta', async () => {
    const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'paidan-fake-kimi-resume-'))
    try {
        const endpointsDir = nodePath.join(root, 'endpoints')
        const work = nodePath.join(root, 'work')
        await fs.mkdir(endpointsDir, { recursive: true })
        await fs.mkdir(work, { recursive: true })
        const kimiHome = nodePath.join(root, 'kimi-home')
        const sessionDir = nodePath.join(kimiHome, 'sessions', 'wd_test', 'session_fakekimi01')
        await fs.mkdir(nodePath.join(sessionDir, 'agents', 'main'), { recursive: true })
        await fs.writeFile(
            nodePath.join(kimiHome, 'session_index.jsonl'),
            JSON.stringify({ sessionId: 'session_fakekimi01', sessionDir, workDir: work }) + '\n',
        )
        const wire = nodePath.join(sessionDir, 'agents', 'main', 'wire.jsonl')
        // the fixture appends one (200 in / 11 out) usage.record row per invocation
        const fakeBin = nodePath.join(repoRoot, 'test', 'fixtures', 'fake-kimi-ledger-writer.cjs')
        await fs.writeFile(nodePath.join(endpointsDir, 'fake-kimi.json'), JSON.stringify({
            schema_version: '1.0.0',
            name: 'fake-kimi',
            detect: { bin: fakeBin },
            command: { argv: ['{bin}', '-p', '{prompt}'], prompt_delivery: 'argv' },
            permission: {
                'fs.read': { status: 'supported' },
                'fs.write': { status: 'supported' },
                presets: { 'workspace-write': 'supported' },
            },
            resume: { kind: 'flag', args: ['-S', '{session}'] },
            parser: 'kimi-print',
        }))
        const env = {
            ...process.env,
            PAIDAN_HOME: nodePath.join(root, 'home'),
            PAIDAN_DATA_DIR: nodePath.join(root, 'data'),
            PAIDAN_ENDPOINTS_DIR: endpointsDir,
            KIMI_CODE_HOME: kimiHome,
            FAKE_WIRE: wire,
        }
        const runOnce = (extra) => paidan(env, ['run', '--endpoint', 'fake-kimi', '--cwd', work, '--task', 'x', ...extra])
        const waitUsage = async (runId) => (await paidan(env, ['get', runId, '--wait', '--timeout', '60'])).result.usage

        // fresh run: no cursor, the whole wire (just this run's row) is summed
        const first = await runOnce([])
        assert.equal(first.ok, true, JSON.stringify(first))
        assert.deepEqual(await waitUsage(first.run_id), {
            input_tokens: 200,
            output_tokens: 11,
            cached_input_tokens: 0,
            cost: null,
            source: 'endpoint-ledger',
        })

        // resume: the worker pins the wire size pre-spawn; the fixture's new
        // row lands after the cursor. A whole-file read would sum 400/600.
        const second = await runOnce(['--resume', 'session_fakekimi01'])
        assert.equal(second.ok, true, JSON.stringify(second))
        const usage2 = await waitUsage(second.run_id)
        assert.deepEqual(usage2, {
            input_tokens: 200,
            output_tokens: 11,
            cached_input_tokens: 0,
            cost: null,
            source: 'endpoint-ledger',
        })
        const third = await runOnce(['--resume', 'session_fakekimi01'])
        assert.equal(third.ok, true, JSON.stringify(third))
        assert.deepEqual(await waitUsage(third.run_id), usage2, 'each resume sees only its own delta')
    } finally {
        await fs.rm(root, { recursive: true, force: true })
    }
})
