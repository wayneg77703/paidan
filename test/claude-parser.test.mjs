// Golden fixtures for the claude-stream-json parser (src/endpoints/claude-stream-json.ts).
// No real agent is touched; fixtures are constructed from the v2.1.260 stream
// shape sampled live on 2026-09-10 (init -> assistant -> one terminal result).

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createParser, detectRefusals, discoverModels, readClaudeNativeDefaults } from '../dist/endpoints/claude-stream-json.js'

const INIT = '{"type":"system","subtype":"init","cwd":"D:/work","session_id":"11111111-2222-3333-4444-555555555555","tools":["Read","Write","Bash"],"model":"claude-opus-5","permissionMode":"acceptEdits"}'

function assistantLine(text) {
    return JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text }] },
        session_id: '11111111-2222-3333-4444-555555555555',
    })
}

function resultLine(extra = {}) {
    return JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'DONE',
        session_id: '11111111-2222-3333-4444-555555555555',
        usage: { input_tokens: 4, cache_creation_input_tokens: 66579, cache_read_input_tokens: 62714, output_tokens: 198 },
        total_cost_usd: 0.4273,
        permission_denials: [],
        ...extra,
    })
}

test('full lifecycle: init -> assistant -> result yields session, result text, provider usage', () => {
    const p = createParser()
    p.acceptStdoutLine(INIT)
    p.acceptStdoutLine(assistantLine('working... '))
    p.acceptStdoutLine(assistantLine('DONE'))
    p.acceptStdoutLine(resultLine())
    const r = p.finish('', '')
    assert.equal(r.sessionId, '11111111-2222-3333-4444-555555555555')
    assert.equal(r.resumeHint, 'claude --resume 11111111-2222-3333-4444-555555555555')
    // result event text is authoritative over accumulated assistant text
    assert.equal(r.finalText, 'DONE')
    assert.equal(r.degraded, false)
    assert.ok(r.usage)
    // input = uncached + cache-creation (fresh input work); cache_read -> cached
    assert.equal(r.usage.input_tokens, 4 + 66579)
    assert.equal(r.usage.cached_input_tokens, 62714)
    assert.equal(r.usage.output_tokens, 198)
    assert.equal(r.usage.source, 'provider')
    // cost rides the contract field now (contracts §4), not a note
    assert.equal(r.usage.cost, 0.4273)
    assert.ok(!r.warnings.some((w) => w.includes('total_cost_usd')))
})

test('permission denial terminal: exit-0 success shape with permission_denials surfaces denial evidence', () => {
    const p = createParser()
    p.acceptStdoutLine(INIT.replace('acceptEdits', 'default'))
    p.acceptStdoutLine(assistantLine('cannot write: permission denied'))
    p.acceptStdoutLine(
        resultLine({
            result: '无法创建文件：Write 被自动拒绝。',
            total_cost_usd: 0.1079,
            permission_denials: [
                { tool_name: 'Write', tool_use_id: 'toolu_01x', tool_input: { file_path: 'D:/work/probe-ro.txt' } },
            ],
        }),
    )
    const r = p.finish('', '')
    assert.equal(r.degraded, false)
    assert.ok(r.warnings.some((w) => w.includes('permission denied by endpoint: Write')))
    assert.equal(r.finalText, '无法创建文件：Write 被自动拒绝。')
    // stderr carries nothing in this shape; refusal signatures do not exist
    assert.deepEqual(detectRefusals('', 0), [])
    assert.deepEqual(detectRefusals('anything at all\n', 1), [])
})

test('non-JSON stdout line degrades the parser but keeps parsing', () => {
    const p = createParser()
    p.acceptStdoutLine(INIT)
    p.acceptStdoutLine('claude: something unexpected happened') // drift / banner line
    p.acceptStdoutLine(resultLine())
    const r = p.finish('', '')
    assert.equal(r.degraded, true)
    assert.ok(r.warnings.some((w) => w.includes('non-JSON')))
    assert.equal(r.sessionId, '11111111-2222-3333-4444-555555555555')
    assert.equal(r.finalText, 'DONE')
})

test('mid-line stdout EOF degrades the parser', () => {
    const p = createParser()
    p.acceptStdoutLine(INIT)
    const r = p.finish('{"type":"resu', '')
    assert.equal(r.degraded, true)
})

test('conflicting init/result session ids degrade instead of picking one silently', () => {
    const p = createParser()
    p.acceptStdoutLine(INIT)
    p.acceptStdoutLine(resultLine({ session_id: '99999999-0000-0000-0000-000000000000' }))
    const r = p.finish('', '')
    assert.equal(r.degraded, true)
    assert.equal(r.sessionId, '11111111-2222-3333-4444-555555555555') // init stays authoritative
})

test('missing result event: fall back to assistant text, warn, do not degrade, usage stays null', () => {
    const p = createParser()
    p.acceptStdoutLine(INIT)
    p.acceptStdoutLine(assistantLine('partial answer'))
    const r = p.finish('', '')
    assert.equal(r.degraded, false)
    assert.equal(r.finalText, 'partial answer')
    assert.equal(r.usage, null)
    assert.ok(r.warnings.some((w) => w.includes('no result event')))
})

test('unknown event types and blank lines are ignored', () => {
    const p = createParser()
    p.acceptStdoutLine('')
    p.acceptStdoutLine('{"type":"user","message":{"content":[]}}')
    p.acceptStdoutLine(INIT)
    p.acceptStdoutLine(resultLine({ usage: undefined, total_cost_usd: undefined }))
    const r = p.finish('', '')
    assert.equal(r.degraded, false)
    assert.equal(r.usage, null)
    assert.ok(!r.warnings.some((w) => w.includes('total_cost_usd')))
})

test('discoverModels: static docs-sourced alias list (claude has no enumeration command)', async () => {
    const { models, notes } = await discoverModels()
    assert.deepEqual(models.map((m) => m.alias), ['sonnet', 'opus', 'haiku', 'fable'])
    assert.ok(models.every((m) => m.connection === null))
    assert.ok(notes.some((n) => n.includes('no enumeration command')))
})

test('readClaudeNativeDefaults: settings.json model key + ANTHROPIC_MODEL note', () => {
    const d = readClaudeNativeDefaults(JSON.stringify({ model: 'opus', env: { ANTHROPIC_MODEL: 'claude-opus-5', ANTHROPIC_BASE_URL: 'https://gw' } }))
    assert.equal(d.model, 'opus')
    assert.ok((d.notes ?? []).some((n) => n.includes('claude-opus-5')))
    assert.equal(readClaudeNativeDefaults('{}').model, null)
    assert.equal(readClaudeNativeDefaults('not json').model, null)
    const none = readClaudeNativeDefaults(null)
    assert.equal(none.model, null)
    assert.ok((none.notes ?? []).length > 0)
})
