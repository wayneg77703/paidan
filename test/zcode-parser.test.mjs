// Golden fixtures for the zcode-print parser (src/endpoints/zcode-print.ts).
// No real agent is touched; fixtures model the single-JSON-envelope --json
// output observed live from ZCode CLI 0.16.5 (2026-09-10).

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
    createZcodePrintParser,
    detectZcodeRefusals,
    discoverZcodeModels,
    usageFromEnvelope,
} from '../dist/endpoints/zcode-print.js'

const ENVELOPE_OK = JSON.stringify(
    {
        sessionId: 'sess_48fc4a92-47cb-4865-8ab6-715d8396b5cb',
        traceId: 'a5184856-d65a-467e-b869-0755a7d97280',
        turnId: 'turn_5049cf54-c4a7-468b-b199-11c20da37e06',
        response: 'ok',
        usage: {
            source: 'provider',
            modelRequestCount: 1,
            inputTokens: 17001,
            outputTokens: 14,
            totalTokens: 17015,
            cacheReadTokens: 4352,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
            webFetchRequests: 0,
            webSearchRequests: 0,
        },
        eventCount: 23,
        projection: { status: 'idle', turnCount: 1, totalTokenCount: 17015, contextUsed: 17015, contextWindow: 1000000 },
    },
    null,
    2,
)

function feed(p, text) {
    const lines = text.split('\n')
    for (const line of lines.slice(0, -1)) p.acceptStdoutLine(line)
    return lines[lines.length - 1] // tail
}

test('normal envelope: response/sessionId/usage extracted, not degraded', () => {
    const p = createZcodePrintParser()
    const tail = feed(p, ENVELOPE_OK + '\n')
    const r = p.finish(tail === '' ? '' : tail, '')
    assert.equal(r.finalText, 'ok')
    assert.equal(r.sessionId, 'sess_48fc4a92-47cb-4865-8ab6-715d8396b5cb')
    assert.equal(r.degraded, false)
    assert.deepEqual(r.usage, {
        input_tokens: 17001,
        output_tokens: 14,
        cached_input_tokens: 4352,
        cost: null,
        source: 'provider',
    })
})

test('compact single-line envelope parses identically (line-based feed)', () => {
    const p = createZcodePrintParser()
    p.acceptStdoutLine(JSON.stringify(JSON.parse(ENVELOPE_OK)))
    const r = p.finish('', '')
    assert.equal(r.finalText, 'ok')
    assert.equal(r.sessionId, 'sess_48fc4a92-47cb-4865-8ab6-715d8396b5cb')
    assert.equal(r.degraded, false)
})

test('envelope ending mid-stream (no trailing newline) still parses via tail', () => {
    const p = createZcodePrintParser()
    const tail = feed(p, ENVELOPE_OK) // last line has no newline -> arrives as tail
    const r = p.finish(tail, '')
    assert.equal(r.finalText, 'ok')
    assert.equal(r.degraded, false)
})

test('non-JSON stdout degrades the parser instead of crashing', () => {
    const p = createZcodePrintParser()
    p.acceptStdoutLine('zcode: something unexpected happened')
    p.acceptStdoutLine('{not json')
    const r = p.finish('', '')
    assert.equal(r.degraded, true)
    assert.ok(r.warnings.some((w) => w.includes('JSON envelope')))
    assert.equal(r.finalText, '')
    assert.equal(r.sessionId, null)
    assert.equal(r.usage, null)
})

test('empty stdout is not degraded (startup failure is governed by exit code)', () => {
    const p = createZcodePrintParser()
    const r = p.finish('', '')
    assert.equal(r.degraded, false)
    assert.equal(r.finalText, '')
    assert.equal(r.sessionId, null)
})

test('missing required envelope fields degrade', () => {
    const partial = JSON.parse(ENVELOPE_OK)
    delete partial.projection
    delete partial.turnId
    const p = createZcodePrintParser()
    const tail = feed(p, JSON.stringify(partial) + '\n')
    const r = p.finish(tail, '')
    assert.equal(r.degraded, true)
    assert.ok(r.warnings.some((w) => w.includes('projection')))
    // extractable fields still surface
    assert.equal(r.finalText, 'ok')
    assert.equal(r.sessionId, 'sess_48fc4a92-47cb-4865-8ab6-715d8396b5cb')
})

