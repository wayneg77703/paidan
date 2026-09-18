// Explicit live contract checks. Reuses run lifecycle and selection; no dependency on run commands.
import * as fs from 'node:fs/promises'
import * as nodePath from 'node:path'
import * as os from 'node:os'
import { parseArgs } from 'node:util'
import { PaidanError } from '../engine/errors.js'
import { effectiveRunTimeoutSec } from '../engine/config.js'
import { writeJsonAtomic } from '../engine/run-store.js'
import { isTerminal, transitionRecord } from '../engine/state-machine.js'
import { waitForTerminal, resultOrNull, launchWorkerFor, terminateRecordedEndpoint, writeCancelledDirect } from '../engine/run-control.js'
import type { PermissionPreset, RunResult, RunStateRecord } from '../engine/types.js'
import { pickProbePreset, checkPermission } from '../endpoints/invocation.js'
import { refreshManifestVerifiedAt } from '../endpoints/registry.js'
import { planEndpointSpawn } from '../endpoints/spawn.js'
import { detectVersion } from '../endpoints/inspection.js'
import { resolveSelection } from '../endpoints/selection.js'
import { emitOk, pickEndpoint, type Ctx } from './context.js'

export async function verbProbe(ctx: Ctx, args: string[]): Promise<void> {
    const { values } = parseArgs({
        args,
        strict: true,
        options: {
            endpoint: { type: 'string' },
            timeout: { type: 'string' },
        },
    })
    const manifest = pickEndpoint(ctx, values.endpoint)
    const timeoutSec = values.timeout ? Number(values.timeout) : 300
    if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) {
        throw new PaidanError('ARGS_INVALID', '--timeout must be a positive number of seconds')
    }
    const configBin = ctx.config.endpoints.overrides[manifest.name]?.bin ?? null
    const spawnRes = await planEndpointSpawn(manifest, { configBin })
    const probes: Array<{ name: string; verdict: 'pass' | 'fail' | 'skip' | 'indeterminate'; detail: string; run_ids?: string[] }> = []
    if (!spawnRes.plan) {
        emitOk({
            endpoint: manifest.name,
            probes: ['P1-write', 'P2-readonly-refusal', 'P3-resume'].map((name) => ({
                name, verdict: 'skip' as const, detail: spawnRes.notes.join('; ') || `bin "${manifest.detect.bin}" not resolvable`,
            })),
        })
        return
    }
    const plan = spawnRes.plan
    const version = await detectVersion(manifest, plan)
    // P1/P3 share one tier: the most conservative supported preset (never a
    // hardcoded one — e.g. zcode enforces only unattended headless)
    const probePreset = pickProbePreset(manifest)
    /** cancel a probe run that outlived its wait: marker -> 15s -> fallback kill -> close out. An unconfirmed kill does NOT close the run (same rule as verbCancel — codex F2). */
    const cancelProbeRun = async (runId: string): Promise<RunStateRecord | null> => {
        const st = await ctx.store.readState(runId)
        if (!st || isTerminal(st.state)) return st
        await writeJsonAtomic(ctx.store.cancelMarkerPath(runId), { requested_at: new Date().toISOString() })
        let s = await waitForTerminal(ctx.store, runId, 15)
        if (!s || !isTerminal(s.state)) {
            const pid = s?.worker?.endpoint_pid ?? null
            const term = pid
                ? await terminateRecordedEndpoint(pid, s?.worker?.endpoint_pid_start)
                : { killed: true, note: null } // no recorded pid = no endpoint process to kill
            if (term.killed) {
                const latest = await ctx.store.readState(runId)
                if (latest && !isTerminal(latest.state)) {
                    await writeCancelledDirect(ctx.store, latest, 'probe wait timed out; cancelled by probe')
                }
            } else if (s && s.state !== 'attention') {
                // unconfirmed kill: leave it flagged, cwd cleanup will see non-terminal
                await ctx.store.writeState(transitionRecord(s, 'attention', new Date().toISOString())).catch(() => {})
            }
            s = await ctx.store.readState(runId)
        }
        return s
    }
    const runProbeTask = async (
        task: string,
        opts: { cwd: string; deliverables?: Array<{ path: string; expected: string | null }>; resume?: string; mode?: PermissionPreset },
    ): Promise<{ runId: string; state: RunStateRecord | null; result: RunResult | null; timedOut: boolean }> => {
        const selection = await resolveSelection(ctx.config, manifest, { cwd: opts.cwd })
        const created = await ctx.store.create({
            endpoint: manifest.name,
            cwd: opts.cwd,
            add_dirs: [],
            task_file: null,
            task_text: task,
            mode: opts.mode ?? probePreset ?? 'workspace-write',
            ...selection,
            resume_session: opts.resume ?? null,
            run_timeout_sec: effectiveRunTimeoutSec(null, ctx.config),
            deliverables: opts.deliverables ?? [],
            warnings: [],
        })
        const runId = created.request.run_id
        await launchWorkerFor(ctx, runId)
        let state = await waitForTerminal(ctx.store, runId, timeoutSec)
        // a wait timeout is NOT an execution end: cancel before reporting, and
        // keep the scratch cwd when anything may still be executing (codex P1-10)
        const timedOut = !state || !isTerminal(state.state)
        if (timedOut) state = (await cancelProbeRun(runId)) ?? state
        const result = await resultOrNull(ctx.store, runId)
        return { runId, state, result, timedOut }
    }
    /** best-effort scratch cleanup that never deletes a cwd a run may still occupy */
    const cleanProbeCwd = async (cwd: string, ...runs: Array<{ runId: string; timedOut: boolean }>): Promise<boolean> => {
        for (const r of runs) {
            if (r.timedOut) {
                const st = await ctx.store.readState(r.runId).catch(() => null)
                if (!st || !isTerminal(st.state)) return false
            }
        }
        await fs.rm(cwd, { recursive: true, force: true }).catch(() => {})
        return true
    }

    // P1 write contract
    if (probePreset === null) {
        probes.push({ name: 'P1-write', verdict: 'skip', detail: 'endpoint supports no permission preset' })
    } else {
        const token = `paidan-probe-${Date.now()}`
        const p1cwd = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'paidan-probe-'))
        try {
            const r = await runProbeTask(
                `Create a file named probe-write.txt in the current directory whose entire content is exactly: ${token} Then reply "done".`,
                { cwd: p1cwd, deliverables: [{ path: 'probe-write.txt', expected: token }] },
            )
            const found = r.result?.evidence.deliverables.every((d) => d.found) ?? false
            const cleaned = await cleanProbeCwd(p1cwd, r)
            probes.push({
                name: 'P1-write',
                verdict: r.state?.state === 'completed' && found && !r.timedOut ? 'pass' : r.timedOut ? 'indeterminate' : 'fail',
                run_ids: [r.runId],
                detail: `preset=${probePreset} state=${r.state?.state ?? 'none'} deliverable_found=${found}${r.timedOut ? ' wait_timed_out (run cancelled)' : ''}${cleaned ? '' : ` scratch kept: ${p1cwd}`}`,
            })
        } catch (err) {
            probes.push({ name: 'P1-write', verdict: 'fail', detail: err instanceof Error ? err.message : String(err) })
        }
    }

    // P2 read-only refusal contract
    if ((manifest.permission.presets['read-only'] ?? 'unsupported') === 'unsupported') {
        try {
            const check = checkPermission(manifest, 'read-only')
            if (check.ok) throw new Error('read-only check unexpectedly passed')
            probes.push({ name: 'P2-readonly-refusal', verdict: 'pass', detail: `submit refused: ${check.missing.join(', ')}` })
        } catch (err) {
            probes.push({ name: 'P2-readonly-refusal', verdict: 'fail', detail: err instanceof Error ? err.message : String(err) })
        }
    } else {
        // Live P2: "no file" alone proves nothing — auth failure, a wedged run or
        // a parser miss all look the same. pass needs the task terminal AND
        // attributable refusal evidence; anything else is indeterminate (codex P1-09)
        const p2cwd = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'paidan-probe-p2-'))
        try {
            const r = await runProbeTask(
                'Create a file named probe-ro.txt in the current directory with content "x", then reply "done".',
                { cwd: p2cwd, mode: 'read-only' },
            )
            const fileCreated = await fs.stat(nodePath.join(p2cwd, 'probe-ro.txt')).then(() => true, () => false)
            const refusals = r.result?.evidence.refusals ?? []
            const terminal = r.state !== null && isTerminal(r.state.state)
            let verdict: 'pass' | 'fail' | 'indeterminate'
            if (fileCreated) verdict = 'fail'
            else if (!terminal || r.timedOut) verdict = 'indeterminate'
            else if (refusals.length > 0) verdict = 'pass'
            else verdict = 'indeterminate'
            const cleaned = await cleanProbeCwd(p2cwd, r)
            probes.push({
                name: 'P2-readonly-refusal',
                verdict,
                run_ids: [r.runId],
                detail: `file_created=${fileCreated} state=${r.state?.state ?? 'none'} refusals=${refusals.join('|') || 'none-observed'}${verdict === 'indeterminate' ? ' — no attributable refusal evidence, permission enforcement unverified' : ''}${r.timedOut ? ' wait_timed_out (run cancelled)' : ''}${cleaned ? '' : ` scratch kept: ${p2cwd}`}`,
            })
        } catch (err) {
            probes.push({ name: 'P2-readonly-refusal', verdict: 'fail', detail: err instanceof Error ? err.message : String(err) })
        }
    }

    // P3 resume contract — both runs must share a cwd: kimi's native session
    // store is scoped per working directory (sessions/wd_<hash>/...)
    if (manifest.resume?.kind !== 'flag') {
        probes.push({ name: 'P3-resume', verdict: 'skip', detail: 'endpoint has no flag-based resume' })
    } else if (probePreset === null) {
        probes.push({ name: 'P3-resume', verdict: 'skip', detail: 'endpoint supports no permission preset' })
    } else {
        const token = `codename-${Date.now()}`
        const p3cwd = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'paidan-probe-p3-'))
        try {
            const first = await runProbeTask(`Remember the codename "${token}". Reply with exactly: ok`, { cwd: p3cwd, mode: probePreset })
            const handle = first.result?.session_handle ?? first.state?.session.handle ?? null
            if (!handle) {
                const cleaned = await cleanProbeCwd(p3cwd, first)
                probes.push({ name: 'P3-resume', verdict: first.timedOut ? 'indeterminate' : 'fail', run_ids: [first.runId], detail: `first run produced no session handle (state=${first.state?.state ?? 'none'}${first.timedOut ? ', wait timed out' : ''})${cleaned ? '' : ` scratch kept: ${p3cwd}`}` })
            } else {
                const second = await runProbeTask(
                    'What is the codename I asked you to remember? Reply with just the codename.',
                    { cwd: p3cwd, resume: handle, mode: probePreset },
                )
                const recalled = second.result?.final_text.includes(token) ?? false
                const cleaned = await cleanProbeCwd(p3cwd, first, second)
                probes.push({
                    name: 'P3-resume',
                    verdict: recalled && !first.timedOut && !second.timedOut ? 'pass' : (first.timedOut || second.timedOut) ? 'indeterminate' : 'fail',
                    run_ids: [first.runId, second.runId],
                    detail: `preset=${probePreset} session=${handle} recalled=${recalled} state=${second.state?.state ?? 'none'}${first.timedOut || second.timedOut ? ' wait_timed_out (run cancelled)' : ''}${cleaned ? '' : ` scratch kept: ${p3cwd}`}`,
                })
            }
        } catch (err) {
            probes.push({ name: 'P3-resume', verdict: 'fail', detail: err instanceof Error ? err.message : String(err) })
        }
    }

    // refresh verified_at on pass (version drift policy in AGENTS.md); the
    // receipt records whether the manifest write actually happened (a global
    // npm install dir may be read-only) instead of only stderr (codex P1-08)
    const today = localToday()
    let verifiedRefresh: Record<string, unknown> = { attempted: false }
    if (probes.some((p) => p.verdict === 'pass' && ['P1-write', 'P3-resume'].includes(p.name))) {
        try {
            await refreshManifestVerifiedAt(ctx.registry.dir, manifest.name, probes, today, version)
            verifiedRefresh = { attempted: true, ok: true, dir: ctx.registry.dir }
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            process.stderr.write(`probe: manifest verified_at refresh failed: ${message}\n`)
            verifiedRefresh = { attempted: true, ok: false, error: message }
        }
    }
    emitOk({ endpoint: manifest.name, bin: plan.endpoint_bin, resolved_from: plan.resolved_from, version, probes, verified_at_refresh: verifiedRefresh })
}

/** Local calendar date for verified_at (not UTC — the field answers "when, for this user"). */
function localToday(): string {
    const d = new Date()
    const p = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
