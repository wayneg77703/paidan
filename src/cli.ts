#!/usr/bin/env node
// paidan CLI. stdout is always a single JSON envelope ({ok:true,...} or
// {ok:false,error:{code,message}}); human prose goes to stderr only.

import { execFile } from 'node:child_process'
import * as fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import * as readline from 'node:readline/promises'
import { promisify } from 'node:util'
import {
    defaultConfigPath,
    effectiveRunTimeoutSec,
    loadConfig,
    resolveDataDir,
    type PaidanConfig,
} from './engine/config.js'
import {
    defaultInitAnswers,
    buildInitConfig,
    initConfigToJson,
    mergeInitConfig,
    parseMultiSelect,
    planEndpointDefaultQuestions,
    type InitAnswers,
    type InitEndpointInfo,
} from './engine/init-plan.js'
import {
    detectHosts,
    installSkill,
    loadHostRegistry,
    selectSkillHosts,
    type HostInfo,
    type SkillInstallResult,
} from './engine/skill-install.js'
import { reconcileRuns, pidAlive } from './engine/reconcile.js'
import { verifyProcessIdentity } from './engine/process-identity.js'
import { ModelsCache, type CachedModels } from './engine/models-cache.js'
import { RunStore, writeJsonAtomic } from './engine/run-store.js'
import { isTerminal, transitionRecord } from './engine/state-machine.js'
import { launchWorker, terminateEndpointTree } from './engine/supervisor.js'
import { UsageDb } from './engine/usage-db.js'
import {
    PERMISSION_PRESETS,
    type ModeSelection,
    type PermissionPreset,
    type RunRequest,
    type RunResult,
    type RunState,
    type RunStateRecord,
} from './engine/types.js'
import {
    checkPermission,
    DEFAULT_PROMPT_MAX_BYTES,
    discoverAndCacheModels,
    EndpointRegistry,
    loadParserModule,
    ManifestError,
    refreshManifestVerifiedAt,
    measureArgvBytes,
    pickProbePreset,
    parseCapabilitySet,
    withPromptCwdHint,
    buildArgs,
    type EndpointManifest,
} from './endpoints/registry.js'
import type { NativeDefaults } from './endpoints/parser-api.js'
import { checkNativePreflight } from './endpoints/native-preflight.js'
import { cmdShimRefusalMessage, finalSpawnArgs, needsVerbatimArgs, planEndpointSpawn, type SpawnPlan } from './endpoints/spawn.js'
import { checkboxSelect, menuSelect, PromptAbort, rawSelectSupported } from './tty-select.js'

const execFileAsync = promisify(execFile)

class CliError extends Error {
    constructor(
        readonly code: string,
        message: string,
    ) {
        super(message)
    }
}

function emitOk(payload: Record<string, unknown>): void {
    process.stdout.write(JSON.stringify({ ok: true, ...payload }) + '\n')
}

function emitError(err: unknown): number {
    if (err instanceof CliError) {
        process.stdout.write(JSON.stringify({ ok: false, error: { code: err.code, message: err.message } }) + '\n')
    } else {
        // node:util parseArgs rejections (ERR_PARSE_ARGS_*) are user input
        // errors, not internal ones — surface them as ARGS_INVALID
        const code = (err as { code?: unknown } | null)?.code
        const mapped = typeof code === 'string' && code.startsWith('ERR_PARSE_ARGS') ? 'ARGS_INVALID' : 'INTERNAL'
        const message = err instanceof Error ? err.message : String(err)
        process.stdout.write(JSON.stringify({ ok: false, error: { code: mapped, message } }) + '\n')
    }
    return 1
}

interface Ctx {
    config: PaidanConfig
    configPath: string
    dataDir: string
    store: RunStore
    registry: EndpointRegistry
}

async function makeCtx(): Promise<Ctx> {
    const configPath = defaultConfigPath()
    let config: PaidanConfig
    try {
        config = loadConfig(configPath)
    } catch (err) {
        throw new CliError('CONFIG_INVALID', err instanceof Error ? err.message : String(err))
    }
    const dataDir = resolveDataDir(config)
    const store = new RunStore(dataDir, { ttlDays: config.ttlDays })
    const registry = await EndpointRegistry.load()
    return { config, configPath, dataDir, store, registry }
}

function pickEndpoint(ctx: Ctx, flag: string | undefined): EndpointManifest {
    const name = flag ?? ctx.config.defaults.endpoint
    if (!name) throw new CliError('ENDPOINT_REQUIRED', 'no --endpoint given and no defaults.endpoint in config.json')
    let manifest: EndpointManifest
    try {
        manifest = ctx.registry.get(name)
    } catch (err) {
        if (err instanceof ManifestError) throw new CliError('ENDPOINT_UNKNOWN', err.message)
        throw err
    }
    const enabled = ctx.config.endpoints.enabled
    if (enabled && !enabled.includes(name)) {
        throw new CliError('ENDPOINT_DISABLED', `endpoint "${name}" is not in endpoints.enabled`)
    }
    return manifest
}

/** Model selection: --model flag ?? per-endpoint default ?? global default. Never cross-connection. */
function resolveModel(ctx: Ctx, endpoint: string, flag: string | undefined): string | null {
    return flag ?? ctx.config.defaults.models[endpoint] ?? ctx.config.defaults.model
}

/** Effort selection: --effort flag ?? per-endpoint default ?? global default ?? null (native default). */
function resolveEffort(ctx: Ctx, endpoint: string, flag: string | undefined): string | null {
    return flag ?? ctx.config.defaults.efforts[endpoint] ?? ctx.config.defaults.effort
}

/** Submit-time model gate: a resolved model an endpoint cannot take headless is a config error, named with the repair. */
function checkModelSupported(manifest: EndpointManifest, model: string | null): void {
    if (model === null || manifest.command.model_arg !== undefined) return
    throw new CliError(
        'MODEL_UNSUPPORTED',
        `endpoint "${manifest.name}" has no headless model selection (its native config owns the model), but "${model}" is configured.` +
        ` Repair: remove defaults.models.${manifest.name} / defaults.model from config.json, or don't pass --model.`,
    )
}

