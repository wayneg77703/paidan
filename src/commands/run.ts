// Delegation commands: submit, retrieve, cancel and list durable runs.
import * as fs from 'node:fs/promises'
import * as nodePath from 'node:path'
import { parseArgs } from 'node:util'
import { effectiveRunTimeoutSec } from '../engine/config.js'
import { PaidanError } from '../engine/errors.js'
import { writeJsonAtomic } from '../engine/run-store.js'
import { isTerminal, transitionRecord } from '../engine/state-machine.js'
import { waitForTerminal, resultOrNull, launchWorkerFor, terminateRecordedEndpoint, writeCancelledDirect } from '../engine/run-control.js'
import { PERMISSION_PRESETS, type ModeSelection, type RunRequest, type RunState } from '../engine/types.js'
import { checkPermission, DEFAULT_PROMPT_MAX_BYTES, measureArgvBytes, parseCapabilitySet, withPromptCwdHint, buildArgs, resolvePermissionMode } from '../endpoints/invocation.js'
import { ManifestError } from '../endpoints/registry.js'
import { checkNativePreflight } from '../endpoints/native-preflight.js'
import { cmdShimRefusalMessage, planEndpointSpawn } from '../endpoints/spawn.js'
import { resolveSelection } from '../endpoints/selection.js'
import { emitOk, pickEndpoint, type Ctx } from './context.js'

// ---------- verbs ----------

