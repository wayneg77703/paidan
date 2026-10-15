// Fixtures mirror the installed DSH 0.2.0-rc.2 JSON projection. No model calls.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDshHeadlessParser, detectDshRefusals } from '../dist/endpoints/dsh-headless.js'
function parse(events, tail = '') { const p = createDshHeadlessParser(); for (const e of events) p.acceptStdoutLine(typeof e === 'string' ? e : JSON.stringify(e)); return p.finish(tail, '') }
const session = { type: 'session', sessionId: 'session-fixture', cwd: '/fixture' }
const end = (step, usage, turn = 1) => ({ type: 'status', phase: 'step_end', turn, step, ...(usage ? { usage } : {}) })
const sample = { inputTokens: 12, outputTokens: 3, cacheReadTokens: 8 }
const final = { type: 'final', text: 'DONE' }

test('current invocation sums distinct root steps, not text or final duplicates', () => {
    const r = parse([session, end(1, sample), { type: 'text', text: 'interim' }, end(2, sample), final])
    assert.equal(r.sessionId, 'session-fixture'); assert.equal(r.finalText, 'DONE'); assert.equal(r.degraded, false)
    assert.deepEqual(r.usage, { input_tokens: 24, output_tokens: 6, cached_input_tokens: 16, cost: null, source: 'provider' })
    assert.ok(r.warnings.some(w => w.includes('child sessions are not included')))
})
test('duplicate step is idempotent; same step in another turn is distinct', () => {
    assert.equal(parse([session, end(1, sample), end(1, sample), final]).usage.input_tokens, 12)
    assert.equal(parse([session, end(1, sample), end(1, sample, 2), final]).usage.input_tokens, 24)
    const r = parse([session, end(1, sample), end(1, { ...sample, inputTokens: 13 }), final])
    assert.equal(r.usage, null); assert.equal(r.degraded, true)
})
test('a missing attempt/step sample makes the total unknown, not a partial sum', () => {
    assert.equal(parse([session, end(1, sample), end(2), final]).usage, null)
    assert.equal(parse([session, final]).usage, null)
    assert.equal(parse([session, end(1, { inputTokens: 0, outputTokens: 0 }), final]).usage.cached_input_tokens, null)
})
test('optional cache must be reported on every step; zero is genuine evidence', () => {
    const r = parse([session, end(1, sample), end(2, { inputTokens: 0, outputTokens: 0 }), final])
    assert.equal(r.usage.input_tokens, 12); assert.equal(r.usage.cached_input_tokens, null)
    assert.equal(parse([session, end(1, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }), final]).usage.input_tokens, 0)
})
test('truncated final, unclosed step, missing final and malformed events fail closed', () => {
    for (const events of [[session, end(1, sample)], [session, end(1, sample), { ...final, truncated: true }],
        [session, { type: 'status', phase: 'step_start', turn: 1, step: 2 }, final], [session, 'not JSON', final],
        [session, end(1, sample), { type: 'new_unknown_event' }, final], [session, final, end(1, sample)]]) {
        const r = parse(events); assert.equal(r.degraded, true); assert.equal(r.usage, null)
    }
})
test('complete final without trailing newline is accepted; partial JSON is not', () => {
    assert.equal(parse([session, end(1, sample)], JSON.stringify(final)).finalText, 'DONE')
    assert.equal(parse([session], '{"type":"final"').degraded, true)
})
test('invalid counters and unsafe totals cannot become usage facts', () => {
    for (const value of [-1, 1.5, '12', null, 1e20]) assert.equal(parse([session, end(1, { ...sample, inputTokens: value }), final]).usage, null)
    assert.equal(parse([session, end(1, { ...sample, inputTokens: Number.MAX_SAFE_INTEGER }), end(2, sample), final]).usage, null)
})
test('tool and final refusal evidence persists despite exit-zero text', () => {
    const refusal = 'file access denied under read-only mode; requires approval, but no approval channel is available'
    const r = parse([session, { type: 'tool_result', result: refusal }, final])
    assert.deepEqual(r.refusals.sort(), ['approval-channel-unavailable', 'sandbox-file-access-denied'])
    assert.deepEqual(detectDshRefusals(refusal, 0).sort(), r.refusals)
    assert.deepEqual(detectDshRefusals('', 1), [])
})
test('plain legacy stdout is unknown instead of masquerading as JSON success', () => {
    const r = parse(['DONE']); assert.equal(r.degraded, true); assert.equal(r.finalText, ''); assert.equal(r.sessionId, null)
})
