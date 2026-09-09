// kimi session-ledger usage observation (src/endpoints/kimi-ledger.ts).
// Constructed fixture homes only; the real ~/.kimi-code is never touched.

import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import { test } from 'node:test'
import { readKimiLedgerUsage } from '../dist/endpoints/kimi-ledger.js'

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
            source: 'endpoint-ledger',
        })
        assert.deepEqual(r.warnings, [])
    } finally {
        await fs.rm(home, { recursive: true, force: true })
    }
})

test('resume runs never read the ledger (earlier turns would leak in)', async () => {
    const home = await fixtureHome([TURN_ROW])
    try {
        const r = await readKimiLedgerUsage(HANDLE, { resume: true, home })
        assert.equal(r.usage, null)
        assert.ok(r.warnings.some((w) => w.includes('resume')))
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
