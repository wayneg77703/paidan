// Machine config: <APPDATA>/paidan/config.json (JSON, not TOML, in v0).
// Missing file = built-in defaults. Unknown keys are a hard error naming the key,
// so typos never pass silently.

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { PERMISSION_PRESETS, type PermissionPreset } from './types.js'

export interface PaidanConfig {
    dataDir: string | null
    endpoints: {
        enabled: string[] | null
        /** per-endpoint machine overrides; bin may be a native binary or a JS bundle path */
        overrides: Record<string, { bin: string | null; provider_config?: string }>
    }
    defaults: {
        endpoint: string | null
        /** per-endpoint default models (there is deliberately NO global fallback — it poisons endpoints with no headless model selection) */
        models: Record<string, string>
        /** per-endpoint default efforts (no global fallback either) */
        efforts: Record<string, string>
        /** Configuration context approved together with fixed defaults on opted-in endpoints. */
        selection_contexts: Record<string, string>
        /** Headless permission defaults are independent of native model/auth settings. */
        modes: Record<string, PermissionPreset>
        run_timeout_sec: number | null
    }
    ttlDays: number
}

export const DEFAULT_TTL_DAYS = 30

/** Engine wall-clock cap per run when neither the flag nor config overrides it. */
export const DEFAULT_RUN_TIMEOUT_SEC = 1800

/** Effective run timeout: CLI flag ?? config defaults.run_timeout_sec ?? 1800; 0 disables. */
export function effectiveRunTimeoutSec(flag: number | null, config: PaidanConfig): number {
    return flag ?? config.defaults.run_timeout_sec ?? DEFAULT_RUN_TIMEOUT_SEC
}

const TOP_LEVEL_KEYS = new Set(['dataDir', 'endpoints', 'defaults', 'ttlDays'])
const ENDPOINTS_KEYS = new Set(['enabled', 'overrides'])
const DEFAULTS_KEYS = new Set(['endpoint', 'models', 'efforts', 'selection_contexts', 'modes', 'run_timeout_sec'])
const OVERRIDE_KEYS = new Set(['bin', 'provider_config'])
// dynamic keys land in plain objects; these three would hit the prototype
// machinery instead of becoming entries (pollution or silent drops)
const FORBIDDEN_DYNAMIC_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

function assertSafeDynamicKey(name: string, where: string): void {
    if (FORBIDDEN_DYNAMIC_KEYS.has(name)) {
        throw new Error(`config key "${where}${name}" is not allowed (reserved prototype name)`)
    }
}

/** Root for machine config and (by default) the data plane. PAIDAN_HOME overrides (tests, portability). */
export function configHome(env: NodeJS.ProcessEnv = process.env): string {
    if (env.PAIDAN_HOME) return env.PAIDAN_HOME
    if (process.platform === 'win32') {
        const appData = env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming')
        return path.join(appData, 'paidan')
    }
    const xdg = env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config')
    return path.join(xdg, 'paidan')
}

export function defaultConfigPath(env: NodeJS.ProcessEnv = process.env): string {
    return path.join(configHome(env), 'config.json')
}

export function resolveDataDir(config: PaidanConfig, env: NodeJS.ProcessEnv = process.env): string {
    if (env.PAIDAN_DATA_DIR) return env.PAIDAN_DATA_DIR
    return config.dataDir ?? configHome(env)
}

function defaults(): PaidanConfig {
    return {
        dataDir: null,
        endpoints: { enabled: null, overrides: {} },
        defaults: { endpoint: null, models: {}, efforts: {}, selection_contexts: {}, modes: {}, run_timeout_sec: null },
        ttlDays: DEFAULT_TTL_DAYS,
    }
}

function assertKnownKeys(obj: Record<string, unknown>, allowed: Set<string>, where: string): void {
    for (const key of Object.keys(obj)) {
        if (!allowed.has(key)) {
            throw new Error(`unknown config key "${where}${key}" in config.json`)
        }
    }
}

export function loadConfig(configPath: string = defaultConfigPath()): PaidanConfig {
    let raw: string
    try {
        raw = fs.readFileSync(configPath, 'utf8')
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return defaults()
        throw err
    }
    let parsed: unknown
    try {
        parsed = JSON.parse(raw)
    } catch {
        throw new Error(`config.json is not valid JSON: ${configPath}`)
    }
    return parseConfig(parsed, configPath)
}

