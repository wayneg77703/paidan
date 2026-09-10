// Secret-shape redaction (engine/redactor.ts): provider token shapes, JWTs and
// URL userinfo on top of the existing Bearer/sk-/GitHub/assignment rules, with
// no collateral damage to ordinary prose; plus env-value and home-path
// replacement (both host-provided, nothing machine-real).

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRedactor } from '../dist/engine/redactor.js'

const redactor = (env = {}, homeDir = 'C:\\Users\\tester') => createRedactor(env, homeDir)

test('provider token shapes are redacted (AWS, Google, Slack, GitLab)', () => {
    const r = redactor()
    assert.equal(r.redactText('aws AKIAIOSFODNN7EXAMPLE end'), 'aws [REDACTED] end')
    assert.equal(r.redactText(`gcp AIza${'x'.repeat(35)} end`), 'gcp [REDACTED] end')
    assert.equal(r.redactText('slack xoxb-1234567890-abcdefghij end'), 'slack [REDACTED] end')
    assert.equal(r.redactText('slack xoxp-aaaaaaaa-bbbb-cccc-dddd end'), 'slack [REDACTED] end')
    assert.equal(r.redactText(`gl glpat-${'A1_-'.repeat(6)} end`), 'gl [REDACTED] end')
})

test('GitHub token prefixes old and new are redacted', () => {
    const r = redactor()
    for (const prefix of ['ghp', 'gho', 'ghu', 'ghs', 'ghr', 'github_pat']) {
        const text = `tok ${prefix}_${'Ab1'.repeat(8)} end`
        assert.equal(r.redactText(text), 'tok [REDACTED] end', prefix)
    }
})

test('Bearer and sk- shapes keep their existing redaction behavior', () => {
    const r = redactor()
    assert.equal(r.redactText('Authorization: Bearer abc.def-123~+/= x'), 'Authorization: Bearer [REDACTED] x')
    assert.equal(r.redactText(`key sk-${'a1_'.repeat(6)}-Z9 x`), 'key sk-[REDACTED] x')
})

test('JWTs (three base64url segments) are redacted', () => {
    const r = redactor()
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c'
    assert.equal(r.redactText(`token ${jwt} end`), 'token [REDACTED] end')
})

test('URL userinfo keeps scheme and host but erases the user:pass segment', () => {
    const r = redactor()
    assert.equal(
        r.redactText('open https://user:passw0rd@example.com/path?q=1 now'),
        'open https://[REDACTED]@example.com/path?q=1 now',
    )
    assert.equal(
        r.redactText('dsn postgres://dbuser:s3cret@db.internal:5432/app;'),
        'dsn postgres://[REDACTED]@db.internal:5432/app;',
    )
})

test('ordinary prose, short assignments and plain URLs are not mangled', () => {
    const r = redactor()
    const prose = [
        'monkey business as usual',
        'key=ab',
        'TOKEN=abc',
        'see https://example.com/path?q=1 for details',
        'server at http://localhost:8080/health is up',
        'git remote git@github.com:org/repo.git',
        'A simple AKIA shout without the suffix',
    ]
    for (const line of prose) {
        assert.equal(r.redactText(line), line, line)
    }
})

test('env values of KEY/TOKEN/SECRET/PASSWORD-named variables are redacted wherever they appear', () => {
    const r = redactor({ MY_API_KEY: 'hunter2-secret-value', PLAIN: 'visible' })
    assert.equal(r.redactText('the token is hunter2-secret-value ok'), 'the token is [REDACTED] ok')
    assert.equal(r.redactText('the word visible stays'), 'the word visible stays')
})

test('the home directory is replaced with ~ (both slash directions)', () => {
    const r = redactor()
    assert.equal(r.redactText('file at C:\\Users\\tester\\docs\\x.txt'), 'file at ~\\docs\\x.txt')
    assert.equal(r.redactText('file at C:/Users/tester/docs/x.txt'), 'file at ~/docs/x.txt')
})
