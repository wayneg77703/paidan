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
    loadConfig,
    resolveDataDir,
    type PaidanConfig,
} from './engine/config.js'
import {
    defaultInitAnswers,
    buildInitConfig,
    initConfigToJson,
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
import { ModelsCache, type CachedModels } from './engine/models-cache.js'
import { RunStore, writeJsonAtomic } from './engine/run-store.js'
import { isTerminal, transitionRecord } from './engine/state-machine.js'
import { launchWorker, terminateEndpointTree } from './engine/supervisor.js'
import { UsageDb } from './engine/usage-db.js'
import {
    PERMISSION_PRESETS,
    type PermissionPreset,
    type RunResult,
    type RunState,
    type RunStateRecord,
} from './engine/types.js'
import {
    checkPermission,
    EndpointRegistry,
    loadParserModule,
    ManifestError,
    pickProbePreset,
    type EndpointManifest,
} from './endpoints/registry.js'
import { finalSpawnArgs, needsVerbatimArgs, planEndpointSpawn, type SpawnPlan } from './endpoints/spawn.js'

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
        const message = err instanceof Error ? err.message : String(err)
        process.stdout.write(JSON.stringify({ ok: false, error: { code: 'INTERNAL', message } }) + '\n')
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

async function waitForTerminal(
    store: RunStore,
    runId: string,
    timeoutSec: number,
): Promise<RunStateRecord | null> {
    const deadline = timeoutSec > 0 ? Date.now() + timeoutSec * 1000 : Number.POSITIVE_INFINITY
    for (;;) {
        const state = await store.readState(runId)
        if (!state) return null
        if (isTerminal(state.state)) return state
        if (Date.now() >= deadline) return state
        await new Promise((r) => setTimeout(r, 1_000))
    }
}

function resultOrNull(store: RunStore, runId: string): Promise<RunResult | null> {
    return store.readResult(runId).catch(() => null)
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
            model: { type: 'string' },
            effort: { type: 'string' },
            resume: { type: 'string' },
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
    const mode = (values.mode ?? 'workspace-write') as PermissionPreset
    if (!(PERMISSION_PRESETS as readonly string[]).includes(mode)) {
        throw new CliError('MODE_INVALID', `mode must be one of ${PERMISSION_PRESETS.join(' | ')}`)
    }
    const perm = checkPermission(manifest, mode)
    if (!perm.ok) {
        throw new CliError(
            'PERMISSION_UNSUPPORTED',
            `endpoint "${manifest.name}" cannot enforce mode "${mode}"; unsupported: ${perm.missing.join(', ')}`,
        )
    }
    const cwd = nodePath.resolve(values.cwd ?? process.cwd())
    const created = await ctx.store.create({
        endpoint: manifest.name,
        cwd,
        add_dirs: (values['add-dir'] ?? []).map((d) => nodePath.resolve(d)),
        task_file: taskFile,
        task_text: taskText,
        mode,
        model: values.model ?? ctx.config.defaults.model,
        effort: values.effort ?? null,
        resume_session: values.resume ?? null,
        deliverables: (values.deliverable ?? []).map((p) => ({ path: p, expected: null })),
        warnings: perm.warnings,
    })
    if (!created.created) {
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
        await launchWorker(runId, {
            dataDir: ctx.dataDir,
            readWorkerPid: async () => {
                const s = await ctx.store.readState(runId)
                return s ? { workerPid: s.worker?.pid ?? null, terminal: isTerminal(s.state) } : null
            },
        })
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
        // worker is gone; kill a possibly orphaned endpoint process, then close out
        const endpointPid = state.worker?.endpoint_pid ?? null
        if (endpointPid && pidAlive(endpointPid)) {
            await terminateEndpointTree(endpointPid)
        }
        await writeCancelledDirect(ctx.store, state, 'cancelled while attention (worker absent)')
        emitOk({ run_id: runId, state: 'cancelled' })
        return
    }

    // pending/running: the worker owns the kill so the evidence trail is consistent
    await writeJsonAtomic(ctx.store.cancelMarkerPath(runId), { requested_at: now() })
    const final = await waitForTerminal(ctx.store, runId, 15)
    if (final && isTerminal(final.state)) {
        emitOk({ run_id: runId, state: final.state })
        return
    }
    // worker wedged: direct fallback kill + close out
    const endpointPid = final?.worker?.endpoint_pid ?? null
    if (endpointPid && pidAlive(endpointPid)) {
        await terminateEndpointTree(endpointPid)
    }
    const latest = await ctx.store.readState(runId)
    if (latest && !isTerminal(latest.state)) {
        await writeCancelledDirect(ctx.store, latest, 'cancel finalized by CLI after worker did not respond within 15s')
    }
    const after = await ctx.store.readState(runId)
    emitOk({ run_id: runId, state: after?.state ?? 'cancelled', note: 'worker did not finalize within 15s; CLI closed the run' })
}

async function writeCancelledDirect(store: RunStore, state: RunStateRecord, note: string): Promise<void> {
    const terminalAt = new Date().toISOString()
    const result: RunResult = {
        schema_version: '1.0.0',
        run_id: state.run_id,
        state: 'cancelled',
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
    try {
        await store.writeResult(result)
    } catch {
        // worker raced us to result.json; its record wins
    }
    try {
        await store.writeState(transitionRecord(state, 'cancelled', terminalAt))
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
        const parserMod = manifest.models?.parse ? await loadParserModule(manifest.parser) : null
        if (!parserMod?.discoverModels) {
            throw new CliError('UNSUPPORTED', `endpoint "${manifest.name}" has no model discovery in v0`)
        }
        const { models, notes } = await parserMod.discoverModels()
        const spawnRes = await planEndpointSpawn(manifest, {
            configBin: ctx.config.endpoints.overrides[manifest.name]?.bin ?? null,
        })
        const version = spawnRes.plan ? await detectVersion(manifest, spawnRes.plan) : null
        const entry: CachedModels = {
            schema_version: '1.0.0',
            endpoint: manifest.name,
            fetched_at: new Date().toISOString(),
            version,
            source: manifest.models?.parse ?? 'parser-module',
            models,
            notes: [...notes, 'selection = config.json defaults.model; no cross-connection fallback'],
        }
        // success writes through, even with an empty model list (no borrowing)
        await cache.write(entry)
        emitOk({
            endpoint: manifest.name,
            models,
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

async function verbDoctor(ctx: Ctx): Promise<void> {
    const enabled = ctx.config.endpoints.enabled
    const modelsCache = new ModelsCache(ctx.dataDir)
    const endpoints = []
    for (const manifest of ctx.registry.list()) {
        if (enabled && !enabled.includes(manifest.name)) continue
        const configBin = ctx.config.endpoints.overrides[manifest.name]?.bin ?? null
        const spawnRes = await planEndpointSpawn(manifest, { configBin })
        let version: string | null = null
        let versionError: string | null = null
        if (spawnRes.plan) {
            version = await detectVersion(manifest, spawnRes.plan)
            if (version === null) versionError = 'version probe failed or timed out'
        }
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
        endpoints.push({
            name: manifest.name,
            bin: manifest.detect.bin,
            bin_resolved: spawnRes.plan?.endpoint_bin ?? null,
            resolved_from: spawnRes.plan?.resolved_from ?? null,
            version,
            version_error: versionError,
            spawn_notes: spawnRes.notes,
            repair_hint: spawnRes.plan
                ? null
                : `set endpoints.overrides.${manifest.name}.bin in ${ctx.configPath} to the native binary or JS bundle, or install a PATH shim`,
            models_cache: modelsCacheInfo,
            permission,
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
    const configBin = ctx.config.endpoints.overrides[manifest.name]?.bin ?? null
    const spawnRes = await planEndpointSpawn(manifest, { configBin })
    const probes: Array<{ name: string; verdict: 'pass' | 'fail' | 'skip'; detail: string }> = []
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
    const runProbeTask = async (
        task: string,
        opts: { cwd?: string; deliverables?: Array<{ path: string; expected: string | null }>; resume?: string; mode?: PermissionPreset },
    ) => {
        const ownCwd = opts.cwd === undefined
        const cwd = opts.cwd ?? (await fs.mkdtemp(nodePath.join(os.tmpdir(), 'paidan-probe-')))
        try {
            const created = await ctx.store.create({
                endpoint: manifest.name,
                cwd,
                add_dirs: [],
                task_file: null,
                task_text: task,
                mode: opts.mode ?? probePreset ?? 'workspace-write',
                model: ctx.config.defaults.model,
                effort: null,
                resume_session: opts.resume ?? null,
                deliverables: opts.deliverables ?? [],
                warnings: [],
            })
            const runId = created.request.run_id
            await launchWorker(runId, {
                dataDir: ctx.dataDir,
                readWorkerPid: async () => {
                    const s = await ctx.store.readState(runId)
                    return s ? { workerPid: s.worker?.pid ?? null, terminal: isTerminal(s.state) } : null
                },
            })
            const state = await waitForTerminal(ctx.store, runId, timeoutSec)
            const result = await resultOrNull(ctx.store, runId)
            return { runId, state, result }
        } finally {
            if (ownCwd) await fs.rm(cwd, { recursive: true, force: true }).catch(() => {})
        }
    }

    // P1 write contract
    if (probePreset === null) {
        probes.push({ name: 'P1-write', verdict: 'skip', detail: 'endpoint supports no permission preset' })
    } else {
        const token = `paidan-probe-${Date.now()}`
        try {
            const { state, result } = await runProbeTask(
                `Create a file named probe-write.txt in the current directory whose entire content is exactly: ${token} Then reply "done".`,
                { deliverables: [{ path: 'probe-write.txt', expected: token }] },
            )
            const found = result?.evidence.deliverables.every((d) => d.found) ?? false
            probes.push({
                name: 'P1-write',
                verdict: state?.state === 'completed' && found ? 'pass' : 'fail',
                detail: `preset=${probePreset} state=${state?.state ?? 'none'} deliverable_found=${found}`,
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
        // Live P2: under the read-only preset the file must NOT be created,
        // and the refusal should be observable in terminal evidence.
        const p2cwd = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'paidan-probe-p2-'))
        try {
            const { state, result } = await runProbeTask(
                'Create a file named probe-ro.txt in the current directory with content "x", then reply "done".',
                { cwd: p2cwd, mode: 'read-only' },
            )
            const created = await fs.stat(nodePath.join(p2cwd, 'probe-ro.txt')).then(() => true, () => false)
            const refusals = result?.evidence.refusals ?? []
            probes.push({
                name: 'P2-readonly-refusal',
                verdict: !created ? 'pass' : 'fail',
                detail: `file_created=${created} state=${state?.state ?? 'none'} refusals=${refusals.join('|') || 'none-observed'}`,
            })
        } catch (err) {
            probes.push({ name: 'P2-readonly-refusal', verdict: 'fail', detail: err instanceof Error ? err.message : String(err) })
        } finally {
            await fs.rm(p2cwd, { recursive: true, force: true }).catch(() => {})
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
                probes.push({ name: 'P3-resume', verdict: 'fail', detail: 'first run produced no session handle' })
            } else {
                const second = await runProbeTask(
                    'What is the codename I asked you to remember? Reply with just the codename.',
                    { cwd: p3cwd, resume: handle, mode: probePreset },
                )
                const recalled = second.result?.final_text.includes(token) ?? false
                probes.push({
                    name: 'P3-resume',
                    verdict: recalled ? 'pass' : 'fail',
                    detail: `preset=${probePreset} session=${handle} recalled=${recalled} state=${second.state?.state ?? 'none'}`,
                })
            }
        } catch (err) {
            probes.push({ name: 'P3-resume', verdict: 'fail', detail: err instanceof Error ? err.message : String(err) })
        } finally {
            await fs.rm(p3cwd, { recursive: true, force: true }).catch(() => {})
        }
    }

    // refresh verified_at on pass (version drift policy in AGENTS.md)
    const today = localToday()
    if (probes.some((p) => p.verdict === 'pass')) {
        try {
            await refreshManifestVerifiedAt(ctx.registry.dir, manifest.name, probes, today, version)
        } catch (err) {
            process.stderr.write(`probe: manifest verified_at refresh failed: ${err instanceof Error ? err.message : String(err)}\n`)
        }
    }
    emitOk({ endpoint: manifest.name, bin: plan.endpoint_bin, resolved_from: plan.resolved_from, version, probes })
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

async function refreshManifestVerifiedAt(
    dir: string,
    name: string,
    probes: Array<{ name: string; verdict: string }>,
    today: string,
    version: string | null,
): Promise<void> {
    const file = nodePath.join(dir, `${name}.json`)
    const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>
    const permission = parsed.permission as Record<string, Record<string, unknown>> | undefined
    const passed = new Set(probes.filter((p) => p.verdict === 'pass').map((p) => p.name))
    if (passed.has('P1-write') && permission) {
        for (const cap of ['fs.read', 'fs.write']) {
            if (permission[cap] && typeof permission[cap] === 'object') {
                permission[cap].verified_at = today
                if (version) permission[cap].version = version
            }
        }
    }
    if (passed.has('P3-resume') && parsed.resume && typeof parsed.resume === 'object') {
        const resume = parsed.resume as Record<string, unknown>
        resume.verified_at = today
        if (version) resume.version = version
    }
    await writeJsonAtomic(file, parsed)
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

/** Detection + model discovery for every manifest; live discovery writes the models cache through. */
async function gatherEndpointInfo(ctx: Ctx): Promise<InitEndpointInfo[]> {
    const cache = new ModelsCache(ctx.dataDir)
    const out: InitEndpointInfo[] = []
    for (const manifest of ctx.registry.list()) {
        const spawnRes = await planEndpointSpawn(manifest, {
            configBin: ctx.config.endpoints.overrides[manifest.name]?.bin ?? null,
        })
        const detected = spawnRes.plan !== null
        const version = spawnRes.plan ? await detectVersion(manifest, spawnRes.plan) : null
        let models: InitEndpointInfo['models'] = []
        if (manifest.models?.parse) {
            try {
                const mod = await loadParserModule(manifest.parser)
                if (mod.discoverModels) {
                    const found = await mod.discoverModels()
                    models = found.models
                    await cache.write({
                        schema_version: '1.0.0',
                        endpoint: manifest.name,
                        fetched_at: new Date().toISOString(),
                        version,
                        source: manifest.models.parse,
                        models: found.models,
                        notes: found.notes,
                    })
                }
            } catch {
                // discovery is best-effort during init; notes stay with the cache
            }
        }
        out.push({ name: manifest.name, detected, version, models })
    }
    return out
}

async function verbInit(ctx: Ctx, args: string[]): Promise<number> {
    const { values } = parseArgs({
        args,
        strict: true,
        options: { yes: { type: 'boolean', default: false } },
    })
    const info = await gatherEndpointInfo(ctx)
    const hostInfo = await gatherHostInfo()

    if (!process.stdin.isTTY && !values.yes) {
        // non-TTY callers (pipes, agents) get state + guidance, never a hanging prompt
        process.stdout.write(JSON.stringify({
            ok: false,
            error: { code: 'INIT_INTERACTIVE_REQUIRED', message: 'init is interactive on a TTY; use --yes for defaults or edit config.json directly' },
            state: {
                config_path: ctx.configPath,
                config_exists: existsSync(ctx.configPath),
                endpoints: info,
                hosts: hostInfo.hosts.map((h) => ({ name: h.name, detected: h.detected, skills_dir: h.skills_dir })),
                non_interactive: 'paidan init --yes enables all detected endpoints, picks the first discovered model as default, and installs the paidan skill into every detected host',
            },
        }) + '\n')
        return 1
    }

    let answers: InitAnswers
    if (values.yes) {
        answers = defaultInitAnswers(info, hostInfo.hosts.filter((h) => h.detected).map((h) => h.name))
    } else {
        answers = await promptInitAnswers(info, hostInfo.hosts)
    }
    const cfg = buildInitConfig(info, answers)
    const selectedHosts = selectSkillHosts(hostInfo.hosts, answers.skill_hosts)

    if (existsSync(ctx.configPath)) {
        // one cheap insurance copy before overwrite
        await fs.copyFile(ctx.configPath, `${ctx.configPath}.bak-${Date.now()}`).catch(() => {})
    }
    await writeJsonAtomic(ctx.configPath, initConfigToJson(cfg))

    let skills: SkillInstallResult[] = []
    if (selectedHosts.length > 0 && hostInfo.source) {
        for (const host of selectedHosts) {
            skills.push(await installSkill(host, hostInfo.source))
        }
    }
    emitOk({
        config_path: ctx.configPath,
        written: true,
        enabled: answers.enabled,
        defaults: cfg.defaults,
        endpoints: info.map((e) => ({ name: e.name, detected: e.detected, version: e.version, models: e.models.length })),
        skills,
    })
    return 0
}

async function promptInitAnswers(info: InitEndpointInfo[], hosts: HostInfo[]): Promise<InitAnswers> {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
    try {
        process.stderr.write('paidan init — endpoint detection complete. Human output is on stderr; stdout stays JSON.\n')
        const enabled: string[] = []
        for (const ep of info) {
            const label = ep.detected ? `detected ${ep.version ?? 'unknown version'}` : 'NOT detected'
            const answer = await rl.question(`Enable ${ep.name} (${label})? [y/N] `)
            if (answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes') {
                enabled.push(ep.name)
            }
        }
        let defaultEndpoint: string | null = null
        let defaultModel: string | null = null
        if (enabled.length > 0) {
            defaultEndpoint = await pickOne(rl, 'Default endpoint', enabled, enabled[0] as string)
            const models = info.find((e) => e.name === defaultEndpoint)?.models ?? []
            if (models.length > 0) {
                const aliases = models.map((m) => m.alias)
                defaultModel = await pickOne(rl, `Default model for ${defaultEndpoint}`, aliases, aliases[0] as string)
            } else {
                process.stderr.write(`(no discovered models for ${defaultEndpoint}; native default will be used)\n`)
            }
        }
        const skillHosts: string[] = []
        const detectedHosts = hosts.filter((h) => h.detected)
        if (detectedHosts.length > 0) {
            process.stderr.write('Host skill install — the paidan skill file is copied into each host you select.\n')
            for (const host of detectedHosts) {
                const answer = await rl.question(`Install paidan skill into ${host.name} (${host.skills_dir})? [y/N] `)
                if (answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes') {
                    skillHosts.push(host.name)
                }
            }
        }
        return { enabled, default_endpoint: defaultEndpoint, default_model: defaultModel, skill_hosts: skillHosts }
    } finally {
        rl.close()
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

async function main(): Promise<number> {
    const [verb, ...rest] = process.argv.slice(2)
    if (!verb || verb === 'help' || verb === '--help' || verb === '-h') {
        process.stderr.write(
            'paidan verbs: init [--yes] | run | get <run_id> [--wait] [--timeout s] | cancel <run_id> | list | models [--refresh] | doctor | probe\n',
        )
        return verb ? 0 : 1
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