/** Submit-time effort gate with dedicated codes; buildArgs re-validates the same rules for non-CLI callers. */
function checkEffort(manifest: EndpointManifest, effort: string | null): void {
    if (effort === null) return
    const block = manifest.effort
    if (!block) {
        throw new CliError(
            'EFFORT_UNSUPPORTED',
            `endpoint "${manifest.name}" has no effort selection (native default only).` +
            ` Repair: remove defaults.efforts.${manifest.name} / defaults.effort from config.json, or don't pass --effort.`,
        )
    }
    if (!block.options.includes(effort)) {
        throw new CliError('EFFORT_INVALID', `effort "${effort}" is not one of ${manifest.name}'s options: ${block.options.join(', ')}`)
    }
}

async function waitForTerminal(
    store: RunStore,
    runId: string,
    timeoutSec: number,
): Promise<RunStateRecord | null> {
    const deadline = timeoutSec > 0 ? Date.now() + timeoutSec * 1000 : Number.POSITIVE_INFINITY
    let lastLivenessProbe = 0
    for (;;) {
        const state = await store.readState(runId)
        if (!state) return null
        if (isTerminal(state.state)) return state
        // attention = the worker is gone and reconcile already flagged it; no
        // code path will restart it — waiting here would hang forever, so hand
        // the state back to the caller with terminal:false (codex P1-05)
        if (state.state === 'attention') return state
        // waiting-loop liveness: a worker that died mid-wait without reconcile
        // (reconcile only runs at CLI startup) would leave the run "running"
        // forever; probe the recorded pid periodically and surface the same
        // needs-attention signal instead of looping blind
        if (Date.now() - lastLivenessProbe > 5_000) {
            lastLivenessProbe = Date.now()
            const workerPid = state.worker?.pid
            if (workerPid !== undefined && workerPid !== null && !pidAlive(workerPid)) {
                return { ...state, state: 'attention' as const }
            }
        }
        if (Date.now() >= deadline) return state
        await new Promise((r) => setTimeout(r, 1_000))
    }
}

function resultOrNull(store: RunStore, runId: string): Promise<RunResult | null> {
    return store.readResult(runId).catch(() => null)
}

/** Launch the detached worker for a run, with the store-backed pid liveness probe (shared by run and probe). */
function launchWorkerFor(ctx: Ctx, runId: string): Promise<number> {
    return launchWorker(runId, {
        dataDir: ctx.dataDir,
        readWorkerPid: async () => {
            const s = await ctx.store.readState(runId)
            return s ? { workerPid: s.worker?.pid ?? null, terminal: isTerminal(s.state) } : null
        },
    })
}

// ---------- verbs ----------

