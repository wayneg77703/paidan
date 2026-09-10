// Golden fixtures for the kimi-print parser (src/endpoints/kimi-print.ts).
// No real agent is touched; fixtures are constructed stream-json samples.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createKimiPrintParser, detectKimiRefusals, discoverKimiModels, readKimiNativeDefaults } from '../dist/endpoints/kimi-print.js'

const FIXTURE_NORMAL = [
    '{"role":"assistant","content":"Hello, "}',
    '{"role":"assistant","content":"world."}',
    '{"role":"meta","type":"session.resume_hint","session_id":"session_abc123def","command":"kimi -r session_abc123def"}',
]

test('normal stream-json: text accumulates, session hint extracted, not degraded', () => {
    const p = createKimiPrintParser()
    for (const line of FIXTURE_NORMAL) p.acceptStdoutLine(line)
    const r = p.finish('', '')
    assert.equal(r.finalText, 'Hello, world.')
    assert.equal(r.sessionId, 'session_abc123def')
    assert.equal(r.resumeHint, 'kimi -r session_abc123def')
    assert.equal(r.degraded, false)
    assert.equal(r.usage, null)
})

test('non-JSON stdout line degrades the parser but keeps parsing', () => {
    const p = createKimiPrintParser()
    p.acceptStdoutLine('{"role":"assistant","content":"partial"}')
    p.acceptStdoutLine('kimi: something unexpected happened') // drift / banner line
    p.acceptStdoutLine(FIXTURE_NORMAL[2])
    const r = p.finish('', '')
    assert.equal(r.degraded, true)
    assert.ok(r.warnings.some((w) => w.includes('non-JSON')))
    assert.equal(r.finalText, 'partial')
    assert.equal(r.sessionId, 'session_abc123def')
})

test('mid-line stdout EOF degrades the parser', () => {
    const p = createKimiPrintParser()
    p.acceptStdoutLine('{"role":"assistant","content":"x"}')
    const r = p.finish('{"role":"assis', '')
    assert.equal(r.degraded, true)
})

test('stderr whole-line resume hint is accepted; in-line mention is ignored', () => {
    const p = createKimiPrintParser()
    p.acceptStderrLine('some noise')
    p.acceptStderrLine('To resume this session: kimi -r session_zzz999888')
    p.acceptStderrLine('the docs say you can run kimi -r session_fake0000 anywhere') // content, not identity
    const r = p.finish('', '')
    assert.equal(r.sessionId, 'session_zzz999888')
})

test('conflicting stdout/stderr session hints degrade instead of picking one', () => {
    const p = createKimiPrintParser()
    p.acceptStdoutLine(FIXTURE_NORMAL[2])
    p.acceptStderrLine('kimi -r session_other9999')
    const r = p.finish('', '')
    assert.equal(r.degraded, true)
    assert.equal(r.sessionId, 'session_abc123def') // stdout stays authoritative
})

test('provider safety block is refusal evidence only with non-zero exit', () => {
    const stderr = 'Error: failed to run prompt: Provider safety policy blocked the response.\n'
    assert.deepEqual(detectKimiRefusals(stderr, 1), ['provider-safety-blocked'])
    assert.deepEqual(detectKimiRefusals(stderr, 0), [])
    assert.deepEqual(detectKimiRefusals('ordinary warning\n', 1), [])
})

test('model discovery scans native config.toml aliases honestly', () => {
    const toml = '[providers."kimi-for-coding"]\nmodel = "kimi-for-coding/k3"\n# managed:kimi-code oauth\nother = "managed:kimi-code/k2"\n'
    const { models, notes } = discoverKimiModels(toml)
    assert.ok(models.some((m) => m.alias === 'kimi-for-coding/k3' && m.connection === 'kimi-for-coding'))
    assert.ok(notes.length > 0)
    const none = discoverKimiModels(null)
    assert.deepEqual(none.models, [])
})

test('readKimiNativeDefaults: top-level default_model + [thinking] section effort', () => {
    const toml = 'default_model = "kimi-code/k3"\ntelemetry = false\n[thinking]\neffort = "max"\n[provider.x]\ndefault_model = "scoped"\neffort = "low"\n'
    const d = readKimiNativeDefaults(toml)
    assert.equal(d.model, 'kimi-code/k3')
    assert.equal(d.effort, 'max')
    const partial = readKimiNativeDefaults('default_model = "kimi-code/k3"\n[provider.x]\n')
    assert.equal(partial.model, 'kimi-code/k3')
    assert.equal(partial.effort, null)
    const none = readKimiNativeDefaults(null)
    assert.equal(none.model, null)
    assert.ok((none.notes ?? []).length > 0)
})
