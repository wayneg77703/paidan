import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as nodePath from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { pidAlive } from '../../dist/engine/reconcile.js'

// Terminal state can precede the worker's final events and usage.db close.
// Wait for process exit before inspecting those writes or removing its tmp dir.
export async function waitForWorkerExit(dataDir, runId) {
    const state = JSON.parse(await fs.readFile(nodePath.join(dataDir, 'runs', runId, 'state.json'), 'utf8'))
    assert.ok(['completed', 'failed', 'cancelled', 'unknown'].includes(state.state), `run is not terminal: ${state.state}`)
    const pid = state.worker?.pid
    assert.ok(Number.isSafeInteger(pid) && pid > 0, `worker pid missing for ${runId}`)
    const deadline = Date.now() + 15_000
    while (pidAlive(pid)) {
        assert.ok(Date.now() < deadline, `worker ${pid} for ${runId} did not exit within 15s`)
        await setTimeout(50)
    }
}