export async function verbRun(ctx: Ctx, args: string[]): Promise<void> {
    const { values } = parseArgs({
        args,
        strict: true,
        options: {
            endpoint: { type: 'string' },
            cwd: { type: 'string' },
            task: { type: 'string' },
            'task-file': { type: 'string' },
            mode: { type: 'string' },
            capabilities: { type: 'string' },
            model: { type: 'string' },
            effort: { type: 'string' },
            native: { type: 'boolean' },
            'selection-context': { type: 'string' },
            resume: { type: 'string' },
            'run-timeout': { type: 'string' },
            'add-dir': { type: 'string', multiple: true },
            deliverable: { type: 'string', multiple: true },
        },
    })
    const manifest = pickEndpoint(ctx, values.endpoint)
    const taskFile = values['task-file'] ?? null
    let taskText = values.task ?? null
    if (taskText === null && taskFile) {
        taskText = await fs.readFile(taskFile, 'utf8')
    }
    if (taskText === null || taskText.trim() === '') {
        throw new PaidanError('TASK_REQUIRED', 'run requires --task <text> or --task-file <path>')
    }
    if (values.mode !== undefined && values.capabilities !== undefined) {
        throw new PaidanError('ARGS_INVALID', '--mode and --capabilities are mutually exclusive')
    }
    let mode: ModeSelection
    if (values.capabilities !== undefined) {
        let parsed: unknown
        try {
            parsed = JSON.parse(values.capabilities)
        } catch {
            throw new PaidanError('ARGS_INVALID', '--capabilities must be a JSON object like {"fs.write":true,"shell.exec":true}')
        }
        const set = parseCapabilitySet(parsed)
        if (!set) {
            throw new PaidanError(
                'ARGS_INVALID',
                '--capabilities must map capability names to true/false/options objects, with at least one required capability',
            )
        }
        mode = set
    } else {
        const preset = resolvePermissionMode(manifest, ctx.config.defaults.modes[manifest.name], values.mode)
        if (!(PERMISSION_PRESETS as readonly string[]).includes(preset)) {
            throw new PaidanError('MODE_INVALID', `mode must be one of ${PERMISSION_PRESETS.join(' | ')}`)
        }
        mode = preset
    }
    const perm = checkPermission(manifest, mode)
    if (!perm.ok) {
        throw new PaidanError(
            'PERMISSION_UNSUPPORTED',
            `endpoint "${manifest.name}" cannot enforce mode ${typeof mode === 'string' ? `"${mode}"` : JSON.stringify(mode)};` +
            ` unsupported: ${perm.missing.join(', ')}`,
        )
    }
    // native settings preflight (read-only, soft): missing allow rules warn, never refuse
    if (manifest.native_preflight) {
        const pre = await checkNativePreflight(manifest.native_preflight)
        if (pre.status === 'missing') {
            perm.warnings.push(
                `native preflight: ${pre.file} lacks allow rules: ${pre.missing.join(', ')};` +
                ' the endpoint may auto-deny natively (fix its native settings — paidan never writes them)',
            )
        } else if (pre.status === 'unreadable') {
            perm.warnings.push(`native preflight: ${pre.detail}; native allow rules unverified`)
        }
    }
    const cwd = nodePath.resolve(values.cwd ?? process.cwd())
    const addDirs = (values['add-dir'] ?? []).map((d) => nodePath.resolve(d))
    const selection = await resolveSelection(ctx.config, manifest, { ...values, cwd })
    const { model, effort, provider_config: providerConfig, selection_context: selectionContext } = selection
    let runTimeoutFlag: number | null = null
    if (values['run-timeout'] !== undefined) {
        runTimeoutFlag = Number(values['run-timeout'])
        if (!Number.isFinite(runTimeoutFlag) || runTimeoutFlag < 0) {
            throw new PaidanError('ARGS_INVALID', '--run-timeout must be a non-negative number of seconds (0 disables)')
        }
    }
    const runTimeoutSec = effectiveRunTimeoutSec(runTimeoutFlag, ctx.config)
    // argv-delivery guard: the prompt rides the command line, which Windows caps
    // at 32767 chars — measure the final argv and refuse at submit time.
    // --task-file does NOT help here: it only changes how paidan reads the task.
    if (manifest.command.prompt_delivery === 'argv') {
        // cmd.exe shim + argv prompt delivery is refused outright: npm .cmd
        // shims pass a bare %*, which re-splits the caret-escaped command line
        // on spaces, so task text can smuggle real flags past tokenization.
        const configBin = ctx.config.endpoints.overrides[manifest.name]?.bin ?? null
        const spawnRes = await planEndpointSpawn(manifest, { configBin })
        if (spawnRes.plan?.resolved_from === 'cmd-shim') {
            throw new PaidanError('SPAWN_UNSUPPORTED', cmdShimRefusalMessage(manifest.name, spawnRes.plan.endpoint_bin ?? manifest.detect.bin))
        }
        const hint = withPromptCwdHint(manifest, taskText, cwd)
        const draft: RunRequest = {
            schema_version: '1.0.0',
            run_id: 'run_00000000_00000000',
            fingerprint: '',
            endpoint: manifest.name,
            cwd,
            add_dirs: addDirs,
            task_file: taskFile,
            task_text: hint.text,
            mode,
            model,
            effort,
            resume_session: values.resume ?? null,
            run_timeout_sec: runTimeoutSec,
            deliverables: [],
            created_at: '',
            warnings: [],
        }
        let argv: string[]
        try {
            argv = buildArgs(manifest, draft)
        } catch (err) {
            if (err instanceof ManifestError) throw new PaidanError('MANIFEST_INVALID', err.message)
            throw err
        }
        const bytes = measureArgvBytes([manifest.detect.bin, ...argv])
        const limit = manifest.command.prompt_max_bytes ?? DEFAULT_PROMPT_MAX_BYTES
        if (bytes > limit) {
            throw new PaidanError(
                'TASK_TOO_LONG',
                `endpoint "${manifest.name}" delivers the prompt via argv; the final argv would be ${bytes} bytes,` +
                ` over the ${limit}-byte guard (Windows caps the command line at 32767 chars;` +
                ' manifest command.prompt_max_bytes overrides).' +
                ' Shorten the task or pick an endpoint with stdin/file prompt delivery.' +
                ' (--task-file only changes how paidan reads the task, not how it is delivered to the endpoint.)',
            )
        }
    }
    const requestWarnings = [...perm.warnings]
    if (values.resume && manifest.command.resume_argv) {
        // resume_argv endpoints (codex) restore the session's original tier and
        // take no mode flags: the recorded mode is the request's, not the
        // effective one — say so instead of implying a re-tier (codex P1-07)
        requestWarnings.push(
            `resume on ${manifest.name} restores the endpoint session's original permission tier; the recorded mode (${typeof mode === 'string' ? mode : 'explicit capability set'}) is this request's, not necessarily the effective one`,
        )
    }
    const created = await ctx.store.create({
        endpoint: manifest.name,
        cwd,
        add_dirs: addDirs,
        task_file: taskFile,
        task_text: taskText,
        mode,
        ...selection,
        resume_session: values.resume ?? null,
        run_timeout_sec: runTimeoutSec,
        deliverables: (values.deliverable ?? []).map((p) => ({ path: p, expected: null })),
        warnings: requestWarnings,
    })
    if (!created.created) {
        // fingerprint dedup covers endpoint+cwd+task+mode only: a re-submit that
        // changes anything else returns the original run — name every mismatch
        const mismatch: string[] = []
        if ((created.request.model ?? null) !== model) mismatch.push(`model (run has ${JSON.stringify(created.request.model ?? null)})`)
        if ((created.request.effort ?? null) !== effort) mismatch.push(`effort (run has ${JSON.stringify(created.request.effort ?? null)})`)
        if (created.request.selection_context !== selectionContext) mismatch.push('native configuration context')
        if (created.request.provider_config !== providerConfig) mismatch.push('ZCode provider config (the existing run keeps its original selection)')
        if ((created.request.resume_session ?? null) !== (values.resume ?? null)) mismatch.push(`resume session (run has ${JSON.stringify(created.request.resume_session ?? null)})`)
        if (created.request.add_dirs.join('|') !== addDirs.join('|')) mismatch.push(`add_dirs (run has ${JSON.stringify(created.request.add_dirs)})`)
        if (created.request.run_timeout_sec !== runTimeoutSec) mismatch.push(`run_timeout_sec (run has ${created.request.run_timeout_sec})`)
        const deliverablePaths = (values.deliverable ?? []).map((p) => ({ path: p, expected: null }))
        if (JSON.stringify(created.request.deliverables) !== JSON.stringify(deliverablePaths)) mismatch.push('deliverables')
        if (mismatch.length > 0) {
            created.request.warnings.push(
                `dedup matched an existing run with different ${mismatch.join(', ')};` +
                ' the original values apply — cancel it first if these changes matter (fingerprint = endpoint+cwd+task+mode)',
            )
        }
        emitOk({
            run_id: created.request.run_id,
            endpoint: manifest.name,
            state: created.state.state,
            created: false,
            note: 'identical request fingerprint matched a non-terminal run',
            warnings: created.request.warnings,
        })
        return
    }
    const runId = created.request.run_id
    try {
        await launchWorkerFor(ctx, runId)
    } catch (err) {
        throw new PaidanError(
            'WORKER_SPAWN_FAILED',
            `${err instanceof Error ? err.message : String(err)} (run ${runId} stays pending; reconcile will mark attention)`,
        )
    }
    emitOk({
        run_id: runId,
        endpoint: manifest.name,
        state: 'running',
        created: true,
        warnings: created.request.warnings,
    })
}