/** Validate an in-memory setup merge with exactly the runtime config schema. */
export function parseConfig(parsed: unknown, configPath = 'config.json'): PaidanConfig {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`config.json must be a JSON object: ${configPath}`)
    }
    const obj = parsed as Record<string, unknown>
    assertKnownKeys(obj, TOP_LEVEL_KEYS, '')

    const out = defaults()
    if (obj.dataDir !== undefined) {
        if (typeof obj.dataDir !== 'string' || obj.dataDir.length === 0) {
            throw new Error('config key "dataDir" must be a non-empty string')
        }
        out.dataDir = obj.dataDir
    }
    if (obj.ttlDays !== undefined) {
        if (typeof obj.ttlDays !== 'number' || !Number.isFinite(obj.ttlDays) || obj.ttlDays <= 0) {
            throw new Error('config key "ttlDays" must be a positive number')
        }
        out.ttlDays = obj.ttlDays
    }
    if (obj.endpoints !== undefined) {
        if (!obj.endpoints || typeof obj.endpoints !== 'object' || Array.isArray(obj.endpoints)) {
            throw new Error('config key "endpoints" must be an object')
        }
        const ep = obj.endpoints as Record<string, unknown>
        assertKnownKeys(ep, ENDPOINTS_KEYS, 'endpoints.')
        if (ep.enabled !== undefined) {
            if (!Array.isArray(ep.enabled) || !ep.enabled.every((v) => typeof v === 'string')) {
                throw new Error('config key "endpoints.enabled" must be an array of strings')
            }
            out.endpoints.enabled = ep.enabled as string[]
        }
        if (ep.overrides !== undefined) {
            if (!ep.overrides || typeof ep.overrides !== 'object' || Array.isArray(ep.overrides)) {
                throw new Error('config key "endpoints.overrides" must be an object keyed by endpoint name')
            }
            for (const [name, ov] of Object.entries(ep.overrides as Record<string, unknown>)) {
                assertSafeDynamicKey(name, 'endpoints.overrides.')
                if (!ov || typeof ov !== 'object' || Array.isArray(ov)) {
                    throw new Error(`config key "endpoints.overrides.${name}" must be an object`)
                }
                const entry = ov as Record<string, unknown>
                assertKnownKeys(entry, OVERRIDE_KEYS, `endpoints.overrides.${name}.`)
                if (entry.bin !== undefined) {
                    if (typeof entry.bin !== 'string' || entry.bin.length === 0) {
                        throw new Error(`config key "endpoints.overrides.${name}.bin" must be a non-empty string`)
                    }
                    out.endpoints.overrides[name] = { bin: entry.bin }
                }
                if (entry.provider_config !== undefined) {
                    if (name !== 'zcode' || typeof entry.provider_config !== 'string' || !path.isAbsolute(entry.provider_config)) {
                        throw new Error('endpoints.overrides.zcode.provider_config must be an absolute native JSON path; other endpoints do not support this setting')
                    }
                    out.endpoints.overrides[name] = { bin: out.endpoints.overrides[name]?.bin ?? null, provider_config: entry.provider_config }
                }
            }
        }
    }
    if (obj.defaults !== undefined) {
        if (!obj.defaults || typeof obj.defaults !== 'object' || Array.isArray(obj.defaults)) {
            throw new Error('config key "defaults" must be an object')
        }
        const df = obj.defaults as Record<string, unknown>
        // removed-with-a-name keys get a migration strip + warning, NOT the
        // unknown-key hard error: a config written by an older build (or copied
        // from an old doc) must keep every verb usable — one re-run of
        // `paidan init` strips them from the file for good
        for (const removed of ['model', 'effort']) {
            if (removed in df) {
                delete df[removed]
                process.stderr.write(`config: defaults.${removed} was removed from the schema and is ignored (global fallbacks poisoned endpoints without that selection surface); remove this obsolete key when editing config.json
`)
            }
        }
        assertKnownKeys(df, DEFAULTS_KEYS, 'defaults.')
        if (df.endpoint !== undefined) {
            if (typeof df.endpoint !== 'string' || df.endpoint.length === 0) {
                throw new Error('config key "defaults.endpoint" must be a non-empty string')
            }
            out.defaults.endpoint = df.endpoint
        }
        if (df.models !== undefined) {
            if (!df.models || typeof df.models !== 'object' || Array.isArray(df.models)) {
                throw new Error('config key "defaults.models" must be an object keyed by endpoint name')
            }
            for (const [name, m] of Object.entries(df.models as Record<string, unknown>)) {
                assertSafeDynamicKey(name, 'defaults.models.')
                if (typeof m !== 'string' || m.length === 0) {
                    throw new Error(`config key "defaults.models.${name}" must be a non-empty string`)
                }
                out.defaults.models[name] = m
            }
        }
        if (df.efforts !== undefined) {
            if (!df.efforts || typeof df.efforts !== 'object' || Array.isArray(df.efforts)) {
                throw new Error('config key "defaults.efforts" must be an object keyed by endpoint name')
            }
            for (const [name, e] of Object.entries(df.efforts as Record<string, unknown>)) {
                assertSafeDynamicKey(name, 'defaults.efforts.')
                if (typeof e !== 'string' || e.length === 0) {
                    throw new Error(`config key "defaults.efforts.${name}" must be a non-empty string`)
                }
                out.defaults.efforts[name] = e
            }
        }
        if (df.selection_contexts !== undefined) {
            if (!df.selection_contexts || typeof df.selection_contexts !== 'object' || Array.isArray(df.selection_contexts)) {
                throw new Error('defaults.selection_contexts must be an object')
            }
            for (const [name, context] of Object.entries(df.selection_contexts as Record<string, unknown>)) {
                assertSafeDynamicKey(name, 'defaults.selection_contexts.')
                if (typeof context !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(context)) {
                    throw new Error('defaults.selection_contexts requires a sha256 context from paidan models')
                }
                out.defaults.selection_contexts[name] = context
            }
        }
        if (df.modes !== undefined) {
            if (!df.modes || typeof df.modes !== 'object' || Array.isArray(df.modes)) {
                throw new Error('config key "defaults.modes" must be an object keyed by endpoint name')
            }
            for (const [name, mode] of Object.entries(df.modes as Record<string, unknown>)) {
                assertSafeDynamicKey(name, 'defaults.modes.')
                if (!(PERMISSION_PRESETS as readonly unknown[]).includes(mode)) {
                    throw new Error(`config key "defaults.modes.${name}" must be read-only, workspace-write or unattended`)
                }
                out.defaults.modes[name] = mode as PermissionPreset
            }
        }
        if (df.run_timeout_sec !== undefined) {
            if (typeof df.run_timeout_sec !== 'number' || !Number.isFinite(df.run_timeout_sec) || df.run_timeout_sec < 0) {
                throw new Error('config key "defaults.run_timeout_sec" must be a non-negative number (0 disables)')
            }
            out.defaults.run_timeout_sec = df.run_timeout_sec
        }
    }
    return out
}
