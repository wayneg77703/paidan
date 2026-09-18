// Read-only endpoint inspection, shared by commands without depending on their workflows.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { loadParserModule } from './adapters.js'
import type { EndpointManifest } from './registry.js'
import type { CachedModels, ModelsCache } from '../engine/models-cache.js'
import { filterSafeAliases } from './invocation.js'
import type { NativeDefaults } from './parser-api.js'
import { finalSpawnArgs, needsVerbatimArgs, type SpawnPlan } from './spawn.js'
const execFileAsync = promisify(execFile)

export async function detectVersion(manifest: EndpointManifest, plan: SpawnPlan, onError?: (reason: string) => void): Promise<string | null> {
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
        if (!text) { onError?.('版本检测命令未返回内容'); return null }
        const re = manifest.detect.version_re ? new RegExp(manifest.detect.version_re) : null
        const m = re ? re.exec(text) : null
        return m?.[1] ?? text.split(/\r?\n/)[0] ?? null
    } catch (error) {
        const failure = error as { code?: string | number; killed?: boolean }
        onError?.(failure.killed ? '版本检测超时（5 秒）' : `版本检测命令失败（${failure.code ?? '未知原因'}）`)
        return null
    }
}

/** Read-only native-defaults probe (the model/effort the endpoint's own home currently carries); null = no probed surface. */
export async function readEndpointNativeDefaults(manifest: EndpointManifest, configBin: string | null = null, providerConfig?: string | null, cwd?: string): Promise<NativeDefaults | null> {
    try {
        const mod = await loadParserModule(manifest.parser)
        if (!mod.readNativeDefaults) return null
        return await mod.readNativeDefaults({ configBin, providerConfig, cwd })
    } catch {
        return null
    }
}

/**
 * Live model discovery + argv-safety filter + cache write-through — the one
 * code path for `models` and init-time detection. configBin keeps
 * discovery on the same binary dispatch uses (override-aware, codex P1-11);
 * a discovery failure propagates so callers keep the last good cache instead
 * of an overwrite with an empty list. persist:false collects the entry in
 * memory only — init's survey phase uses it so an aborted wizard writes
 * nothing at all (codex P1-04); the caller persists after committing.
 * Returns null when the endpoint has no discovery surface.
 */
export async function discoverAndCacheModels(
    manifest: EndpointManifest,
    cache: ModelsCache,
    version: string | null,
    configBin: string | null = null,
    opts: { persist?: boolean; providerConfig?: string | null; cwd?: string } = {},
): Promise<CachedModels | null> {
    if (!manifest.models?.parse) return null
    const mod = await loadParserModule(manifest.parser)
    if (!mod.discoverModels) return null
    const found = await mod.discoverModels({ configBin, providerConfig: opts.providerConfig, cwd: opts.cwd })
    const safe = filterSafeAliases(found.models)
    const notes = [...found.notes,
        'Candidates from this discovery source are not proof of authentication, quota, or model access; no cross-connection fallback.',
        manifest.name === 'zcode'
            ? 'ZCode 只走 print：专用组合保存在原生 JSON，paidan 仅保存 overrides.zcode.provider_config 路径；不支持 --model/--effort。'
            : 'selection = --model ?? config.json defaults.models[endpoint] ?? endpoint native default; omit model/effort overrides to follow native configuration',
    ]
    if (safe.dropped > 0) notes.push(`dropped ${safe.dropped} alias(es) failing the argv-safety charset`)
    const entry: CachedModels = {
        schema_version: '1.0.0',
        endpoint: manifest.name,
        fetched_at: new Date().toISOString(),
        version,
        source: manifest.models.parse,
        models: safe.models,
        ...(found.connections ? { connections: found.connections } : {}),
        ...(found.native_defaults ? { native_defaults: found.native_defaults } : {}),
        ...(found.selection_context ? { selection_context: found.selection_context } : {}),
        notes,
    }
    // success writes through, even with an empty model list (no borrowing)
    if (opts.persist !== false) await cache.write(entry)
    return entry
}