export async function verbGet(ctx: Ctx, args: string[]): Promise<void> {
    const { values, positionals } = parseArgs({
        args,
        strict: true,
        allowPositionals: true,
        options: {
            wait: { type: 'boolean', default: false },
            timeout: { type: 'string' },
        },
    })
    const runId = positionals[0]
    if (!runId) throw new PaidanError('ARGS_INVALID', 'get requires a run_id')
    const timeoutSec = values.timeout ? Number(values.timeout) : 0
    if (!Number.isFinite(timeoutSec) || timeoutSec < 0) {
        throw new PaidanError('ARGS_INVALID', '--timeout must be a non-negative number of seconds')
    }
    const state = values.wait
        ? await waitForTerminal(ctx.store, runId, timeoutSec)
        : await ctx.store.readState(runId)
    if (!state) throw new PaidanError('RUN_NOT_FOUND', `no such run: ${runId}`)
    const result = await resultOrNull(ctx.store, runId)
    const needsDiagnosis = ['failed', 'unknown', 'attention'].includes(state.state) || result?.evidence.selection?.matches_expected === false
    const request = needsDiagnosis ? await ctx.store.readRequest(runId).catch(() => null) : null
    emitOk({ run: state, result, terminal: isTerminal(state.state),
        ...(needsDiagnosis && request ? { recovery: {
            endpoint: request.endpoint, cwd: request.cwd,
            requested: { model: request.model, effort: request.effort },
            native_at_submission: request.native_selection ?? null,
            selection_context_at_submission: request.selection_context ?? null,
            next_steps: [`paidan doctor --endpoint ${request.endpoint}`, `paidan models --endpoint ${request.endpoint} --cwd ${JSON.stringify(request.cwd)}`],
            guidance: '先分析错误、拒绝证据和已有产物；仅在认证/额度/模型/连接问题时重查该端点当前通路，与提交时配置比较。候选不证明可调用；涉及换连接、模型、强度、端点、权限或重试方案的选择交给用户。不自动重派或改配置。',
        } } : {}),
    })
}

