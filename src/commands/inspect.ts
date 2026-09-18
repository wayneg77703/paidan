// Inspection commands report metadata; they never dispatch tasks or repair native configuration.
import * as nodePath from 'node:path'
import * as os from 'node:os'
import { existsSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { PaidanError } from '../engine/errors.js'
import { ModelsCache } from '../engine/models-cache.js'
import { UsageDb } from '../engine/usage-db.js'
import { detectHosts, loadHostRegistry } from '../engine/skill-install.js'
import { checkPermission, supportsEffort, buildEnv, resolvePermissionMode } from '../endpoints/invocation.js'
import { prepareEndpointRuntime } from '../endpoints/adapters.js'
import { type EndpointManifest } from '../endpoints/registry.js'
import { checkNativePreflight } from '../endpoints/native-preflight.js'
import { cmdShimRefusalMessage, planEndpointSpawn } from '../endpoints/spawn.js'
import { detectVersion, readEndpointNativeDefaults, discoverAndCacheModels } from '../endpoints/inspection.js'
import { emitOk, pickEndpoint, pkgRoot, type Ctx } from './context.js'

export async function verbModels(ctx: Ctx, args: string[]): Promise<void> {
    const { values } = parseArgs({
        args,
        strict: true,
        options: {
            endpoint: { type: 'string' },
            refresh: { type: 'boolean', default: false },
            native: { type: 'boolean' },
            cwd: { type: 'string' },
        },
    })
    const manifest = pickEndpoint(ctx, values.endpoint)
    const cache = new ModelsCache(ctx.dataDir)
    // Connections may change outside paidan (native login/config or a switcher).
    // Query now rather than treating an endpoint-only cache as current access.
    // --refresh remains accepted for existing callers; every call is fresh.
    try {
        const configBin = ctx.config.endpoints.overrides[manifest.name]?.bin ?? null
        const spawnRes = await planEndpointSpawn(manifest, { configBin })
        const version = spawnRes.plan ? await detectVersion(manifest, spawnRes.plan) : null
        const entry = await discoverAndCacheModels(manifest, cache, version, configBin, { providerConfig: values.native ? null : ctx.config.endpoints.overrides[manifest.name]?.provider_config, cwd: values.cwd ? nodePath.resolve(values.cwd) : undefined })
        if (!entry) {
            throw new PaidanError('UNSUPPORTED', `endpoint "${manifest.name}" has no model discovery in v0`)
        }
        emitOk({
            endpoint: manifest.name,
            models: entry.models,
            connections: entry.connections ?? [],
            native_defaults: entry.native_defaults ?? await readEndpointNativeDefaults(manifest, configBin, values.native ? null : ctx.config.endpoints.overrides[manifest.name]?.provider_config),
            configured_defaults: { model: ctx.config.defaults.models[manifest.name] ?? null, effort: ctx.config.defaults.efforts[manifest.name] ?? null,
                ...(manifest.models?.bind_selection ? { selection_context: ctx.config.defaults.selection_contexts[manifest.name] ?? null } : {}) },
            ...(entry.selection_context ? { selection_context: entry.selection_context } : {}),
            source: entry.source,
            fetched_at: entry.fetched_at,
            version,
            from_cache: false,
            notes: entry.notes,
        })
    } catch (err) {
        // Keep the historical snapshot on disk, but never offer it as a
        // substitute for the current connection's failed discovery.
        if (err instanceof PaidanError) throw err
        throw new PaidanError('MODELS_QUERY_FAILED', err instanceof Error ? err.message : String(err))
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

export async function verbDoctor(ctx: Ctx, args: string[]): Promise<void> {
    const { values } = parseArgs({
        args, strict: true,
        options: { endpoint: { type: 'string', multiple: true } },
    })
    const enabled = ctx.config.endpoints.enabled
    const modelsCache = new ModelsCache(ctx.dataDir)
    const endpoints = []
    const issues: string[] = []
    const manifests = ctx.registry.list()
    const names = new Set(manifests.map((m) => m.name))
    const selected = values.endpoint ? new Set(values.endpoint) : null
    for (const name of selected ?? []) {
        if (!names.has(name)) throw new PaidanError('ENDPOINT_UNKNOWN', `unknown endpoint "${name}"`)
    }
    // Hand-written agent setup gets semantic feedback without running a task
    // or changing any configuration. Disabled endpoints may retain defaults.
    const configuredNames = new Set([
        ...(enabled ?? []), ...Object.keys(ctx.config.endpoints.overrides),
        ...Object.keys(ctx.config.defaults.models), ...Object.keys(ctx.config.defaults.efforts),
        ...Object.keys(ctx.config.defaults.modes),
        ...(ctx.config.defaults.endpoint ? [ctx.config.defaults.endpoint] : []),
    ])
    for (const name of configuredNames) {
        if (!names.has(name)) issues.push(`config: unknown endpoint "${name}"; check endpoints/defaults keys`)
    }
    const defaultEndpoint = ctx.config.defaults.endpoint
    if (defaultEndpoint && enabled !== null && !enabled.includes(defaultEndpoint)) {
        issues.push(`config: defaults.endpoint "${defaultEndpoint}" is not in endpoints.enabled`)
    }
    for (const manifest of manifests) {
        if (selected && !selected.has(manifest.name)) continue
        // list every manifest with an enabled flag — a disabled or not-yet-enabled
        // endpoint is information, not something to hide (codex P2-03)
        const isEnabled = enabled === null || enabled.includes(manifest.name)
        const configBin = ctx.config.endpoints.overrides[manifest.name]?.bin ?? null
        const spawnRes = await planEndpointSpawn(manifest, { configBin })
        const shimBlocked = spawnRes.plan?.resolved_from === 'cmd-shim' && manifest.command.prompt_delivery === 'argv'
        const model = ctx.config.defaults.models[manifest.name] ?? null
        const effort = ctx.config.defaults.efforts[manifest.name] ?? null
        const configuredMode = ctx.config.defaults.modes[manifest.name]
        const defaultMode = resolvePermissionMode(manifest, configuredMode)
        if (!checkPermission(manifest, defaultMode).ok) {
            issues.push(`${manifest.name}: default permission mode "${defaultMode}" is unsupported; choose a supported preset. No automatic escalation.`)
        }
        if (model !== null && !manifest.command.model_arg) {
            issues.push(`${manifest.name}: defaults.models is unsupported; remove this endpoint's model override and use its native configuration`)
        }
        if (effort !== null && !supportsEffort(manifest, effort)) {
            issues.push(`${manifest.name}: defaults.efforts value "${effort}" is unsupported; choose an effort_options value or omit the override`)
        }
        if (shimBlocked) issues.push(cmdShimRefusalMessage(manifest.name, spawnRes.plan!.endpoint_bin ?? manifest.detect.bin))
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
        const permission: Record<string, unknown> = {
            presets: manifest.permission.presets,
            default_mode: defaultMode,
            default_mode_source: configuredMode ? 'config' : manifest.permission.default_mode ? 'endpoint' : 'compatibility-default',
            headless_notes: manifest.permission.headless_notes ?? null,
        }
        for (const [key, value] of Object.entries(manifest.permission)) {
            if (key === 'presets' || key.endsWith('_notes')) continue
            if (value && typeof value === 'object' && 'status' in value) {
                permission[key] = (value as { status: unknown }).status
            }
        }
        const nativePreflight = manifest.native_preflight
            ? await checkNativePreflight(manifest.native_preflight)
            : null
        const providerConfig = ctx.config.endpoints.overrides[manifest.name]?.provider_config
        const nativeDefaults = await readEndpointNativeDefaults(manifest, configBin, providerConfig)
        if (manifest.models?.bind_selection && (model !== null || effort !== null)
            && (!nativeDefaults?.selection_context || nativeDefaults.selection_context !== ctx.config.defaults.selection_contexts[manifest.name])) {
            issues.push(`${manifest.name}: 固定选择尚未确认当前原生配置；请展示当前连接/模型并让用户重新选择。`)
        }
        let runtime = null
        try { runtime = spawnRes.plan ? await prepareEndpointRuntime(manifest, spawnRes.plan, buildEnv(manifest), undefined, providerConfig) : null }
        catch (error) { issues.push(`${manifest.name}: ${(error as Error).message}`) }
        if (runtime?.check && !runtime.check.ready) issues.push(`${manifest.name}: bundled provider runtime resource unresolved (see runtime_resources)`)
        if (nativeDefaults?.credential_ready === false) {
            issues.push(
                `${manifest.name}: native authentication precheck failed; use the endpoint's own login/setup, retry a minimal run, or skip it. paidan does not configure credentials.`,
            )
        }
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
            spawn_supported: spawnRes.plan !== null && !shimBlocked,
            repair_hint: !spawnRes.plan
                ? `set endpoints.overrides.${manifest.name}.bin in ${ctx.configPath} to the full path of the selected native executable or Node.js bundle file`
                : shimBlocked
                    ? cmdShimRefusalMessage(manifest.name, spawnRes.plan.endpoint_bin ?? manifest.detect.bin)
                    : versionError
                        ? 'The selected file could not report its version; check this exact entry before running a task, or choose another candidate.'
                        : null,
            models_cache: modelsCacheInfo,
            model_selectable: manifest.command.model_arg !== undefined,
            configured_defaults: { model, effort, mode: configuredMode ?? null,
                ...(manifest.models?.bind_selection ? { selection_context: ctx.config.defaults.selection_contexts[manifest.name] ?? null } : {}),
                ...(manifest.name === 'zcode' ? { provider_config: providerConfig ?? null } : {}) },
            effort_options: manifest.effort?.options ?? null,
            effort_accepts_custom: manifest.effort?.allow_custom ?? false,
            effort_options_scope: manifest.effort?.allow_custom ? 'examples; use selected model variants' : 'adapter syntax; not per-model compatibility',
            permission,
            native_preflight: nativePreflight,
            // read-only: what the endpoint's own home currently carries (the
            // "native default" reality — paidan never writes it)
            native_defaults: nativeDefaults,
            runtime_resources: runtime?.check ?? null,
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
    // Expose the exact packaged variant and target so an installation agent can
    // copy only user-selected skills without re-running the config wizard.
    let hosts: Array<{ name: string; detected: boolean; skills_dir: string; installed: boolean; source: string; target: string }> = []
    try {
        const registry = await loadHostRegistry(pkgRoot)
        const home = process.env.PAIDAN_HOST_HOME || os.homedir()
        hosts = (await detectHosts(registry, home)).map((h) => ({
            name: h.name, detected: h.detected, skills_dir: h.skills_dir, installed: h.installed,
            source: nodePath.join(pkgRoot, h.source ?? registry.skill.source), target: h.target,
        }))
    } catch {
        hosts = []
    }
    emitOk({
        config_path: ctx.configPath,
        config_exists: existsSync(ctx.configPath),
        data_dir: ctx.dataDir,
        runs_dir: ctx.store.runsDir,
        endpoints_dir: ctx.registry.dir,
        package_root: pkgRoot,
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
