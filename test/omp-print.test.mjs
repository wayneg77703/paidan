// Golden fixtures for the omp-print parser (src/endpoints/omp-print.ts).
// Event shapes mirror oh-my-pi 18.1.14 live streams captured 2026-09-10
// (read-only refusal and write-tier runs); no real agent is touched.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createOmpPrintParser, detectOmpRefusals, parseOmpModelsJson } from '../dist/endpoints/omp-print.js'

const SESSION = '{"type":"session","version":3,"id":"01a08873-065c-7281-98b2-ca60c2402dc9","timestamp":"2026-09-09T23:13:54.780Z","cwd":"D:\\\\work"}'
const AGENT_START = '{"type":"agent_start"}'
const TURN_START = '{"type":"turn_start"}'
const ADVISOR = '{"type":"advisor_cost_changed"}'
const MSG_START_USER = '{"type":"message_start","message":{"role":"user","content":[{"type":"text","text":"Reply with exactly: ok"}]}}'
const MSG_UPDATE = '{"type":"message_update","assistantMessageEvent":{"type":"text_delta"}}'
const TOOL_EXEC = '{"type":"tool_execution_start","toolName":"bash"}'
const TURN_OK =
    '{"type":"turn_end","message":{"role":"assistant","content":[{"type":"text","text":"ok"}],"provider":"deepseek","model":"deepseek-v4-pro","usage":{"input":18977,"output":2,"cacheRead":0,"cacheWrite":0,"totalTokens":18979,"cost":{"total":0.008256735}},"stopReason":"stop"},"toolResults":[]}'
const AGENT_END_OK =
    '{"type":"agent_end","messages":[{"role":"user","content":[{"type":"text","text":"Reply with exactly: ok"}]},{"role":"assistant","content":[{"type":"text","text":"ok"}],"usage":{"input":18977,"output":2,"cacheRead":0},"stopReason":"stop"}],"isTerminal":true}'

test('normal run: session id is the handle, finalText from turn_end, sole-turn usage is provider', () => {
    const p = createOmpPrintParser()
    for (const line of [SESSION, ADVISOR, AGENT_START, TURN_START, MSG_START_USER, MSG_UPDATE, TURN_OK, AGENT_END_OK]) {
        p.acceptStdoutLine(line)
    }
    const r = p.finish('', '')
    assert.equal(r.finalText, 'ok')
    assert.equal(r.sessionId, '01a08873-065c-7281-98b2-ca60c2402dc9')
    assert.equal(r.degraded, false)
    assert.deepEqual(r.refusals, [])
    assert.deepEqual(r.usage, {
        input_tokens: 18977,
        output_tokens: 2,
        cached_input_tokens: 0,
        cost: null,
        source: 'provider',
    })
})

test('read-only refusal run: approval-gated toolResults are refusal evidence, multi-turn usage stays unavailable', () => {
    // Live P2 shape (18.1.14, 2026-09-10): bash and task denied, file absent, exit 0.
    const denyBash =
        '{"type":"turn_end","message":{"role":"assistant","content":[{"type":"thinking","thinking":"..."},{"type":"toolCall","name":"bash","arguments":{"command":"printf x > ro.txt"}}],"usage":{"input":100,"output":10,"cacheRead":0},"stopReason":"toolUse"},"toolResults":[{"role":"toolResult","toolCallId":"c1","toolName":"bash","content":[{"type":"text","text":"Tool \\"bash\\" requires approval but no interactive UI available.\\nOptions:..."}],"isError":true}]}'
    const denyTask =
        '{"type":"turn_end","message":{"role":"assistant","content":[{"type":"toolCall","name":"task","arguments":{}}],"usage":{"input":120,"output":8,"cacheRead":0},"stopReason":"toolUse"},"toolResults":[{"role":"toolResult","toolCallId":"c2","toolName":"task","content":[{"type":"text","text":"Tool \\"task\\" requires approval but no interactive UI available."}],"isError":true}]}'
    const finalTurn =
        '{"type":"turn_end","message":{"role":"assistant","content":[{"type":"text","text":"Blocked. Cannot create the file: bash and task require approval; no write tool in this session."}],"usage":{"input":150,"output":30,"cacheRead":0},"stopReason":"stop"},"toolResults":[]}'
    const agentEnd =
        '{"type":"agent_end","messages":[{"role":"assistant","content":[{"type":"text","text":"Blocked. Cannot create the file: bash and task require approval; no write tool in this session."}],"stopReason":"stop"}],"isTerminal":true}'
    const p = createOmpPrintParser()
    for (const line of [SESSION, AGENT_START, TURN_START, denyBash, TOOL_EXEC, denyTask, finalTurn, agentEnd]) {
        p.acceptStdoutLine(line)
    }
    const r = p.finish('', '')
    assert.equal(r.degraded, false)
    assert.ok(r.finalText.startsWith('Blocked.'))
    assert.deepEqual(r.usage, null)
    assert.ok(r.warnings.some((w) => w.includes('multiple turn_end')))
    assert.ok(r.refusals.includes('approval-unavailable-headless:bash'))
    assert.ok(r.refusals.includes('approval-unavailable-headless:task'))
})