export async function verbCancel(ctx: Ctx, args: string[]): Promise<void> {
    const { positionals } = parseArgs({ args, strict: true, allowPositionals: true, options: {} })
    const runId = positionals[0]
    if (!runId) throw new PaidanError('ARGS_INVALID', 'cancel requires a run_id')
    const state = await ctx.store.readState(runId)
    if (!state) throw new PaidanError('RUN_NOT_FOUND', `no such run: ${runId}`)
    if (isTerminal(state.state)) {
        emitOk({ run_id: runId, state: state.state, note: 'already terminal' })
        return
    }

    const now = () => new Date().toISOString()
    if (state.state === 'attention') {
        // worker is gone; kill a possibly orphaned endpoint process, then close out.
        // An unconfirmed kill is NOT a cancellation: the endpoint may still run.
        const endpointPid = state.worker?.endpoint_pid ?? null
        const term = endpointPid
            ? await terminateRecordedEndpoint(endpointPid, state.worker?.endpoint_pid_start)
            : { killed: true, note: null } // no recorded pid = no endpoint process to kill
        if (term.killed) {
            const settledState = await writeCancelledDirect(ctx.store, state, 'cancelled while attention (worker absent)')
            emitOk({ run_id: runId, state: settledState, ...(settledState === 'attention' ? { needs_attention: true, note: 'result.json could not be settled; run left in attention' } : term.note ? { note: term.note } : {}) })
        } else {
            // already attention — an attention->attention "transition" is not a
            // state machine edge; keep the record as-is instead of throwing
            emitOk({
                run_id: runId,
                state: 'attention',
                needs_attention: true,
                note: `cancel could not be confirmed: ${term.note ?? 'endpoint process state unknown'}; run left in attention`,
            })
        }
        return
    }

    // pending/running: the worker owns the kill so the evidence trail is consistent
    await writeJsonAtomic(ctx.store.cancelMarkerPath(runId), { requested_at: now() })
    const final = await waitForTerminal(ctx.store, runId, 15)
    if (final && isTerminal(final.state)) {
        emitOk({ run_id: runId, state: final.state })
        return
    }
    // worker wedged: direct fallback kill + close out (only on a confirmed kill)
    const endpointPid = final?.worker?.endpoint_pid ?? null
    const term = endpointPid
        ? await terminateRecordedEndpoint(endpointPid, final?.worker?.endpoint_pid_start)
        : { killed: true, note: null } // no recorded pid = no endpoint process to kill
    const latest = await ctx.store.readState(runId)
    if (latest && !isTerminal(latest.state)) {
        if (term.killed) {
            const settledState = await writeCancelledDirect(ctx.store, latest, 'cancel finalized by CLI after worker did not respond within 15s')
            const after = await ctx.store.readState(runId)
            emitOk({
                run_id: runId,
                state: settledState === 'attention' ? (after?.state ?? 'attention') : settledState,
                needs_attention: settledState === 'attention' || undefined,
                note: ['worker did not finalize within 15s; CLI closed the run', term.note].filter(Boolean).join('; '),
            })
            return
        }
        // kill not confirmed and the run is not attention yet: flag it (an
        // attention->attention repeat later is a no-op, never a throw)
        if (latest.state !== 'attention') {
            await ctx.store.writeState(transitionRecord(latest, 'attention', now())).catch(() => {})
        }
    }
    const after = await ctx.store.readState(runId)
    emitOk({
        run_id: runId,
        state: after?.state ?? 'attention',
        needs_attention: after?.state === 'attention' || undefined,
        note: [
            'worker did not finalize within 15s and the fallback kill was not confirmed; run left in attention',
            term.note,
        ].filter(Boolean).join('; '),
    })
}

export async function verbList(ctx: Ctx, args: string[]): Promise<void> {
    const { values } = parseArgs({
        args,
        strict: true,
        options: {
            state: { type: 'string' },
            limit: { type: 'string' },
        },
    })
    const limit = values.limit ? Number(values.limit) : 50
    if (!Number.isInteger(limit) || limit <= 0) throw new PaidanError('ARGS_INVALID', '--limit must be a positive integer')
    const states = values.state ? (values.state.split(',') as RunState[]) : undefined
    const runs = await ctx.store.list({ states, limit })
    const summaries = await Promise.all(
        runs.map(async (s) => {
            const req = await ctx.store.readRequest(s.run_id).catch(() => null)
            return {
                run_id: s.run_id,
                state: s.state,
                endpoint: req?.endpoint ?? null,
                cwd: req?.cwd ?? null,
                mode: req?.mode ?? null,
                created_at: s.created_at,
                terminal_at: s.terminal_at,
                session_handle: s.session.handle,
            }
        }),
    )
    emitOk({ runs: summaries, count: summaries.length, ttl_days: ctx.store.ttlDays })
}
