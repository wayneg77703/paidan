// Process identity token comparison and live OS self-query.
// Reconciliation coverage lives in reconcile.test.mjs.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { queryProcessStart, queryProcessStarts, verifyProcessIdentity } from '../dist/engine/process-identity.js'

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


test('batch process query handles distinct live PIDs, duplicates and a reaped PID', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
    const childExit = new Promise(resolve => child.once('exit', resolve))
    try {
        const tokens = await queryProcessStarts([process.pid, child.pid, process.pid, -1, 0, 1.5])
        assert.equal(tokens.size, 2)
        for (const pid of [process.pid, child.pid]) {
            assert.ok(tokens.get(pid))
            assert.equal(tokens.get(pid), await queryProcessStart(pid))
        }
        child.kill()
        await childExit
        const missing = await queryProcessStarts([child.pid])
        assert.equal(missing.get(child.pid), null)
    } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill()
        await childExit
    }
    assert.deepEqual(await queryProcessStarts([]), new Map())
    assert.deepEqual(await queryProcessStarts([-1, NaN, 0, 1.1]), new Map())
})

test('Windows batch tokens remain compatible with already recorded legacy CIM display', {
    skip: process.platform !== 'win32',
}, async () => {
    const { stdout } = await promisify(execFile)('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${process.pid}").CreationDate`,
    ], { timeout: 10_000, windowsHide: true })
    assert.ok(stdout.trim())
    const tokens = await queryProcessStarts([process.pid])
    assert.equal(tokens.get(process.pid), stdout.trim())
})
