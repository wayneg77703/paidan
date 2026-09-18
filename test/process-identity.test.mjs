// Process identity token comparison and live OS self-query.
// Reconciliation coverage lives in reconcile.test.mjs.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { queryProcessStart, verifyProcessIdentity } from '../dist/engine/process-identity.js'

test('verifyProcessIdentity: match / mismatch / unknown paths', async () => {
    const q = (token) => async () => token
    assert.equal(await verifyProcessIdentity(1234, 'A', q('A')), 'match')
    assert.equal(await verifyProcessIdentity(1234, 'A', q('B')), 'mismatch')
    assert.equal(await verifyProcessIdentity(1234, 'A', q(null)), 'unknown')
    assert.equal(await verifyProcessIdentity(1234, null, q('A')), 'unknown')
    assert.equal(await verifyProcessIdentity(1234, undefined, q('A')), 'unknown')
})

test('queryProcessStart returns a start token for this process on every supported platform', async () => {
    const token = await queryProcessStart(process.pid)
    assert.ok(typeof token === 'string' && token.length > 0, `start token for self: ${JSON.stringify(token)}`)
    assert.equal(await queryProcessStart(-1), null)
})
