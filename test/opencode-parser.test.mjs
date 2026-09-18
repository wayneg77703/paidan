// Golden fixtures for the opencode-run parser (src/endpoints/opencode-run.ts).
// Event shapes mirror opencode 1.18.29 live streams captured 2026-09-10 plus
// the retired suite fixtures (archived 2026-09-12; opencode-cli golden captures); no real agent is touched.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createParser, detectRefusals } from '../dist/endpoints/opencode-run.js'

const SES = 'ses_f778b9003ffeTjZhm6ykGRnthW'
const STEP_START = `{"type":"step_start","timestamp":1,"sessionID":"${SES}","part":{"id":"prt_1","type":"step-start"}}`
const TEXT_OK = `{"type":"text","timestamp":2,"sessionID":"${SES}","part":{"id":"prt_2","type":"text","text":"ok"}}`
const STEP_FIN_OK = `{"type":"step_finish","timestamp":3,"sessionID":"${SES}","part":{"id":"prt_3","type":"step-finish","reason":"stop","tokens":{"total":8408,"input":6599,"output":17,"reasoning":0,"cache":{"write":0,"read":1792}},"cost":0}}`

test('normal run: text is the final answer, sessionID is the handle, single step_finish gives provider usage', () => {
    const p = createParser()
    for (const line of [STEP_START, TEXT_OK, STEP_FIN_OK]) p.acceptStdoutLine(line)
    const r = p.finish('', '')
    assert.equal(r.finalText, 'ok')
    assert.equal(r.sessionId, SES)
    assert.equal(r.degraded, false)
    assert.deepEqual(r.usage, {
        input_tokens: 6599,
        output_tokens: 17,
        cached_input_tokens: 1792,
        cost: null,
        source: 'provider',
    })
})

test('multi-step write run: blank text parts skipped, tool_use ignored, multiple step_finish collapses usage honestly', () => {
    // Live shape (2026-09-10): a write task emits tool_use + 3 step_finish events.
    const blank = `{"type":"text","timestamp":2,"sessionID":"${SES}","part":{"type":"text","text":"\\n\\n"}}`
    const tool = `{"type":"tool_use","timestamp":3,"sessionID":"${SES}","part":{"type":"tool","tool":"write","state":{"status":"completed"}}}`
    const finZero = `{"type":"step_finish","timestamp":4,"sessionID":"${SES}","part":{"type":"step-finish","reason":"unknown","tokens":{"input":0,"output":0,"reasoning":0,"cache":{"write":0,"read":0}},"cost":0}}`
    const finTool = `{"type":"step_finish","timestamp":5,"sessionID":"${SES}","part":{"type":"step-finish","reason":"tool-calls","tokens":{"total":8617,"input":6715,"output":110,"reasoning":0,"cache":{"write":0,"read":1792}}}}`
    const done = `{"type":"text","timestamp":6,"sessionID":"${SES}","part":{"type":"text","text":"done"}}`
    const finStop = `{"type":"step_finish","timestamp":7,"sessionID":"${SES}","part":{"type":"step-finish","reason":"stop","tokens":{"total":8635,"input":184,"output":3,"reasoning":0,"cache":{"write":0,"read":8448}}}}`
    const p = createParser()
    for (const line of [STEP_START, blank, tool, finZero, finTool, done, finStop]) p.acceptStdoutLine(line)
    const r = p.finish('', '')
    assert.equal(r.degraded, false)
    assert.equal(r.finalText, 'done')
    assert.equal(r.sessionId, SES)
    assert.equal(r.usage, null)
    assert.ok(r.warnings.some((w) => w.includes('multiple step_finish')))
})

test('plan-agent refusal run: stream stays valid, refusal lives in finalText, no in-band error and no stderr signature', () => {
    // Live P2 shape (2026-09-10): exit 0, file absent, refusal explained in text.
    const refusal = `{"type":"text","timestamp":2,"sessionID":"${SES}","part":{"type":"text","text":"I'm in plan mode, so I can't create the file yet."}}`
    const p = createParser()
    for (const line of [STEP_START, refusal, STEP_FIN_OK]) p.acceptStdoutLine(line)
    const r = p.finish('', '')
    assert.equal(r.degraded, false)
    assert.ok(r.finalText.includes('plan mode'))
    assert.deepEqual(r.refusals, [])
    assert.deepEqual(detectRefusals('', 0), [])
    assert.deepEqual(detectRefusals('some benign stderr noise\n', 1), [])
})