test('max-time deadline stop: aborted message + "Deadline exceeded" string together flag the truncation', () => {
    const abortedTurn =
        '{"type":"turn_end","message":{"role":"assistant","content":[{"type":"text","text":"partial answer so far"}],"stopReason":"aborted"},"toolResults":[{"role":"toolResult","toolName":"bash","content":[{"type":"text","text":"Deadline exceeded"}],"isError":true}]}'
    const p = createOmpPrintParser()
    for (const line of [SESSION, AGENT_START, TURN_START, abortedTurn, AGENT_END_OK]) p.acceptStdoutLine(line)
    const r = p.finish('', '')
    assert.ok(r.refusals.some((x) => x.startsWith('native-max-time-exceeded')))
    // a user-controlled echo of the string alone never flags: covered by the
    // converse case below (abort without the string)
    const p2 = createOmpPrintParser()
    const abortedOnly =
        '{"type":"turn_end","message":{"role":"assistant","content":[{"type":"text","text":"partial"}],"stopReason":"aborted"},"toolResults":[]}'
    for (const line of [SESSION, AGENT_START, abortedOnly]) p2.acceptStdoutLine(line)
    const r2 = p2.finish('', '')
    assert.ok(r2.refusals.some((x) => x.startsWith('session-aborted')))
    assert.ok(!r2.refusals.some((x) => x.startsWith('native-max-time-exceeded')))
})

test('non-JSON stdout line degrades the parser but parsing continues', () => {
    const p = createOmpPrintParser()
    p.acceptStdoutLine(SESSION)
    p.acceptStdoutLine('omp: some drift banner')
    p.acceptStdoutLine(TURN_OK)
    p.acceptStdoutLine(AGENT_END_OK)
    const r = p.finish('', '')
    assert.equal(r.degraded, true)
    assert.ok(r.warnings.some((w) => w.includes('non-JSON')))
    assert.equal(r.finalText, 'ok')
    assert.equal(r.sessionId, '01a08873-065c-7281-98b2-ca60c2402dc9')
})

test('unknown top-level event types warn but never degrade (suite preserve-and-ignore)', () => {
    const p = createOmpPrintParser()
    p.acceptStdoutLine(SESSION)
    p.acceptStdoutLine('{"type":"tool_execution_end","toolName":"bash"}') // known since 18.x
    p.acceptStdoutLine('{"type":"some_future_event","x":1}')
    p.acceptStdoutLine(TURN_OK)
    const r = p.finish('', '')
    assert.equal(r.degraded, false)
    assert.ok(r.warnings.some((w) => w.includes('unknown event types')))
    assert.equal(r.finalText, 'ok')
})

test('multiple distinct session ids: no trustworthy handle, warning only', () => {
    const other = '{"type":"session","version":3,"id":"bbbbbbbb-065c-7281-98b2-ca60c2402dc9"}'
    const p = createOmpPrintParser()
    for (const line of [SESSION, other, TURN_OK]) p.acceptStdoutLine(line)
    const r = p.finish('', '')
    assert.equal(r.sessionId, null)
    assert.ok(r.warnings.some((w) => w.includes('unique session id')))
    assert.equal(r.degraded, false)
})

