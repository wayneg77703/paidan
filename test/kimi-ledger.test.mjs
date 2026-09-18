// kimi session-ledger usage observation (src/endpoints/kimi-ledger.ts).
// Constructed fixture homes only; the real ~/.kimi-code is never touched.

import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import { test } from 'node:test'
import { captureKimiLedgerCursor, readKimiLedgerUsage } from '../dist/endpoints/kimi-ledger.js'

const HANDLE = 'session_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

async function fixtureHome(rows, opts = {}) {
    const home = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'paidan-ledger-'))
    const sessionDir = nodePath.join(home, 'sessions', 'wd_test', HANDLE)
    await fs.mkdir(nodePath.join(sessionDir, 'agents', 'main'), { recursive: true })
    const lines = rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r)))
    await fs.writeFile(nodePath.join(sessionDir, 'agents', 'main', 'wire.jsonl'), lines.join('\n') + '\n', 'utf8')
    if (opts.index !== false) {
        await fs.writeFile(
            nodePath.join(home, 'session_index.jsonl'),
            JSON.stringify({ sessionId: HANDLE, sessionDir, workDir: 'D:/work' }) + '\n',
            'utf8',
        )
    }
    return home
}

const TURN_ROW = { type: 'usage.record', usageScope: 'turn', usage: { inputCacheRead: 50, inputOther: 200, inputCacheCreation: 30, output: 11 } }
const COMPACTION_ROW = { type: 'usage.record', usageScope: 'session', usage: { inputCacheRead: 0, inputOther: 5, inputCacheCreation: 0, output: 2 } }
const NOISE_ROW = { type: 'llm.request', kind: 'loop' }

test('fresh run: wire usage.record rows sum into endpoint-ledger usage', async () => {
    const home = await fixtureHome([NOISE_ROW, TURN_ROW, COMPACTION_ROW])
    try {
        const r = await readKimiLedgerUsage(HANDLE, { resume: false, home })
        assert.deepEqual(r.usage, {
            // inputOther + inputCacheCreation across rows; cacheRead is cached input
            input_tokens: 235,
            output_tokens: 13,
            cached_input_tokens: 50,
            // the kimi ledger has no cost concept
            cost: null,
            source: 'endpoint-ledger',
        })
        assert.deepEqual(r.warnings, [])
    } finally {
        await fs.rm(home, { recursive: true, force: true })
    }
})

test('resume without a pre-spawn cursor cannot charge previous turns', async () => {
    const home = await fixtureHome([TURN_ROW])
    try {
        const r = await readKimiLedgerUsage(HANDLE, { resume: true, home })
        assert.equal(r.usage, null)
        assert.ok(r.warnings.some((w) => w.includes('resume')))
    } finally {
        await fs.rm(home, { recursive: true, force: true })
    }
})

test('resume with a pre-spawn cursor sums only bytes appended after it', async () => {
    const home = await fixtureHome([NOISE_ROW, TURN_ROW])
    try {
        const cursor = await captureKimiLedgerCursor(HANDLE, { home })
        assert.ok(cursor, 'cursor captured for an existing session')
        const wire = nodePath.join(home, 'sessions', 'wd_test', HANDLE, 'agents', 'main', 'wire.jsonl')
        await fs.appendFile(wire, JSON.stringify(COMPACTION_ROW) + '\n', 'utf8')
        const r = await readKimiLedgerUsage(HANDLE, { resume: true, cursor, home })
        // only the appended row: TURN_ROW stays on the pre-cursor side
        assert.deepEqual(r.usage, { input_tokens: 5, output_tokens: 2, cached_input_tokens: 0, cost: null, source: 'endpoint-ledger' })
        assert.deepEqual(r.warnings, [])
    } finally {
        await fs.rm(home, { recursive: true, force: true })
    }
})

test('cursor null (session absent pre-spawn) falls back to whole-file semantics', async () => {
    const home = await fixtureHome([TURN_ROW])
    try {
        assert.equal(await captureKimiLedgerCursor('session_not_in_index', { home }), null)
        const r = await readKimiLedgerUsage(HANDLE, { resume: true, cursor: null, home })
        assert.deepEqual(r.usage, { input_tokens: 230, output_tokens: 11, cached_input_tokens: 50, cost: null, source: 'endpoint-ledger' })
    } finally {
        await fs.rm(home, { recursive: true, force: true })
    }
})

