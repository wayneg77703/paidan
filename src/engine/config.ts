// Machine config: <APPDATA>/paidan/config.json (JSON, not TOML, in v0).
// Missing file = built-in defaults. Unknown keys are a hard error naming the key,
// so typos never pass silently.

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

export interface PaidanConfig {
    dataDir: string | null
    endpoints: {
        enabled: string[] | null
        /** per-endpoint machine overrides; bin may be a native binary or a JS bundle path */
        overrides: Record<string, { bin: string | null }>
    }
    defaults: {
        endpoint: string | null
        model: string | null
        /** per-endpoint default models; wins over `model` for its endpoint */
        models: Record<string, string>
        /** global default effort (native default when null) */
        effort: string | null
        /** per-endpoint default efforts; wins over `effort` for its endpoint */
        efforts: Record<string, string>
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
const DEFAULTS_KEYS = new Set(['endpoint', 'model', 'models', 'effort', 'efforts', 'run_timeout_sec'])
/** defaults keys the init wizard owns and replaces wholesale on re-init. The global `effort` joined `model` as wizard-cleared (2026-09-11): both are global fallbacks that poison endpoints without that selection surface, and a surviving global effort silently overrides a "native" wizard choice (codex P1-02). The hand-set `run_timeout_sec` stays machine-local. */
export const WIZARD_DEFAULTS_KEYS: readonly string[] = ['endpoint', 'model', 'models', 'effort', 'efforts']
const OVERRIDE_KEYS = new Set(['bin'])
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
        defaults: { endpoint: null, model: null, models: {}, effort: null, efforts: {}, run_timeout_sec: null },
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
            }
        }
    }
    if (obj.defaults !== undefined) {
        if (!obj.defaults || typeof obj.defaults !== 'object' || Array.isArray(obj.defaults)) {
            throw new Error('config key "defaults" must be an object')
        }
        const df = obj.defaults as Record<string, unknown>
        assertKnownKeys(df, DEFAULTS_KEYS, 'defaults.')
        if (df.endpoint !== undefined) {
            if (typeof df.endpoint !== 'string' || df.endpoint.length === 0) {
                throw new Error('config key "defaults.endpoint" must be a non-empty string')
            }
            out.defaults.endpoint = df.endpoint
        }
        if (df.model !== undefined) {
            if (typeof df.model !== 'string' || df.model.length === 0) {
                throw new Error('config key "defaults.model" must be a non-empty string')
            }
            out.defaults.model = df.model
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
        if (df.effort !== undefined) {
            if (typeof df.effort !== 'string' || df.effort.length === 0) {
                throw new Error('config key "defaults.effort" must be a non-empty string')
            }
            out.defaults.effort = df.effort
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
        if (df.run_timeout_sec !== undefined) {
            if (typeof df.run_timeout_sec !== 'number' || !Number.isFinite(df.run_timeout_sec) || df.run_timeout_sec < 0) {
                throw new Error('config key "defaults.run_timeout_sec" must be a non-negative number (0 disables)')
            }
            out.defaults.run_timeout_sec = df.run_timeout_sec
        }
    }
    return out
}
