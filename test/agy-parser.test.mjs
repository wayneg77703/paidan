// Golden fixtures for the agy-print parser (src/endpoints/agy-print.ts).
// No real agent is touched; fixtures mirror the agy 1.1.28 stream shape
// captured live on 2026-09-10 (tmp/agy-native-probe/out/: t1-hello,
// t2a-plan-only, t2b-deny-acceptedits, t6b-sandbox-shell, t7-timeout2).

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createParser, detectRefusals, parseAgyModelsOutput } from '../dist/endpoints/agy-print.js'

const CONV = '6aa53b9a-400d-434a-ba3c-c8977db8f382'
const INIT = JSON.stringify({
    event: 'init',
    conversation_id: CONV,
    init: { cwd: 'D:\\work\\thing', tools: ['write_to_file', 'run_command'], permission_mode: 'request-review' },
})

function agentResponse(delta, done = false) {
    return JSON.stringify({
        event: 'step_update',
        step_update: {
            conversation_id: CONV, step_index: 1, state: done ? 'DONE' : 'ACTIVE',
            step_type: 'agent_response', text_delta: delta,
            ...(done ? { usage: { input_tokens: 10, output_tokens: 4, thinking_tokens: 3, cache_read_tokens: 7, total_tokens: 14 } } : {}),
        },
    })
}

function toolError(tool, message) {
    return JSON.stringify({
        event: 'step_update',
        step_update: {
            conversation_id: CONV, step_index: 2, state: 'ERROR', step_type: 'tool', tool_name: tool,
            tool_info: { name: tool, parameters: {}, error: { type: 'TOOL_ERROR', message } },
        },
    })
}

function resultLine(extra = {}) {
    return JSON.stringify({
        event: 'result',
        result: {
            conversation_id: CONV, status: 'SUCCESS', response: 'DONE\n',
            duration_seconds: 3.2, num_turns: 1,
            usage: { input_tokens: 5283, output_tokens: 40, thinking_tokens: 36, cache_read_tokens: 8128, total_tokens: 5323 },
            ...extra,
        },
    })
}

test('full lifecycle: init -> agent_response -> result yields session, text, provider usage', () => {
    const p = createParser()
    p.acceptStdoutLine(INIT)
    p.acceptStdoutLine(agentResponse('IGNORED-fallback'))
    p.acceptStdoutLine(resultLine())
    const r = p.finish('', '')
    assert.equal(r.sessionId, CONV)
    assert.equal(r.finalText, 'DONE\n') // result.response is authoritative
    assert.equal(r.degraded, false)
    assert.deepEqual(r.refusals, [])
    assert.ok(r.usage)
    assert.equal(r.usage.input_tokens, 5283)
    assert.equal(r.usage.output_tokens, 40)
    assert.equal(r.usage.cached_input_tokens, 8128) // cache_read_tokens maps to cached_input_tokens
    assert.equal(r.usage.source, 'provider')
})

test('plan-mode auto-deny: SUCCESS + empty response + denied_actions is refusal evidence, not failure', () => {
    const p = createParser()
    p.acceptStdoutLine(INIT)
    p.acceptStdoutLine(resultLine({ response: '', denied_actions: [{ action: 'write_file', display_name: 'WriteToFile' }] }))
    const r = p.finish('', '')
    assert.equal(r.degraded, false)
    assert.equal(r.finalText, '') // legal terminal shape; terminal.js weighs refusals
    assert.deepEqual(r.refusals, ['denied:write_file'])
    assert.ok(r.warnings.some((w) => w.includes('denied action: write_file')))
})

test('explicit deny rule: step_update TOOL_ERROR permission message is refusal evidence', () => {
    const p = createParser()
    p.acceptStdoutLine(INIT)
    p.acceptStdoutLine(toolError('write_to_file', 'permission check failed for write_file "D:\\\\x": Permission denied for write_file(D:\\x). Matches user-configured deny rule.'))
    p.acceptStdoutLine(resultLine({ response: '写入被策略拦截。' }))
    const r = p.finish('', '')
    assert.equal(r.degraded, false)
    assert.deepEqual(r.refusals, ['permission-error:write_to_file'])
    assert.equal(r.finalText, '写入被策略拦截。')
})

