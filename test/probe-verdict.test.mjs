import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PaidanError } from '../dist/engine/errors.js'
import { probeBlocker, readonlyProbeVerdict, probeError } from '../dist/commands/probe.js'

function result(refusals = [], notes = []) {
    return {
        state: 'unknown', exit_code: 0, final_text: '',
        evidence: { refusals, notes, deliverables: [], parser: { type: 'test', degraded: false } },
    }
}
const verdict = (r, extra = {}) => readonlyProbeVerdict({
    fileCreated: false, state: 'unknown', result: r, timedOut: false, ...extra,
})

test('readonly probe accepts only attributable file or execution permission evidence', () => {
    for (const signal of [
        'sandbox-file-access-denied', 'approval-channel-unavailable', 'sandbox-write-blocked',
        'approval-settings-rejected', 'headless-permission-auto-deny',
        'denied:write_file', 'permission-error:write_to_file', 'permission-error:run_command',
        'approval-unavailable-headless:bash', 'approval-unavailable-headless:write',
    ]) assert.equal(verdict(result([signal])).verdict, 'pass', signal)
})

test('generic result failures, auth, unrelated tools and unknown streams cannot prove readonly', () => {
    for (const signal of [
        'result-status:ERROR', 'provider-auth-error', 'permission-error:read_file',
        'denied:unknown-action', 'denied:unsandboxed', 'approval-unavailable-headless:unknown',
        'approval-unavailable-headless:task', 'untrusted-directory', 'unrecognized-error',
    ]) assert.equal(verdict(result([signal])).verdict, 'indeterminate', signal)
    assert.equal(verdict(result()).verdict, 'indeterminate')
    assert.equal(verdict(null).verdict, 'indeterminate')
})

test('actual AGY eligibility failure produces a fixed category without its login URL', () => {
    const r = result(['result-status:ERROR'], [
        'error: Eligibility check failed: Your current account is not eligible for Antigravity. Verify your account to continue. https://accounts.google.com/example?secret=fixture',
    ])
    r.exit_code = 1
    assert.equal(probeBlocker(r), 'provider-eligibility-error')
    assert.deepEqual(verdict(r), { verdict: 'indeterminate', reason: 'provider-eligibility-error' })
    assert.equal(JSON.stringify(verdict(r)).includes('accounts.google.com'), false)
})

test('explicit auth and quota blockers are recognized, not arbitrary provider or permission errors', () => {
    for (const note of ['HTTP 401', 'http_status=401', '401 Unauthorized', 'invalid_api_key', 'API key is invalid', 'Authentication failed']) {
        assert.equal(probeBlocker(result([], [note])), 'provider-authentication-error', note)
    }
    for (const note of ['HTTP 429', 'insufficient_quota', 'quota exhausted', 'RESOURCE_EXHAUSTED', 'rate_limit_exceeded']) {
        assert.equal(probeBlocker(result([], [note])), 'provider-quota-error', note)
    }
    for (const note of ['HTTP 503', 'HTTP 403', 'permission denied', 'unexpected provider error', 'result status is ERROR']) {
        assert.equal(probeBlocker(result([], [note])), null, note)
    }
    assert.equal(probeBlocker(null), null)
})

test('provider failures override permission signals from the same run', () => {
    const r = result(['sandbox-write-blocked', 'provider-auth-error'])
    assert.deepEqual(verdict(r), { verdict: 'indeterminate', reason: 'provider-authentication-error' })
})

test('timeouts, cancellation, signal interruption and nonterminal states never pass', () => {
    const r = result(['sandbox-write-blocked'])
    for (const extra of [{ timedOut: true }, { state: 'cancelled' }, { state: 'running' }, { state: 'attention' }, { state: null }]) {
        assert.equal(verdict(r, extra).verdict, 'indeterminate')
    }
    assert.equal(verdict({ ...r, exit_code: null }).verdict, 'indeterminate')
    assert.equal(verdict({ ...r, state: 'cancelled' }).verdict, 'indeterminate')
    for (const note of ['run timeout after 30s', 'process terminated by signal SIGTERM', 'wait timed out', 'print-timeout-partial-output']) {
        assert.equal(verdict(result(['sandbox-write-blocked'], [note])).verdict, 'indeterminate', note)
    }
})

test('degraded or incomplete streams cannot validate a previously emitted refusal', () => {
    const r = result(['sandbox-write-blocked'])
    r.evidence.parser.degraded = true
    assert.equal(verdict(r).verdict, 'indeterminate')
    for (const note of ['no result event; final text fell back to accumulated agent_response deltas', 'stdout ended mid-line; stream may be incomplete']) {
        assert.equal(verdict(result(['sandbox-write-blocked'], [note])).verdict, 'indeterminate')
    }
})

test('creating the readonly sentinel is a failure even with refusal or error evidence', () => {
    for (const r of [result(['sandbox-write-blocked']), result(['provider-auth-error']), null]) {
        assert.deepEqual(verdict(r, { fileCreated: true }), { verdict: 'fail', reason: 'write-succeeded-in-readonly' })
    }
})


test('known configuration blockers preserve structured codes and stop later probes', () => {
    for (const code of ['SELECTION_RECONFIRM_REQUIRED', 'MODEL_UNSUPPORTED', 'MODEL_UNAVAILABLE', 'EFFORT_UNSUPPORTED', 'EFFORT_INVALID', 'MODELS_QUERY_FAILED']) {
        assert.deepEqual(probeError(new PaidanError(code, 'details must not be echoed')), {
            blocker: code, detail: code, error_code: code,
        })
    }
    assert.deepEqual(probeError(new PaidanError('OTHER_ERROR', 'ordinary failure')), {
        blocker: null, detail: 'ordinary failure', error_code: 'OTHER_ERROR',
    })
    assert.equal(probeError(new Error('SELECTION_RECONFIRM_REQUIRED')).blocker, null, 'do not infer a configuration blocker from arbitrary prose')
})

test('probe exceptions redact login URLs and classify eligibility without echoing raw text', () => {
    assert.deepEqual(probeError(new Error('Eligibility check failed https://accounts.google.com/example?secret=fixture')), {
        blocker: 'provider-eligibility-error', detail: 'provider-eligibility-error',
    })
    assert.equal(probeError(new Error('See https://accounts.google.com/example?secret=fixture')).detail, 'See [URL omitted]')
})