test('non-idle projection status degrades (abnormal termination evidence)', () => {
    const abnormal = JSON.parse(ENVELOPE_OK)
    abnormal.projection.status = 'running'
    const p = createZcodePrintParser()
    const tail = feed(p, JSON.stringify(abnormal) + '\n')
    const r = p.finish(tail, '')
    assert.equal(r.degraded, true)
    assert.ok(r.warnings.some((w) => w.includes('projection.status')))
})

test('turnCount above the 12-turn cap degrades', () => {
    const over = JSON.parse(ENVELOPE_OK)
    over.projection.turnCount = 13
    const p = createZcodePrintParser()
    const tail = feed(p, JSON.stringify(over) + '\n')
    const r = p.finish(tail, '')
    assert.equal(r.degraded, true)
})

test('usage absent or partial -> null, never fabricated zeros', () => {
    assert.equal(usageFromEnvelope(null), null)
    assert.equal(usageFromEnvelope({ inputTokens: 5 }), null)
    assert.deepEqual(usageFromEnvelope({ inputTokens: 5, outputTokens: 7 }), {
        input_tokens: 5,
        output_tokens: 7,
        cached_input_tokens: null,
        cost: null,
        source: 'provider',
    })
})

test('detectRefusals is an honest no-op for 0.16.5', () => {
    assert.deepEqual(detectZcodeRefusals('Error: Model config is missing.\n', 1), [])
    assert.deepEqual(detectZcodeRefusals('anything\n', 0), [])
})

test('model discovery scans native v2 config honestly (no credentials read out)', () => {
    const config = JSON.stringify({
        provider: {
            'builtin:bigmodel-coding-plan': {
                enabled: true,
                options: { apiKey: 'secret-must-not-appear', baseURL: 'https://example.invalid' },
                models: { 'GLM-5.3': {}, 'GLM-5-Turbo': { enabled: false } },
            },
            'builtin:zai': { enabled: false, models: { 'glm-x': {} } },
        },
    })
    const { models, notes } = discoverZcodeModels(config)
    assert.deepEqual(models, [{ alias: 'builtin:bigmodel-coding-plan/GLM-5.3', connection: 'builtin:bigmodel-coding-plan', source: 'desktop-config', effort_options: null, default_effort: null }])
    assert.ok(notes.length > 0)
    assert.ok(!JSON.stringify(models).includes('secret-must-not-appear'))
    assert.deepEqual(discoverZcodeModels(null).models, [])
    assert.deepEqual(discoverZcodeModels('{broken').models, [])
})

test('native config/model/env presence never claims that zcode authentication has succeeded', async () => {
    const fs = await import('node:fs/promises')
    const os = await import('node:os')
    const path = await import('node:path')
    const { readNativeDefaults } = await import('../dist/endpoints/zcode-print.js')
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paidan-zcode-auth-'))
    const keys = ['USERPROFILE', 'ZCODE_PERSONAL_PROVIDER_CONFIG_FILE', 'ZCODE_MODEL', 'ZCODE_BASE_URL', 'ANTHROPIC_API_KEY']
    const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
    try {
        process.env.USERPROFILE = root
        delete process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE
        process.env.ZCODE_MODEL = 'fixture-model'
        process.env.ZCODE_BASE_URL = 'https://example.invalid'
        process.env.ANTHROPIC_API_KEY = 'fixture-secret-never-expose'
        const file = path.join(root, '.zcode', 'cli', 'config.json')
        await fs.mkdir(path.dirname(file), { recursive: true })
        // Missing, model-only, provider-only and malformed configs all remain unverified.
        for (const raw of [null, '{"model":"arbitrary-model"}', '{"provider":{"example":{}}}', '{broken']) {
            if (raw !== null) await fs.writeFile(file, raw)
            const result = await readNativeDefaults()
            assert.equal(result.credential_ready, null)
            assert.ok(result.notes.some((note) => note.includes('unverified')))
            assert.ok(!JSON.stringify(result).includes('fixture-secret-never-expose'))
        }
    } finally {
        for (const key of keys) {
            if (saved[key] === undefined) delete process.env[key]
            else process.env[key] = saved[key]
        }
        assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()))
        await fs.rm(root, { recursive: true, force: true })
    }
})