test('sole turn_end with invalid usage collapses usage to null with a warning', () => {
    const bad = '{"type":"turn_end","message":{"role":"assistant","content":[{"type":"text","text":"ok"}],"usage":{"input":10,"output":1,"cacheRead":-3},"stopReason":"stop"},"toolResults":[]}'
    const p = createOmpPrintParser()
    for (const line of [SESSION, bad]) p.acceptStdoutLine(line)
    const r = p.finish('', '')
    assert.equal(r.usage, null)
    assert.ok(r.warnings.some((w) => w.includes('usage missing or invalid')))
    assert.equal(r.degraded, false)
})

test('finalText falls back to the last agent_end assistant text when turn_end carried none', () => {
    const emptyTurn = '{"type":"turn_end","message":{"role":"assistant","content":[],"stopReason":"stop"},"toolResults":[]}'
    const agentEnd =
        '{"type":"agent_end","messages":[{"role":"assistant","content":[{"type":"text","text":"from agent_end"}],"stopReason":"stop"}],"isTerminal":true}'
    const p = createOmpPrintParser()
    for (const line of [SESSION, emptyTurn, agentEnd]) p.acceptStdoutLine(line)
    const r = p.finish('', '')
    assert.equal(r.finalText, 'from agent_end')
})

test('in-band provider error events and message errors are refusal evidence (never auto-failure here)', () => {
    const errEvent = '{"type":"error","message":"{\\"status\\":401}"}'
    const errTurn =
        '{"type":"turn_end","message":{"role":"assistant","content":[],"stopReason":"error","errorStatus":"401","errorMessage":"Unauthorized"},"toolResults":[]}'
    const p = createOmpPrintParser()
    for (const line of [SESSION, errEvent, errTurn]) p.acceptStdoutLine(line)
    const r = p.finish('', '')
    assert.ok(r.refusals.some((x) => x.startsWith('provider error event')))
    assert.ok(r.refusals.some((x) => x.startsWith('assistant message error')))
    assert.ok(r.refusals.includes('provider-auth-error'))
})

test('mid-line stdout EOF degrades the parser', () => {
    const p = createOmpPrintParser()
    p.acceptStdoutLine(TURN_OK)
    const r = p.finish('{"type":"agent_en', '')
    assert.equal(r.degraded, true)
    assert.ok(r.warnings.some((w) => w.includes('mid-line')))
})

test('detectRefusals: CliUsageError / unknown --tools signatures; benign stderr stays silent', () => {
    assert.deepEqual(detectOmpRefusals('CliUsageError: Unknown tools in --tools: write\n', 1).sort(), [
        'cli-usage-error',
        'unknown-tools-in-toolset',
    ])
    assert.deepEqual(detectOmpRefusals('', null), [])
    assert.deepEqual(detectOmpRefusals('some random warning\n', 0), [])
})

test('model discovery parses `omp models --json` selector/provider pairs honestly', () => {
    const live =
        '{"models":[{"provider":"deepseek","id":"deepseek-v4-flash","selector":"deepseek/deepseek-v4-flash","thinking":["low","high","max"]},{"provider":"deepseek","id":"deepseek-v4-pro","selector":"deepseek/deepseek-v4-pro"}]}'
    const { models, notes } = parseOmpModelsJson(live)
    assert.deepEqual(models, [
        { alias: 'deepseek/deepseek-v4-flash', connection: 'deepseek' },
        { alias: 'deepseek/deepseek-v4-pro', connection: 'deepseek' },
    ])
    assert.equal(notes.length, 0)
    // broken output is a discovery failure (throws - the caller keeps the last
    // good cache), NOT an honest empty catalog; a well-formed empty catalog stays empty
    assert.throws(() => parseOmpModelsJson('not json'), /non-JSON/)
    assert.throws(() => parseOmpModelsJson('{"other":1}'), /no models array/)
    assert.deepEqual(parseOmpModelsJson('{"models":[]}').models, [])
})
