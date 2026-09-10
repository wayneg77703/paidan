// Detached worker launch + explicit process-tree termination.
// Submit spawns `node dist/worker.js <run_id>` detached; the CLI never babysits.
// Cancel kills in two phases (graceful taskkill /T or SIGTERM, forced /F or
// SIGKILL after grace): Node stdlib cannot create Job Objects (no FFI) and
// zero-dependency is invariant 6 — orphaned grandchildren after a force-kill
// are an accepted limitation (contracts §5).

import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { pidAlive } from './reconcile.js'

const execFileAsync = promisify(execFile)

/** dist/engine/supervisor.js -> dist/worker.js */
export function resolveWorkerPath(): string {
    const p = fileURLToPath(new URL('../worker.js', import.meta.url))
    if (!existsSync(p)) throw new Error(`cannot locate worker.js at ${p} (run npm run build first)`)
    return p
}

export interface LaunchWorkerOptions {
    dataDir: string
    /** polled on state.json until the worker's pid appears (or the run goes terminal) */
    timeoutMs?: number
    readWorkerPid: () => Promise<{ workerPid: number | null; terminal: boolean } | null>
}

export async function launchWorker(runId: string, opts: LaunchWorkerOptions): Promise<number> {
    const workerPath = resolveWorkerPath()
    const child = spawn(process.execPath, [workerPath, runId], {
        detached: true,
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'ignore'],
        env: { ...process.env, PAIDAN_DATA_DIR: opts.dataDir },
    })
    child.unref()

    const deadline = Date.now() + (opts.timeoutMs ?? 10_000)
    while (Date.now() < deadline) {
        const probe = await opts.readWorkerPid().catch(() => null)
        if (probe?.workerPid) return probe.workerPid
        if (probe?.terminal) {
            throw new Error(`worker ran to a terminal state before becoming observable for ${runId}`)
        }
        if (child.exitCode !== null) {
            throw new Error(`worker exited immediately with code ${child.exitCode} for ${runId}`)
        }
        await sleep(150)
    }
    throw new Error(`worker did not become observable within ${opts.timeoutMs ?? 10_000}ms for ${runId}`)
}

export interface TerminateTreeResult {
    ok: boolean
    forced: boolean
    method: 'taskkill' | 'taskkill_force' | 'signal_group' | 'signal_group_force' | 'already_exited'
    error?: string
}

/**
 * Kill the whole tree rooted at pid. Two phases everywhere: graceful first,
 * forced after the grace window, with a liveness wait after each.
 */
export async function terminateEndpointTree(pid: number, graceMs = 5_000): Promise<TerminateTreeResult> {
    if (!Number.isSafeInteger(pid) || pid <= 0) {
        return { ok: false, forced: false, method: 'already_exited', error: `invalid pid ${pid}` }
    }
    if (!pidAlive(pid)) {
        return { ok: true, forced: false, method: 'already_exited' }
    }
    return process.platform === 'win32' ? taskkillTree(pid, graceMs) : signalGroup(pid, graceMs)
}

async function taskkillTree(pid: number, graceMs: number): Promise<TerminateTreeResult> {
    const run = (force: boolean) =>
        execFileAsync('taskkill.exe', ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])], {
            windowsHide: true,
            timeout: 15_000,
        }).then(
            () => true,
            // exit code 128 = no such process: fine, it is already gone
            (err: { code?: number }) => err.code === 128,
        )

    await run(false)
    if (await waitUntilDead(pid, graceMs)) {
        return { ok: true, forced: false, method: 'taskkill' }
    }
    await run(true)
    if (await waitUntilDead(pid, Math.min(graceMs, 5_000))) {
        return { ok: true, forced: true, method: 'taskkill_force' }
    }
    return {
        ok: false,
        forced: true,
        method: 'taskkill_force',
        error: `process ${pid} survived taskkill /T /F`,
    }
}

async function signalGroup(pid: number, graceMs: number): Promise<TerminateTreeResult> {
    // The endpoint is spawned detached on POSIX, so it leads its own process group.
    const killGroup = (signal: NodeJS.Signals) => {
        try {
            process.kill(-pid, signal)
        } catch {
            // group already gone
        }
    }
    killGroup('SIGTERM')
    if (await waitUntilDead(pid, graceMs)) {
        return { ok: true, forced: false, method: 'signal_group' }
    }
    killGroup('SIGKILL')
    if (await waitUntilDead(pid, Math.min(graceMs, 5_000))) {
        return { ok: true, forced: true, method: 'signal_group_force' }
    }
    return {
        ok: false,
        forced: true,
        method: 'signal_group_force',
        error: `process group ${pid} survived SIGKILL`,
    }
}

async function waitUntilDead(pid: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    do {
        if (!pidAlive(pid)) return true
        await sleep(Math.min(200, Math.max(20, deadline - Date.now())))
    } while (Date.now() < deadline)
    return !pidAlive(pid)
}

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms))
}