async function verbRun(ctx: Ctx, args: string[]): Promise<void> {
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
        throw new CliError('TASK_REQUIRED', 'run requires --task <text> or --task-file <path>')
    }
    if (values.mode !== undefined && values.capabilities !== undefined) {
        throw new CliError('ARGS_INVALID', '--mode and --capabilities are mutually exclusive')
    }
    let mode: ModeSelection
    if (values.capabilities !== undefined) {
        let parsed: unknown
        try {
            parsed = JSON.parse(values.capabilities)
        } catch {
            throw new CliError('ARGS_INVALID', '--capabilities must be a JSON object like {"fs.write":true,"shell.exec":true}')
        }
        const set = parseCapabilitySet(parsed)
        if (!set) {
            throw new CliError(
                'ARGS_INVALID',
                '--capabilities must map capability names to true/false/options objects, with at least one required capability',
            )
        }
        mode = set
    } else {
        const preset = (values.mode ?? 'workspace-write') as PermissionPreset
        if (!(PERMISSION_PRESETS as readonly string[]).includes(preset)) {
            throw new CliError('MODE_INVALID', `mode must be one of ${PERMISSION_PRESETS.join(' | ')}`)
        }
        mode = preset
    }
    const perm = checkPermission(manifest, mode)
    if (!perm.ok) {
        throw new CliError(
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
    const model = resolveModel(ctx, manifest.name, values.model)
    checkModelSupported(manifest, model)
    const effort = resolveEffort(ctx, manifest.name, values.effort)
    checkEffort(manifest, effort)
    let runTimeoutFlag: number | null = null
    if (values['run-timeout'] !== undefined) {
        runTimeoutFlag = Number(values['run-timeout'])
        if (!Number.isFinite(runTimeoutFlag) || runTimeoutFlag < 0) {
            throw new CliError('ARGS_INVALID', '--run-timeout must be a non-negative number of seconds (0 disables)')
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
            throw new CliError('SPAWN_UNSUPPORTED', cmdShimRefusalMessage(manifest.name, spawnRes.plan.endpoint_bin ?? manifest.detect.bin))
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
            if (err instanceof ManifestError) throw new CliError('MANIFEST_INVALID', err.message)
            throw err
        }
        const bytes = measureArgvBytes([manifest.detect.bin, ...argv])
        const limit = manifest.command.prompt_max_bytes ?? DEFAULT_PROMPT_MAX_BYTES
        if (bytes > limit) {
            throw new CliError(
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
        model,
        effort,
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
        throw new CliError(
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

async function verbGet(ctx: Ctx, args: string[]): Promise<void> {
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
    if (!runId) throw new CliError('ARGS_INVALID', 'get requires a run_id')
    const timeoutSec = values.timeout ? Number(values.timeout) : 0
    if (!Number.isFinite(timeoutSec) || timeoutSec < 0) {
        throw new CliError('ARGS_INVALID', '--timeout must be a non-negative number of seconds')
    }
    const state = values.wait
        ? await waitForTerminal(ctx.store, runId, timeoutSec)
        : await ctx.store.readState(runId)
    if (!state) throw new CliError('RUN_NOT_FOUND', `no such run: ${runId}`)
    const result = await resultOrNull(ctx.store, runId)
    emitOk({ run: state, result, terminal: isTerminal(state.state) })
}

/**
 * Direct endpoint kill gated on PID-reuse identity (contracts §5): a start-token
 * mismatch is someone else's process — never taskkill it. Query failure degrades
 * to pid liveness with a note. Returns {killed, note}: killed=false means the
 * tree termination did NOT succeed (or identity said leave it alone) — the
 * caller must not report the run as stopped (codex P1-06).
 */
async function terminateRecordedEndpoint(
    endpointPid: number,
    recordedStart: string | null | undefined,
): Promise<{ killed: boolean; note: string | null }> {
    const verdict = await verifyProcessIdentity(endpointPid, recordedStart)
    if (verdict === 'mismatch') {
        return {
            killed: false,
            note: `endpoint pid ${endpointPid} start-token mismatch (pid reused by another process); not killed, treated as already gone`,
        }
    }
    if (!pidAlive(endpointPid)) return { killed: true, note: null }
    const term = await terminateEndpointTree(endpointPid)
    const identityNote = verdict === 'unknown'
        ? 'endpoint identity could not be re-verified (query unavailable); killed on pid liveness alone'
        : null
    if (!term.ok) {
        return {
            killed: false,
            note: `endpoint tree termination failed (pid ${endpointPid}: ${term.error}); the endpoint may still be running — verify before re-dispatching`,
        }
    }
    return { killed: true, note: identityNote }
}

async function verbCancel(ctx: Ctx, args: string[]): Promise<void> {
    const { positionals } = parseArgs({ args, strict: true, allowPositionals: true, options: {} })
    const runId = positionals[0]
    if (!runId) throw new CliError('ARGS_INVALID', 'cancel requires a run_id')
    const state = await ctx.store.readState(runId)
    if (!state) throw new CliError('RUN_NOT_FOUND', `no such run: ${runId}`)
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
            : { killed: true, note: null }
        if (term.killed) {
            await writeCancelledDirect(ctx.store, state, 'cancelled while attention (worker absent)')
            emitOk({ run_id: runId, state: 'cancelled', ...(term.note ? { note: term.note } : {}) })
        } else {
            await ctx.store.writeState(transitionRecord(state, 'attention', now()))
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
        : { killed: false, note: 'no recorded endpoint pid' }
    const latest = await ctx.store.readState(runId)
    if (term.killed && latest && !isTerminal(latest.state)) {
        await writeCancelledDirect(ctx.store, latest, 'cancel finalized by CLI after worker did not respond within 15s')
    } else if (!term.killed && latest && !isTerminal(latest.state)) {
        await ctx.store.writeState(transitionRecord(latest, 'attention', now()))
    }
    const after = await ctx.store.readState(runId)
    emitOk({
        run_id: runId,
        state: after?.state ?? 'cancelled',
        needs_attention: after?.state === 'attention' || undefined,
        note: [
            term.killed ? 'worker did not finalize within 15s; CLI closed the run' : 'worker did not finalize within 15s and the fallback kill was not confirmed; run left in attention',
            term.note,
        ].filter(Boolean).join('; '),
    })
}

async function writeCancelledDirect(store: RunStore, state: RunStateRecord, note: string): Promise<void> {
    const terminalAt = new Date().toISOString()
    // result.json is the terminal authority: when the worker raced us and already
    // wrote a terminal result, adopt its state instead of stamping cancelled over
    // it (codex P1-06: state/result divergence survives nothing — reconcile
    // skips terminal states and would never repair it)
    const existing = await store.readResult(state.run_id).catch(() => null)
    let finalState: 'cancelled' | RunResult['state'] = 'cancelled'
    if (existing && isTerminal(existing.state)) finalState = existing.state
    const result: RunResult = {
        schema_version: '1.0.0',
        run_id: state.run_id,
        state: finalState,
        exit_code: null,
        final_text: '',
        evidence: {
            deliverables: [],
            refusals: [],
            parser: { type: 'none', degraded: false },
            notes: [note],
        },
        usage: { input_tokens: null, output_tokens: null, cached_input_tokens: null, cost: null, source: 'unavailable' },
        session_handle: state.session.handle,
        terminal_at: terminalAt,
    }
    if (finalState === 'cancelled') {
        try {
            await store.writeResult(result)
        } catch {
            // worker raced us to result.json; its record wins
        }
    }
    try {
        await store.writeState(transitionRecord(state, finalState, terminalAt))
    } catch {
        // already transitioned by the worker
    }
}

async function verbList(ctx: Ctx, args: string[]): Promise<void> {
    const { values } = parseArgs({
        args,
        strict: true,
        options: {
            state: { type: 'string' },
            limit: { type: 'string' },
        },
    })
    const limit = values.limit ? Number(values.limit) : 50
    if (!Number.isInteger(limit) || limit <= 0) throw new CliError('ARGS_INVALID', '--limit must be a positive integer')
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

async function verbModels(ctx: Ctx, args: string[]): Promise<void> {
    const { values } = parseArgs({
        args,
        strict: true,
        options: {
            endpoint: { type: 'string' },
            refresh: { type: 'boolean', default: false },
        },
    })
    const manifest = pickEndpoint(ctx, values.endpoint)
    const cache = new ModelsCache(ctx.dataDir)
    const cached = await cache.read(manifest.name)

    // cache-first: a hit without --refresh is served with its fetched_at
    if (!values.refresh && cached) {
        emitOk({
            endpoint: manifest.name,
            models: cached.models,
            source: cached.source,
            fetched_at: cached.fetched_at,
            version: cached.version,
            from_cache: true,
            notes: cached.notes,
        })
        return
    }

    try {
        const configBin = ctx.config.endpoints.overrides[manifest.name]?.bin ?? null
        const spawnRes = await planEndpointSpawn(manifest, { configBin })
        const version = spawnRes.plan ? await detectVersion(manifest, spawnRes.plan) : null
        const entry = await discoverAndCacheModels(manifest, cache, version, configBin)
        if (!entry) {
            throw new CliError('UNSUPPORTED', `endpoint "${manifest.name}" has no model discovery in v0`)
        }
        emitOk({
            endpoint: manifest.name,
            models: entry.models,
            source: entry.source,
            fetched_at: entry.fetched_at,
            version,
            from_cache: false,
            notes: entry.notes,
        })
    } catch (err) {
        // a failed refresh keeps the last successful cache
        if (cached && !(err instanceof CliError && err.code === 'UNSUPPORTED')) {
            emitOk({
                endpoint: manifest.name,
                models: cached.models,
                source: cached.source,
                fetched_at: cached.fetched_at,
                version: cached.version,
                from_cache: true,
                stale: true,
                notes: cached.notes,
                warning: `live refresh failed (${err instanceof Error ? err.message : String(err)}); showing last successful cache`,
            })
            return
        }
        if (err instanceof CliError) throw err
        throw new CliError('MODELS_QUERY_FAILED', err instanceof Error ? err.message : String(err))
    }
}

/** Version values declared anywhere in the manifest (permission caps, command, resume, effort) — the drift reference set. */
function manifestVersionValues(manifest: EndpointManifest): string[] {
    const found = new Set<string>()
    const push = (v: unknown) => {
        if (typeof v === 'string' && v.length > 0) found.add(v)
    }
    push((manifest.command as { version?: unknown }).version)
    push(manifest.resume?.version)
    push(manifest.effort?.version)
    for (const value of Object.values(manifest.permission)) {
        if (value && typeof value === 'object' && 'version' in value) push((value as { version?: unknown }).version)
    }
    return [...found]
}

async function verbDoctor(ctx: Ctx): Promise<void> {
    const enabled = ctx.config.endpoints.enabled
    const modelsCache = new ModelsCache(ctx.dataDir)
    const endpoints = []
    const issues: string[] = []
    for (const manifest of ctx.registry.list()) {
        // list every manifest with an enabled flag — a disabled or not-yet-enabled
        // endpoint is information, not something to hide (codex P2-03)
        const isEnabled = enabled === null || enabled.includes(manifest.name)
        const configBin = ctx.config.endpoints.overrides[manifest.name]?.bin ?? null
        const spawnRes = await planEndpointSpawn(manifest, { configBin })
        let version: string | null = null
        let versionError: string | null = null
        if (spawnRes.plan) {
            version = await detectVersion(manifest, spawnRes.plan)
            if (version === null) versionError = 'version probe failed or timed out'
        }
        // drift = the installed version is not any version the manifest was
        // verified against — run `paidan probe --endpoint <name>` to recalibrate
        const knownVersions = manifestVersionValues(manifest)
        let drift: boolean | 'unknown' | null = null
        if (!spawnRes.plan) drift = null
        else if (version === null) drift = 'unknown'
        else drift = knownVersions.length > 0 && !knownVersions.includes(version)
        if (!spawnRes.plan) issues.push(`${manifest.name}: bin not resolvable (see repair_hint)`)
        else if (drift === true) issues.push(`${manifest.name}: version ${version} is not any manifest-verified version (known: ${knownVersions.join(', ')}) — run paidan probe --endpoint ${manifest.name}`)
        else if (drift === 'unknown') issues.push(`${manifest.name}: version probe failed — drift state unknown`)
        const cached = await modelsCache.read(manifest.name)
        const modelsCacheInfo = cached
            ? {
                fetched_at: cached.fetched_at,
                age_hours: Math.round(modelsCache.ageHours(cached) * 10) / 10,
                model_count: cached.models.length,
            }
            : null
        const permission: Record<string, unknown> = { presets: manifest.permission.presets }
        for (const [key, value] of Object.entries(manifest.permission)) {
            if (key === 'presets' || key.endsWith('_notes')) continue
            if (value && typeof value === 'object' && 'status' in value) {
                permission[key] = (value as { status: unknown }).status
            }
        }
        const nativePreflight = manifest.native_preflight
            ? await checkNativePreflight(manifest.native_preflight)
            : null
        endpoints.push({
            name: manifest.name,
            enabled: isEnabled,
            bin: manifest.detect.bin,
            bin_resolved: spawnRes.plan?.endpoint_bin ?? null,
            resolved_from: spawnRes.plan?.resolved_from ?? null,
            version,
            version_error: versionError,
            drift,
            manifest_versions: knownVersions,
            spawn_notes: spawnRes.notes,
            repair_hint: spawnRes.plan
                ? null
                : `set endpoints.overrides.${manifest.name}.bin in ${ctx.configPath} to the native binary or JS bundle, or install a PATH shim`,
            models_cache: modelsCacheInfo,
            effort_options: manifest.effort?.options ?? null,
            permission,
            native_preflight: nativePreflight,
            // read-only: what the endpoint's own home currently carries (the
            // "native default" reality — paidan never writes it)
            native_defaults: await readEndpointNativeDefaults(manifest),
            parser: manifest.parser,
            capabilities: manifest.capabilities ?? {},
        })
    }
    let usageDbStatus: Record<string, unknown> = { path: nodePath.join(ctx.dataDir, 'usage.db'), ok: false }
    try {
        const db = new UsageDb(nodePath.join(ctx.dataDir, 'usage.db'))
        db.close()
        usageDbStatus = { path: nodePath.join(ctx.dataDir, 'usage.db'), ok: true }
    } catch (err) {
        usageDbStatus.error = err instanceof Error ? err.message : String(err)
        issues.push(`usage.db: ${(err instanceof Error ? err.message : String(err)).slice(0, 120)}`)
    }
    // host skill state (read-only detection; installs only ever happen in init)
    let hosts: Array<{ name: string; detected: boolean; skills_dir: string; installed: boolean }> = []
    try {
        const registry = await loadHostRegistry(pkgRoot)
        const home = process.env.PAIDAN_HOST_HOME || os.homedir()
        hosts = (await detectHosts(registry, home)).map((h) => ({ name: h.name, detected: h.detected, skills_dir: h.skills_dir, installed: h.installed }))
    } catch {
        hosts = []
    }
    emitOk({
        config_path: ctx.configPath,
        config_exists: existsSync(ctx.configPath),
        data_dir: ctx.dataDir,
        runs_dir: ctx.store.runsDir,
        endpoints_dir: ctx.registry.dir,
        node: process.version,
        platform: process.platform,
        endpoints,
        hosts,
        // human-readable summary of what needs attention; ok:true only means
        // the doctor itself ran — read these per endpoint (codex P2-03)
        issues,
        usage_db: usageDbStatus,
    })
}

async function verbProbe(ctx: Ctx, args: string[]): Promise<void> {
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
        throw new CliError('ARGS_INVALID', '--timeout must be a positive number of seconds')
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
    /** cancel a probe run that outlived its wait: marker -> 15s -> fallback kill -> close out. Returns the (possibly still non-terminal) state. */
    const cancelProbeRun = async (runId: string): Promise<RunStateRecord | null> => {
        const st = await ctx.store.readState(runId)
        if (!st || isTerminal(st.state)) return st
        await writeJsonAtomic(ctx.store.cancelMarkerPath(runId), { requested_at: new Date().toISOString() })
        let s = await waitForTerminal(ctx.store, runId, 15)
        if (!s || !isTerminal(s.state)) {
            const pid = s?.worker?.endpoint_pid ?? null
            if (pid) await terminateRecordedEndpoint(pid, s?.worker?.endpoint_pid_start)
            const latest = await ctx.store.readState(runId)
            if (latest && !isTerminal(latest.state)) {
                await writeCancelledDirect(ctx.store, latest, 'probe wait timed out; cancelled by probe')
            }
            s = await ctx.store.readState(runId)
        }
        return s
    }
    const runProbeTask = async (
        task: string,
        opts: { cwd: string; deliverables?: Array<{ path: string; expected: string | null }>; resume?: string; mode?: PermissionPreset },
    ): Promise<{ runId: string; state: RunStateRecord | null; result: RunResult | null; timedOut: boolean }> => {
        const probeModel = resolveModel(ctx, manifest.name, undefined)
        checkModelSupported(manifest, probeModel)
        const probeEffort = resolveEffort(ctx, manifest.name, undefined)
        checkEffort(manifest, probeEffort)
        const created = await ctx.store.create({
            endpoint: manifest.name,
            cwd: opts.cwd,
            add_dirs: [],
            task_file: null,
            task_text: task,
            mode: opts.mode ?? probePreset ?? 'workspace-write',
            model: probeModel,
            effort: probeEffort,
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
    if (probes.some((p) => p.verdict === 'pass')) {
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

async function detectVersion(manifest: EndpointManifest, plan: SpawnPlan): Promise<string | null> {
    try {
        const r = await execFileAsync(
            plan.command,
            finalSpawnArgs(plan, manifest.detect.version_args ?? ['--version']),
            {
                timeout: 5_000,
                windowsHide: true,
                windowsVerbatimArguments: needsVerbatimArgs(plan),
            },
        )
        const text = `${r.stdout}\n${r.stderr}`.trim()
        const re = manifest.detect.version_re ? new RegExp(manifest.detect.version_re) : null
        const m = re ? re.exec(text) : null
        return m?.[1] ?? text.split(/\r?\n/)[0] ?? null
    } catch {
        return null
    }
}

// ---------- init wizard ----------

/** Package root (dist/cli.js -> ..); the skill payload and host registry live under skills/. */
const pkgRoot = fileURLToPath(new URL('..', import.meta.url))

/** Host-skill detection for the wizard; a missing registry degrades to "no hosts" with a note. */
async function gatherHostInfo(): Promise<{ hosts: HostInfo[]; source: string | null }> {
    try {
        const registry = await loadHostRegistry(pkgRoot)
        // PAIDAN_HOST_HOME is a test hook (keeps tests off real agent homes); production = os.homedir()
        const home = process.env.PAIDAN_HOST_HOME || os.homedir()
        return { hosts: await detectHosts(registry, home), source: nodePath.join(pkgRoot, registry.skill.source) }
    } catch {
        return { hosts: [], source: null }
    }
}

/** Read-only native-defaults probe (the model/effort the endpoint's own home currently carries); null = no probed surface. */
async function readEndpointNativeDefaults(manifest: EndpointManifest): Promise<NativeDefaults | null> {
    try {
        const mod = await loadParserModule(manifest.parser)
        if (!mod.readNativeDefaults) return null
        return await mod.readNativeDefaults()
    } catch {
        return null
    }
}

/** Detection + model discovery for every manifest. Discovery entries are collected in memory only (persist:false) — an aborted or surveyed init writes nothing; the caller persists after committing answers (codex P1-04). */
async function gatherEndpointInfo(ctx: Ctx): Promise<{ info: InitEndpointInfo[]; pendingCache: CachedModels[]; cache: ModelsCache }> {
    const cache = new ModelsCache(ctx.dataDir)
    const out: InitEndpointInfo[] = []
    const pendingCache: CachedModels[] = []
    for (const manifest of ctx.registry.list()) {
        const configBin = ctx.config.endpoints.overrides[manifest.name]?.bin ?? null
        const spawnRes = await planEndpointSpawn(manifest, { configBin })
        const detected = spawnRes.plan !== null
        const version = spawnRes.plan ? await detectVersion(manifest, spawnRes.plan) : null
        let models: InitEndpointInfo['models'] = []
        try {
            const entry = await discoverAndCacheModels(manifest, cache, version, configBin, { persist: false })
            if (entry) {
                models = entry.models
                pendingCache.push(entry)
            }
        } catch {
            // discovery is best-effort during init; notes stay with the cache
        }
        out.push({
            name: manifest.name,
            detected,
            version,
            models,
            model_selectable: manifest.command.model_arg !== undefined,
            effort_options: manifest.effort?.options ?? null,
            native: await readEndpointNativeDefaults(manifest),
            repair: detected ? null : (spawnRes.notes.at(-1) ?? null),
        })
    }
    return { info: out, pendingCache, cache }
}

async function verbInit(ctx: Ctx, args: string[]): Promise<number> {
    const { values } = parseArgs({
        args,
        strict: true,
        options: {
            yes: { type: 'boolean', default: false },
            effort: { type: 'string' },
            hosts: { type: 'string' },
        },
    })
    const hostsFilter = values.hosts !== undefined
        ? values.hosts.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
        : null
    if (hostsFilter !== null && !values.yes) {
        throw new CliError('ARGS_INVALID', '--hosts applies to the --yes path (the interactive wizard picks hosts with checkboxes)')
    }
    const { info, pendingCache, cache } = await gatherEndpointInfo(ctx)
    const hostInfo = await gatherHostInfo()
    if (hostsFilter !== null) {
        const detectedNames = new Set(hostInfo.hosts.filter((h) => h.detected).map((h) => h.name))
        const unknown = hostsFilter.filter((h) => !detectedNames.has(h))
        if (unknown.length > 0) {
            throw new CliError('ARGS_INVALID', `--hosts names not detected on this machine: ${unknown.join(', ')} (detected: ${[...detectedNames].join(', ') || 'none'})`)
        }
    }

    if (!process.stdin.isTTY && !values.yes) {
        // non-TTY callers (pipes, agents) get state + guidance, never a hanging
        // prompt; the survey itself wrote nothing (model caches persist only
        // after a completed init)
        process.stdout.write(JSON.stringify({
            ok: false,
            error: { code: 'INIT_INTERACTIVE_REQUIRED', message: 'init is interactive on a TTY; use --yes for defaults or edit config.json directly' },
            state: {
                config_path: ctx.configPath,
                config_exists: existsSync(ctx.configPath),
                endpoints: info,
                hosts: hostInfo.hosts.map((h) => ({ name: h.name, detected: h.detected, skills_dir: h.skills_dir })),
                non_interactive: 'paidan init --yes enables all detected endpoints and leaves every model/effort at the endpoint\'s native default (the agent\'s own home carries them; --yes --effort <level> additionally applies that level to every endpoint whose options include it; --hosts <names> restricts the skill install to those hosts); the skill is installed into every detected host unless --hosts narrows it',
            },
        }) + '\n')
        return 1
    }

    let answers: InitAnswers
    if (values.yes) {
        answers = defaultInitAnswers(info, hostInfo.hosts.filter((h) => h.detected).map((h) => h.name), values.effort, hostsFilter)
    } else {
        try {
            answers = await promptInitAnswers(info, hostInfo.hosts, ctx.config)
        } catch (err) {
            if (err instanceof PromptAbort) {
                process.stdout.write(
                    JSON.stringify({
                        ok: false,
                        error: {
                            code: 'INIT_ABORTED',
                            message: 'init aborted by user (Ctrl+C); config, skills and this survey\'s model caches were not written',
                        },
                    }) + '\n',
                )
                return 130
            }
            throw err
        }
    }
    const cfg = buildInitConfig(info, answers, ctx.config)
    const selectedHosts = selectSkillHosts(hostInfo.hosts, answers.skill_hosts)

    if (existsSync(ctx.configPath)) {
        // one cheap insurance copy before overwrite
        await fs.copyFile(ctx.configPath, `${ctx.configPath}.bak-${Date.now()}`).catch(() => {})
    }
    // re-init merges: the wizard owns endpoints.enabled + the wizard-owned
    // defaults keys (endpoint/model/models/effort/efforts); machine-local keys
    // it does not own (endpoints.overrides, dataDir, defaults.run_timeout_sec,
    // ...) survive. The global model/effort fallbacks are deliberately cleared:
    // they poison endpoints without that selection surface and a surviving
    // global silently overrides a "native" wizard choice.
    let existingRaw: Record<string, unknown> = {}
    if (existsSync(ctx.configPath)) {
        existingRaw = JSON.parse(await fs.readFile(ctx.configPath, 'utf8')) as Record<string, unknown>
    }
    const merged = mergeInitConfig(existingRaw, cfg)
    await writeJsonAtomic(ctx.configPath, merged)
    // the survey's model caches persist only now — an aborted or surveyed
    // (non-TTY) init wrote nothing at all (codex P1-04)
    for (const entry of pendingCache) await cache.write(entry).catch(() => {})

    const skills: SkillInstallResult[] = []
    if (selectedHosts.length > 0 && hostInfo.source) {
        for (const host of selectedHosts) {
            try {
                skills.push(await installSkill(host, hostInfo.source))
            } catch (err) {
                // one failing host must not sink the rest; the envelope reports it
                skills.push({
                    host: host.name,
                    path: host.target,
                    status: 'error',
                    error: err instanceof Error ? err.message : String(err),
                })
            }
        }
    }
    const effortReport = values.effort !== undefined
        ? {
            // --effort preference report: where it landed and where it could not
            effort_preference: values.effort,
            effort_applied_to: Object.keys(cfg.defaults.efforts),
            effort_skipped: info
                .filter((e) => e.detected && e.effort_options && !e.effort_options.includes(values.effort as string))
                .map((e) => `${e.name} (top option: ${(e.effort_options ?? []).at(-1) ?? '?'})`),
        }
        : {}
    emitOk({
        config_path: ctx.configPath,
        written: true,
        enabled: answers.enabled,
        defaults: cfg.defaults,
        // what actually applies after the merge — machine keys and the cleared
        // global fallbacks are visible here, not just the wizard's own answers
        effective_defaults: (merged.defaults ?? {}) as Record<string, unknown>,
        endpoints: info.map((e) => ({ name: e.name, detected: e.detected, version: e.version, models: e.models.length })),
        ...effortReport,
        skills,
    })
    return 0
}

async function promptInitAnswers(info: InitEndpointInfo[], hosts: HostInfo[], config: PaidanConfig): Promise<InitAnswers> {
    process.stderr.write('paidan init — detection complete. Human output is on stderr; stdout stays JSON.\n\n')
    if (rawSelectSupported()) return promptInitRaw(info, hosts, config)
    return promptInitLine(info, hosts, config)
}

/** Raw-mode wizard: checkbox multi-selects (space toggles, enter confirms) and arrow-key menus. */
async function promptInitRaw(info: InitEndpointInfo[], hosts: HostInfo[], config: PaidanConfig): Promise<InitAnswers> {
    const detectedEps = info.filter((e) => e.detected)
    for (const ep of info) {
        if (!ep.detected) {
            process.stderr.write(`  ${ep.name}  NOT detected — skipped${ep.repair ? `. Repair: ${ep.repair}` : ''}\n`)
        }
    }
    let enabled: string[] = []
    if (detectedEps.length > 0) {
        // re-init starts from the current selection, fresh installs from "all"
        const preEnabled = config.endpoints.enabled
        const picked = await checkboxSelect(
            'Enable endpoints',
            detectedEps.map((ep) => ({
                label: `${ep.name}  ${ep.version ?? 'unknown version'}`,
                hint: ep.models.length > 0 ? `${ep.models.length} models` : undefined,
                checked: preEnabled ? preEnabled.includes(ep.name) : true,
            })),
        )
        enabled = picked.map((i) => (detectedEps[i] as InitEndpointInfo).name)
    }
    let defaultEndpoint: string | null = null
    const models: Record<string, string | null> = {}
    const efforts: Record<string, string | null> = {}
    if (enabled.length > 0) {
        defaultEndpoint = enabled[await menuSelect('Default endpoint', enabled.map((name) => ({ label: name })), enabled.indexOf(config.defaults.endpoint ?? ''))] as string
        // every enabled endpoint gets its own default model and effort — the
        // decision plan is shared (init-plan), this shell only renders it
        for (const name of enabled) {
            const epInfo = info.find((e) => e.name === name) as InitEndpointInfo
            const q = planEndpointDefaultQuestions(epInfo, config)
            if (q.model.kind === 'skip-no-selection') {
                process.stderr.write(`(no headless model selection for ${name}; its native config owns the model${q.nativeModel ? ` (currently ${q.nativeModel})` : ''})\n`)
            } else if (q.model.kind === 'skip-none') {
                process.stderr.write(`(no discovered models for ${name}; native default will be used; a hand-set default survives in config.json)\n`)
            } else {
                if (q.model.staleModelValue) {
                    process.stderr.write(`(configured model "${q.model.staleModelValue}" for ${name} is not in the discovered lineup; keep it explicitly or pick another)\n`)
                }
                const idx = await menuSelect(
                    `Default model for ${name}`,
                    q.model.options.map((alias) => ({
                        label: alias,
                        hint: epInfo.models.find((m) => m.alias === alias)?.connection ?? undefined,
                    })),
                    q.model.options.indexOf(q.model.fallback),
                )
                const choice = q.model.options[idx] as string
                if (choice === q.nativeModelLabel) models[name] = null
                else if (q.model.staleModelValue && choice === `(keep current: ${q.model.staleModelValue})`) models[name] = q.model.staleModelValue
                else models[name] = choice
            }
            if (q.effort.kind === 'skip') {
                process.stderr.write(`(no effort selection for ${name}; ${q.nativeEffortNote})\n`)
            } else {
                if (q.effort.staleValue) {
                    process.stderr.write(`(configured effort "${q.effort.staleValue}" for ${name} is no longer in its options; it will be replaced unless you pick one)\n`)
                }
                const idx = await menuSelect(
                    `Default effort for ${name}`,
                    q.effort.options.map((o) => ({ label: o })),
                    q.effort.options.indexOf(q.effort.fallback),
                )
                const choice = q.effort.options[idx] as string
                if (choice !== q.nativeEffortLabel) efforts[name] = choice
            }
        }
    }
    const skillHosts: string[] = []
    const detectedHosts = hosts.filter((h) => h.detected)
    if (detectedHosts.length > 0) {
        const picked = await checkboxSelect(
            'Install skill into hosts',
            detectedHosts.map((h) => ({
                label: h.name,
                hint: `${h.skills_dir}${h.installed ? ' — already installed' : ''}`,
                // preselect what is actually installed; a newly detected host is
                // opt-in (explicit selection, never a silent write to a new home)
                checked: h.installed,
            })),
        )
        skillHosts.push(...picked.map((i) => (detectedHosts[i] as HostInfo).name))
    }
    return { enabled, default_endpoint: defaultEndpoint, models, efforts, skill_hosts: skillHosts }
}

/** Line-based fallback for when stderr is not a TTY (raw-mode widgets need it). */
async function promptInitLine(info: InitEndpointInfo[], hosts: HostInfo[], config: PaidanConfig): Promise<InitAnswers> {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
    try {
        process.stderr.write('Endpoints:\n')
        const detectedEps: InitEndpointInfo[] = []
        for (const ep of info) {
            if (ep.detected) {
                detectedEps.push(ep)
                process.stderr.write(`  ${detectedEps.length}) ${ep.name}  detected ${ep.version ?? 'unknown version'}${ep.models.length > 0 ? ` (${ep.models.length} models)` : ''}\n`)
            } else {
                process.stderr.write(`     ${ep.name}  NOT detected — skipped${ep.repair ? `. Repair: ${ep.repair}` : ''}\n`)
            }
        }
        let enabled: string[] = []
        if (detectedEps.length > 0) {
            const preEnabled = config.endpoints.enabled
            const fallback = preEnabled
                ? detectedEps.map((_, i) => i).filter((i) => preEnabled.includes((detectedEps[i] as InitEndpointInfo).name))
                : detectedEps.map((_, i) => i)
            const picked = await pickMulti(rl, 'Enable endpoints', detectedEps.length, fallback)
            enabled = picked.map((i) => (detectedEps[i] as InitEndpointInfo).name)
        }
        let defaultEndpoint: string | null = null
        const models: Record<string, string | null> = {}
        const efforts: Record<string, string | null> = {}
        if (enabled.length > 0) {
            const preDefault = config.defaults.endpoint && enabled.includes(config.defaults.endpoint) ? config.defaults.endpoint : (enabled[0] as string)
            defaultEndpoint = await pickOne(rl, 'Default endpoint', enabled, preDefault)
            // every enabled endpoint gets its own default model and effort — the
            // decision plan is shared (init-plan), this shell only renders it
            for (const name of enabled) {
                const epInfo = info.find((e) => e.name === name) as InitEndpointInfo
                const q = planEndpointDefaultQuestions(epInfo, config)
                if (q.model.kind === 'skip-no-selection') {
                    process.stderr.write(`(no headless model selection for ${name}; its native config owns the model${q.nativeModel ? ` (currently ${q.nativeModel})` : ''})\n`)
                } else if (q.model.kind === 'skip-none') {
                    process.stderr.write(`(no discovered models for ${name}; native default will be used; a hand-set default survives in config.json)\n`)
                } else {
                    if (q.model.staleModelValue) {
                        process.stderr.write(`(configured model "${q.model.staleModelValue}" for ${name} is not in the discovered lineup; keep it explicitly or pick another)\n`)
                    }
                    const choice = await pickOne(rl, `Default model for ${name}`, q.model.options, q.model.fallback)
                    if (choice === q.nativeModelLabel) models[name] = null
                    else if (q.model.staleModelValue && choice === `(keep current: ${q.model.staleModelValue})`) models[name] = q.model.staleModelValue
                    else models[name] = choice
                }
                if (q.effort.kind === 'skip') {
                    process.stderr.write(`(no effort selection for ${name}; ${q.nativeEffortNote})\n`)
                } else {
                    if (q.effort.staleValue) {
                        process.stderr.write(`(configured effort "${q.effort.staleValue}" for ${name} is no longer in its options; it will be replaced unless you pick one)\n`)
                    }
                    const choice = await pickOne(rl, `Default effort for ${name}`, q.effort.options, q.effort.fallback)
                    if (choice !== q.nativeEffortLabel) efforts[name] = choice
                }
            }
        }
        const skillHosts: string[] = []
        const detectedHosts = hosts.filter((h) => h.detected)
        if (detectedHosts.length > 0) {
            process.stderr.write('\nHosts for the paidan skill (copied into each selected host):\n')
            detectedHosts.forEach((h, i) => {
                process.stderr.write(`  ${i + 1}) ${h.name} (${h.skills_dir}${h.installed ? ' — already installed' : ''})\n`)
            })
            const picked = await pickMulti(rl, 'Install skill into hosts', detectedHosts.length,
                // default keeps installed hosts only; newly detected hosts are opt-in
                detectedHosts.map((h, i) => (h.installed ? i : -1)).filter((i) => i >= 0))
            skillHosts.push(...picked.map((i) => (detectedHosts[i] as HostInfo).name))
        }
        return { enabled, default_endpoint: defaultEndpoint, models, efforts, skill_hosts: skillHosts }
    } finally {
        rl.close()
    }
}

/** Multi-select prompt: one question, space/comma-separated numbers; empty = fallback (default: all). */
async function pickMulti(rl: readline.Interface, title: string, count: number, fallback?: number[]): Promise<number[]> {
    const all = Array.from({ length: count }, (_, i) => i)
    const fb = fallback ?? all
    for (;;) {
        const answer = await rl.question(`${title} [1-${count}, all, none] (default ${fb.length === count ? 'all' : fb.map((i) => i + 1).join(' ')}): `)
        try {
            return parseMultiSelect(answer, count, fb)
        } catch (err) {
            process.stderr.write(`${(err as Error).message}\n`)
        }
    }
}

async function pickOne(rl: readline.Interface, title: string, options: string[], fallback: string): Promise<string> {
    process.stderr.write(`${title}:\n`)
    options.forEach((opt, i) => process.stderr.write(`  ${i + 1}) ${opt}\n`))
    for (;;) {
        const answer = (await rl.question(`Choose [1-${options.length}] (default ${fallback}): `)).trim()
        if (answer === '') return fallback
        const n = Number(answer)
        if (Number.isInteger(n) && n >= 1 && n <= options.length) return options[n - 1] as string
        process.stderr.write('invalid choice\n')
    }
}

// ---------- entry ----------

/** Per-verb flag reference for `paidan help <verb>` (human text on stderr; stdout stays JSON). */
const VERB_HELP: Record<string, string> = {
    init: 'init [--yes] [--effort <level>] [--hosts <name,name>]\n' +
        '  interactive wizard on a TTY; --yes = enable all detected endpoints, every model/effort\n' +
        '  stays at the endpoint native default, skill into every detected host;\n' +
        '  --yes --effort <level> applies that level where declared; --yes --hosts <names>\n' +
        '  restricts the skill install to those hosts',
    run: 'run --endpoint <name> --cwd <abs> (--task <text> | --task-file <file>)\n' +
        '  [--mode read-only|workspace-write|unattended | --capabilities <json>] [--model <alias>]\n' +
        '  [--effort <level>] [--resume <session_handle>] [--add-dir <path>]... [--deliverable <rel>]...\n' +
        '  [--run-timeout <sec>] (0 disables; default 1800 or defaults.run_timeout_sec)',
    get: 'get <run_id> [--wait] [--timeout <sec>]\n' +
        '  --wait blocks until terminal/attention or --timeout; attention returns immediately',
    cancel: 'cancel <run_id>   (explicit only; no-op on terminal runs)',
    list: 'list [--state completed,failed,cancelled,unknown,attention] [--limit N]',
    models: 'models --endpoint <name> [--refresh]   (cache-first; --refresh re-queries live)',
    doctor: 'doctor   (detection, versions, drift, native_defaults, hosts, issues)',
    probe: 'probe --endpoint <name> [--timeout <sec>]\n' +
        '  P1 write / P2 read-only refusal / P3 resume contract probes; real agent calls',
}

async function main(): Promise<number> {
    const [verb, ...rest] = process.argv.slice(2)
    if (verb === '--version' || verb === '-v' || verb === 'version') {
        const pkg = JSON.parse(await fs.readFile(nodePath.join(pkgRoot, 'package.json'), 'utf8')) as { version: string }
        emitOk({ version: pkg.version, node: process.version })
        return 0
    }
    if (!verb || verb === 'help' || verb === '--help' || verb === '-h') {
        const topic = rest[0]
        if (topic && VERB_HELP[topic]) {
            process.stderr.write(`paidan ${topic} — flags:\n  ${VERB_HELP[topic].replaceAll('\n', '\n  ')}\n`)
            emitOk({ verb: topic, flags: VERB_HELP[topic] })
            return 0
        }
        if (topic) {
            process.stderr.write(`unknown verb "${topic}"; paidan verbs: ${Object.keys(VERB_HELP).join(' | ')}\n`)
            return 1
        }
        process.stderr.write(
            `paidan ${await fs.readFile(nodePath.join(pkgRoot, 'package.json'), 'utf8').then((s) => (JSON.parse(s) as { version: string }).version).catch(() => '')} — verbs: ${Object.keys(VERB_HELP).join(' | ')}\n` +
            'help <verb> shows per-verb flags; --version prints JSON. All other stdout is a single JSON envelope.\n',
        )
        return verb ? 0 : 1
    }
    // `<verb> --help/-h` short-circuits before strict parseArgs rejects it
    if (rest.includes('--help') || rest.includes('-h')) {
        process.stderr.write(`paidan ${verb} — flags:\n  ${(VERB_HELP[verb] ?? 'no help for this verb').replaceAll('\n', '\n  ')}\n`)
        emitOk({ verb, flags: VERB_HELP[verb] ?? null })
        return 0
    }
    const ctx = await makeCtx()
    // startup reconcile: mark dead-worker runs attention; never restarts anything
    await reconcileRuns(ctx.store).catch(() => {})
    switch (verb) {
        case 'init':
            return await verbInit(ctx, rest)
        case 'run':
            await verbRun(ctx, rest)
            return 0
        case 'get':
            await verbGet(ctx, rest)
            return 0
        case 'cancel':
            await verbCancel(ctx, rest)
            return 0
        case 'list':
            await verbList(ctx, rest)
            return 0
        case 'models':
            await verbModels(ctx, rest)
            return 0
        case 'doctor':
            await verbDoctor(ctx)
            return 0
        case 'probe':
            await verbProbe(ctx, rest)
            return 0
        default:
            throw new CliError('ARGS_INVALID', `unknown verb "${verb}"`)
    }
}

main()
    .then((code) => {
        process.exitCode = code
    })
    .catch((err) => {
        process.exitCode = emitError(err)
    })