test('a wire file created after the cursor (new agent dir) is summed whole', async () => {
    const home = await fixtureHome([TURN_ROW])
    try {
        const cursor = await captureKimiLedgerCursor(HANDLE, { home })
        const subDir = nodePath.join(home, 'sessions', 'wd_test', HANDLE, 'agents', 'sub')
        await fs.mkdir(subDir, { recursive: true })
        await fs.writeFile(nodePath.join(subDir, 'wire.jsonl'), JSON.stringify(COMPACTION_ROW) + '\n', 'utf8')
        const r = await readKimiLedgerUsage(HANDLE, { resume: true, cursor, home })
        assert.deepEqual(r.usage, { input_tokens: 5, output_tokens: 2, cached_input_tokens: 0, cost: null, source: 'endpoint-ledger' })
    } finally {
        await fs.rm(home, { recursive: true, force: true })
    }
})

test('a line spanning the cursor belongs to the previous era and is skipped', async () => {
    const home = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'paidan-ledger-'))
    try {
        const sessionDir = nodePath.join(home, 'sessions', 'wd_test', HANDLE)
        await fs.mkdir(nodePath.join(sessionDir, 'agents', 'main'), { recursive: true })
        // previous turn died mid-line: no trailing newline
        const partial = '{"type":"usage.record","usageScope":"turn","usage":{"inputCacheRead":1'
        const wire = nodePath.join(sessionDir, 'agents', 'main', 'wire.jsonl')
        await fs.writeFile(wire, JSON.stringify(TURN_ROW) + '\n' + partial, 'utf8')
        await fs.writeFile(
            nodePath.join(home, 'session_index.jsonl'),
            JSON.stringify({ sessionId: HANDLE, sessionDir, workDir: 'D:/work' }) + '\n',
            'utf8',
        )
        const cursor = await captureKimiLedgerCursor(HANDLE, { home })
        // the append completes the interrupted line (still previous-era) and adds one new row
        await fs.appendFile(wire, ',"inputOther":2,"inputCacheCreation":0,"output":3}}\n' + JSON.stringify(COMPACTION_ROW) + '\n', 'utf8')
        const r = await readKimiLedgerUsage(HANDLE, { resume: true, cursor, home })
        assert.deepEqual(r.usage, { input_tokens: 5, output_tokens: 2, cached_input_tokens: 0, cost: null, source: 'endpoint-ledger' })
    } finally {
        await fs.rm(home, { recursive: true, force: true })
    }
})

test('missing session_index entry / missing wire / invalid row all yield null, never zeros', async () => {
    const noIndex = await fixtureHome([TURN_ROW], { index: false })
    try {
        assert.equal((await readKimiLedgerUsage(HANDLE, { resume: false, home: noIndex })).usage, null)
    } finally {
        await fs.rm(noIndex, { recursive: true, force: true })
    }

    const emptyWire = await fixtureHome([])
    try {
        const r = await readKimiLedgerUsage(HANDLE, { resume: false, home: emptyWire })
        assert.equal(r.usage, null)
        assert.ok(r.warnings.some((w) => w.includes('no usage.record')))
    } finally {
        await fs.rm(emptyWire, { recursive: true, force: true })
    }

    const corrupt = await fixtureHome(['{"type":"usage.record","usage":broken'])
    try {
        const r = await readKimiLedgerUsage(HANDLE, { resume: false, home: corrupt })
        assert.equal(r.usage, null)
        assert.ok(r.warnings.some((w) => w.includes('invalid')))
    } finally {
        await fs.rm(corrupt, { recursive: true, force: true })
    }

    const negative = await fixtureHome([{ type: 'usage.record', usage: { inputCacheRead: -1, inputOther: 0, inputCacheCreation: 0, output: 0 } }])
    try {
        assert.equal((await readKimiLedgerUsage(HANDLE, { resume: false, home: negative })).usage, null)
    } finally {
        await fs.rm(negative, { recursive: true, force: true })
    }
})

test('nonexistent home yields null with a warning', async () => {
    const r = await readKimiLedgerUsage(HANDLE, { resume: false, home: 'D:/definitely/not/here' })
    assert.equal(r.usage, null)
    assert.ok(r.warnings.length > 0)
})