test('sandbox unsandboxed denial: run_command TOOL_ERROR matches the permission pattern', () => {
    const p = createParser()
    p.acceptStdoutLine(INIT)
    p.acceptStdoutLine(toolError('run_command', 'permission check failed for unsandboxed "New-Item ...": user denied permission to run command'))
    p.acceptStdoutLine(resultLine({ response: '', denied_actions: [{ action: 'unsandboxed', display_name: 'RunCommand' }] }))
    const r = p.finish('', '')
    assert.deepEqual(r.refusals, ['permission-error:run_command', 'denied:unsandboxed'])
})

test('non-permission tool errors are warnings, not refusals', () => {
    const p = createParser()
    p.acceptStdoutLine(INIT)
    p.acceptStdoutLine(toolError('run_command', 'sandbox configuration error: readwrite /x: non-absolute file path'))
    p.acceptStdoutLine(resultLine())
    const r = p.finish('', '')
    assert.deepEqual(r.refusals, [])
    assert.ok(r.warnings.some((w) => w.includes('run_command reported error')))
})

test('non-JSON stdout line degrades the parser but keeps parsing', () => {
    const p = createParser()
    p.acceptStdoutLine(INIT)
    p.acceptStdoutLine('agy: unexpected banner')
    p.acceptStdoutLine(resultLine())
    const r = p.finish('', '')
    assert.equal(r.degraded, true)
    assert.equal(r.sessionId, CONV)
    assert.equal(r.finalText, 'DONE\n')
})

test('mid-line stdout EOF degrades the parser', () => {
    const p = createParser()
    p.acceptStdoutLine(INIT)
    const r = p.finish('{"event":"resu', '')
    assert.equal(r.degraded, true)
})

test('conflicting init/result conversation ids degrade instead of picking one silently', () => {
    const p = createParser()
    p.acceptStdoutLine(INIT)
    p.acceptStdoutLine(resultLine({ conversation_id: '99999999-0000-0000-0000-000000000000' }))
    const r = p.finish('', '')
    assert.equal(r.degraded, true)
    assert.equal(r.sessionId, CONV) // init stays authoritative
})

test('missing result event: fall back to agent_response deltas, warn, usage stays null', () => {
    const p = createParser()
    p.acceptStdoutLine(INIT)
    p.acceptStdoutLine(agentResponse('partial '))
    p.acceptStdoutLine(agentResponse('answer', true))
    const r = p.finish('', '')
    assert.equal(r.degraded, false)
    assert.equal(r.finalText, 'partial answer')
    assert.equal(r.usage, null)
    assert.ok(r.warnings.some((w) => w.includes('no result event')))
})

test('non-SUCCESS result status is refusal evidence', () => {
    const p = createParser()
    p.acceptStdoutLine(INIT)
    p.acceptStdoutLine(resultLine({ status: 'ERROR', response: '' }))
    const r = p.finish('', '')
    assert.deepEqual(r.refusals, ['result-status:ERROR'])
})

test('duplicate result events: keep the first, warn', () => {
    const p = createParser()
    p.acceptStdoutLine(INIT)
    p.acceptStdoutLine(resultLine())
    p.acceptStdoutLine(resultLine({ response: 'SECOND' }))
    const r = p.finish('', '')
    assert.equal(r.finalText, 'DONE\n')
    assert.ok(r.warnings.some((w) => w.includes('got 2')))
})

test('detectRefusals: jetski auto-deny and 1.1.28 print-timeout stderr markers', () => {
    assert.deepEqual(
        detectRefusals('jetski: no output produced — a tool required the "write_file" permission that headless mode cannot prompt for, so it was auto-denied. Add an allow-rule...', 0),
        ['headless-permission-auto-deny'],
    )
    assert.deepEqual(
        detectRefusals('[agy] print timeout after 30s with turn in progress; returning partial output', 0),
        ['print-timeout-partial-output'],
    )
    assert.deepEqual(detectRefusals('', 0), [])
    assert.deepEqual(detectRefusals('some random warning\n', 1), [])
})

test('parseAgyModelsOutput: TSV id<TAB>display-name rows (live shape 1.1.28)', () => {
    const text = 'gemini-3.8-flash-high\tGemini 3.8 Flash (High)\ngemini-3.1-pro-low\tGemini 3.1 Pro (Low)\n'
    const { models, notes } = parseAgyModelsOutput(text)
    assert.deepEqual(models, [
        { alias: 'gemini-3.8-flash-high', connection: 'google-oauth' },
        { alias: 'gemini-3.1-pro-low', connection: 'google-oauth' },
    ])
    assert.ok(notes.length > 0)
    assert.deepEqual(parseAgyModelsOutput('').models, [])
})
