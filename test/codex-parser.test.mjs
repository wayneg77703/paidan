// Golden fixtures for the codex-exec parser (src/endpoints/codex-exec.ts).
// Event shapes mirror codex-cli 0.153.3 live streams captured 2026-09-10;
// no real agent is touched.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createCodexExecParser, detectCodexRefusals, discoverCodexModels } from '../dist/endpoints/codex-exec.js'

const THREAD = '{"type":"thread.started","thread_id":"01a087fe-9732-7520-b210-75d94a4cd4b9"}'
const TURN_START = '{"type":"turn.started"}'
const MSG_PROGRESS = '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"I will create the file.\\n"}}'
const MSG_FINAL = '{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"done"}}'
const TURN_OK = '{"type":"turn.completed","usage":{"input_tokens":79038,"cached_input_tokens":45696,"cache_write_input_tokens":0,"output_tokens":179,"reasoning_output_tokens":26}}'

test('normal run: last agent_message wins, thread_id is the session handle, provider usage extracted', () => {
    const p = createCodexExecParser()
    for (const line of [THREAD, TURN_START, MSG_PROGRESS, MSG_FINAL, TURN_OK]) p.acceptStdoutLine(line)
    const r = p.finish('', '')
    assert.equal(r.finalText, 'done')
    assert.equal(r.sessionId, '01a087fe-9732-7520-b210-75d94a4cd4b9')
    assert.equal(r.resumeHint, null)
    assert.equal(r.degraded, false)
    assert.deepEqual(r.usage, {
        input_tokens: 79038,
        output_tokens: 179,
        cached_input_tokens: 45696,
        cost: null,
        source: 'provider',
    })
})

test('sandbox refusal run: stream stays valid, refusal text lands in finalText, stderr signature flagged at exit 0', () => {
    // Live P2 shape (2026-09-10): exit 0, file absent, denial on stderr.
    const refusalMsg =
        '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"Couldn\'t create ro.txt: the read-only sandbox rejected the write."}}'
    const p = createCodexExecParser()
    for (const line of [THREAD, TURN_START, refusalMsg, TURN_OK]) p.acceptStdoutLine(line)
    const r = p.finish('', '')
    assert.equal(r.degraded, false)
    assert.ok(r.finalText.includes('read-only sandbox'))
    const stderr =
        '2026-09-09T21:10:02Z ERROR codex_core::tools::router: error=patch rejected: writing is blocked by read-only sandbox; rejected by user approval settings\n'
    assert.deepEqual(detectCodexRefusals(stderr, 0).sort(), ['approval-settings-rejected', 'sandbox-write-blocked'])
})

test('non-JSON stdout line degrades the parser but keeps parsing', () => {
    const p = createCodexExecParser()
    p.acceptStdoutLine(THREAD)
    p.acceptStdoutLine('codex: some drift banner') // not JSON
    p.acceptStdoutLine(MSG_FINAL)
    p.acceptStdoutLine(TURN_OK)
    const r = p.finish('', '')
    assert.equal(r.degraded, true)
    assert.ok(r.warnings.some((w) => w.includes('non-JSON')))
    assert.equal(r.finalText, 'done')
    assert.equal(r.sessionId, '01a087fe-9732-7520-b210-75d94a4cd4b9')
    assert.equal(r.usage?.source, 'provider')
})

test('unknown top-level event type degrades; unknown item types are ignored', () => {
    const p = createCodexExecParser()
    p.acceptStdoutLine(THREAD)
    p.acceptStdoutLine('{"type":"item.started","item":{"id":"item_0","type":"some_future_item"}}')
    p.acceptStdoutLine('{"type":"token_count","info":{"total":123}}') // drift candidate
    p.acceptStdoutLine(MSG_FINAL)
    p.acceptStdoutLine(TURN_OK)
    const r = p.finish('', '')
    assert.equal(r.degraded, true)
    assert.ok(r.warnings.some((w) => w.includes('unknown event type')))
    assert.equal(r.finalText, 'done')
})