test('in-band error events: 1.18.29 error.data.message and legacy part.message both surface as warnings + refusals', () => {
    const errNew = `{"type":"error","timestamp":2,"sessionID":"${SES}","error":{"name":"UnknownError","data":{"message":"unknown certificate verification error"}}}`
    const p = createParser()
    p.acceptStdoutLine(STEP_START)
    p.acceptStdoutLine(errNew)
    const r = p.finish('', '')
    assert.equal(r.degraded, false)
    assert.ok(r.refusals.some((x) => x.includes('certificate verification')))
    assert.ok(r.warnings.some((w) => w.includes('in-band error event')))

    const errLegacy = `{"type":"error","timestamp":3,"sessionID":"${SES}","part":{"message":"provider failed"}}`
    const p2 = createParser()
    p2.acceptStdoutLine(errLegacy)
    const r2 = p2.finish('', '')
    assert.ok(r2.refusals.some((x) => x.includes('provider failed')))
})

test('non-JSON stdout line degrades the parser but keeps parsing', () => {
    const p = createParser()
    p.acceptStdoutLine(STEP_START)
    p.acceptStdoutLine('opencode: some drift banner') // not JSON
    p.acceptStdoutLine(TEXT_OK)
    p.acceptStdoutLine(STEP_FIN_OK)
    const r = p.finish('', '')
    assert.equal(r.degraded, true)
    assert.ok(r.warnings.some((w) => w.includes('non-JSON')))
    assert.equal(r.finalText, 'ok')
    assert.equal(r.usage?.source, 'provider')
})

test('mid-line stdout EOF degrades the parser', () => {
    const p = createParser()
    p.acceptStdoutLine(TEXT_OK)
    const r = p.finish('{"type":"step_fin', '')
    assert.equal(r.degraded, true)
    assert.ok(r.warnings.some((w) => w.includes('mid-line')))
})

test('session drift: multiple distinct sessionID values degrade and drop the handle', () => {
    const other = '{"type":"text","timestamp":2,"sessionID":"ses_other","part":{"type":"text","text":"drifted"}}'
    const p = createParser()
    for (const line of [STEP_START, other, STEP_FIN_OK]) p.acceptStdoutLine(line)
    const r = p.finish('', '')
    assert.equal(r.degraded, true)
    assert.equal(r.sessionId, null)
    assert.ok(r.warnings.some((w) => w.includes('session drift')))
})

test('usage honesty: missing step_finish or invalid tokens -> null + warning, parse not degraded', () => {
    const p0 = createParser()
    p0.acceptStdoutLine(STEP_START)
    p0.acceptStdoutLine(TEXT_OK)
    const r0 = p0.finish('', '')
    assert.equal(r0.usage, null)
    assert.equal(r0.degraded, false)
    assert.ok(r0.warnings.some((w) => w.includes('no step_finish')))

    const badTokens = `{"type":"step_finish","timestamp":3,"sessionID":"${SES}","part":{"type":"step-finish","reason":"stop","tokens":{"input":-1,"output":2,"cache":{"read":0}}}}`
    const p1 = createParser()
    for (const line of [STEP_START, TEXT_OK, badTokens]) p1.acceptStdoutLine(line)
    const r1 = p1.finish('', '')
    assert.equal(r1.usage, null)
    assert.equal(r1.degraded, false)
    assert.ok(r1.warnings.some((w) => w.includes('tokens missing or invalid')))
})

test('unknown event type is known-benign drift: warning only, never degraded', () => {
    const future = `{"type":"future_event","timestamp":2,"sessionID":"${SES}","part":{"future":true}}`
    const p = createParser()
    for (const line of [STEP_START, future, TEXT_OK, STEP_FIN_OK]) p.acceptStdoutLine(line)
    const r = p.finish('', '')
    assert.equal(r.degraded, false)
    assert.ok(r.warnings.some((w) => w.includes('unknown event type')))
    assert.equal(r.finalText, 'ok')
    assert.equal(r.usage?.source, 'provider')
})
