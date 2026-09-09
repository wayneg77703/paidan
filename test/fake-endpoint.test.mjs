// End-to-end with a fake endpoint (test/fixtures/fake-codex.cjs): proves the
// worker adopts parser-reported usage (source 'provider') into result.json and
// usage.db, and that in-band refusal evidence lands in evidence.refusals
// while deliverable evidence still outranks it (completed). Fully isolated:
// PAIDAN_HOME/PAIDAN_DATA_DIR/PAIDAN_ENDPOINTS_DIR all point at tmp dirs.

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { test } from 'node:test'

const execFileAsync = promisify(execFile)
const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const CLI = nodePath.join(repoRoot, 'dist', 'cli.js')

async function paidan(env, args) {
    const { stdout } = await execFileAsync(process.execPath, [CLI, ...args], { env, timeout: 60_000 })
    return JSON.parse(stdout.trim())
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
            source: 'provider',
        })
        assert.ok(
            got.result.evidence.refusals.some((r) => r.includes('soft transient error')),
            `refusals: ${JSON.stringify(got.result.evidence.refusals)}`,
        )
        assert.equal(got.result.session_handle, 'fake-thread-0001')
        assert.equal(got.run.session.resumable, true)

        const db = new DatabaseSync(nodePath.join(root, 'data', 'usage.db'))
        const row = db.prepare('SELECT endpoint, source, input_tokens, output_tokens, cached_input_tokens FROM usage WHERE run_id = ?').get(run.run_id)
        db.close()
        // node:sqlite rows are null-prototype objects; spread for the literal compare
        assert.deepEqual({ ...row }, {
            endpoint: 'fake-codex',
            source: 'provider',
            input_tokens: 100,
            output_tokens: 7,
            cached_input_tokens: 40,
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
        }
        const run = await paidan(env, ['run', '--endpoint', 'fake-kimi', '--cwd', work, '--task', 'x', '--deliverable', 'fake-deliverable.txt'])
        assert.equal(run.ok, true, JSON.stringify(run))

        const got = await paidan(env, ['get', run.run_id, '--wait', '--timeout', '60'])
        assert.equal(got.run.state, 'completed')
        assert.deepEqual(got.result.usage, {
            input_tokens: 230,
            output_tokens: 11,
            cached_input_tokens: 50,
            source: 'endpoint-ledger',
        })
        const db = new DatabaseSync(nodePath.join(root, 'data', 'usage.db'))
        const row = db.prepare('SELECT source, input_tokens, output_tokens FROM usage WHERE run_id = ?').get(run.run_id)
        db.close()
        assert.deepEqual({ ...row }, { source: 'endpoint-ledger', input_tokens: 230, output_tokens: 11 })
    } finally {
        await fs.rm(root, { recursive: true, force: true })
    }
})