test('usage clamps: cached > input collapses usage to null with a warning, parse not degraded', () => {
    const badUsage = '{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":20,"output_tokens":1}}'
    const p = createCodexExecParser()
    for (const line of [THREAD, TURN_START, MSG_FINAL, badUsage]) p.acceptStdoutLine(line)
    const r = p.finish('', '')
    assert.equal(r.usage, null)
    assert.equal(r.degraded, false)
    assert.ok(r.warnings.some((w) => w.includes('usage')))
})

test('multiple turn.completed events sum usage (adapter semantics)', () => {
    const second = '{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":0,"output_tokens":5}}'
    const p = createCodexExecParser()
    for (const line of [THREAD, TURN_START, MSG_FINAL, TURN_OK, second]) p.acceptStdoutLine(line)
    const r = p.finish('', '')
    assert.deepEqual(r.usage, {
        input_tokens: 79138,
        output_tokens: 184,
        cached_input_tokens: 45696,
        cost: null,
        source: 'provider',
    })
})

test('turn.failed and top-level error events: no crash, usage null without turn.completed', () => {
    const errEvent = '{"type":"error","message":"{\\"type\\":\\"error\\",\\"status\\":400}"}'
    const turnFailed = '{"type":"turn.failed","error":{"message":"model is not supported"}}'
    const p = createCodexExecParser()
    for (const line of [THREAD, TURN_START, errEvent, turnFailed]) p.acceptStdoutLine(line)
    const r = p.finish('', '')
    assert.equal(r.degraded, false)
    assert.equal(r.usage, null)
    assert.equal(r.finalText, '')
    assert.ok(r.warnings.some((w) => w.includes('turn.failed')))
    assert.ok(r.warnings.some((w) => w.includes('error event')))
})

test('soft in-band error item is a warning, never a degrade', () => {
    const errItem = '{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Code Mode is unavailable"}}'
    const p = createCodexExecParser()
    for (const line of [THREAD, TURN_START, errItem, MSG_FINAL, TURN_OK]) p.acceptStdoutLine(line)
    const r = p.finish('', '')
    assert.equal(r.degraded, false)
    assert.ok(r.warnings.some((w) => w.includes('in-band error item')))
    assert.equal(r.finalText, 'done')
})

test('mid-line stdout EOF degrades the parser', () => {
    const p = createCodexExecParser()
    p.acceptStdoutLine(MSG_FINAL)
    const r = p.finish('{"type":"turn.compl', '')
    assert.equal(r.degraded, true)
    assert.ok(r.warnings.some((w) => w.includes('mid-line')))
})

test('detectRefusals: untrusted-directory pre-flight refusal; benign stderr stays silent', () => {
    assert.deepEqual(
        detectCodexRefusals('Not inside a trusted directory and --skip-git-repo-check was not specified.\n', 1),
        ['untrusted-directory'],
    )
    // transient tool-router noise observed on successful runs must not be flagged
    const benign = '2026-09-09T21:08:49Z ERROR codex_core::tools::router: error=exec_command failed: CreateProcess { message: "Rejected(\\"Failed to create unified exec process: orchestrator_helper_launch_failed\\")" }\n'
    assert.deepEqual(detectCodexRefusals(benign, 0), [])
    assert.deepEqual(detectCodexRefusals('', null), [])
})

test('model discovery reads the native config.toml top-level model key honestly', () => {
    const toml = 'model = "gpt-6-astra"\napproval_policy = "on-request"\n[mcp_servers.node_repl]\nmodel = "not-top-level"\n'
    const { models, notes } = discoverCodexModels(toml, true)
    assert.deepEqual(models, [{ alias: 'gpt-6-astra', connection: 'chatgpt-login' }])
    assert.ok(notes.length > 0)
    const none = discoverCodexModels(null, false)
    assert.deepEqual(none.models, [])
    const noKey = discoverCodexModels('[mcp_servers.x]\nmodel = "scoped"\n', false)
    assert.deepEqual(noKey.models, [])
})
