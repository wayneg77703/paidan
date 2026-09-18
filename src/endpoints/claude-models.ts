// Claude native defaults and model selectors. Metadata only; no credentials leave this module.
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import { createHash } from 'node:crypto'
import type { DiscoverModelsResult, NativeDefaults } from './parser-api.js'
import { PaidanError } from '../engine/errors.js'

type Settings = Record<string, unknown>

function record(value: unknown): Settings {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Settings : {}
}

function parseSettings(raw: string | null): Settings | null {
    try {
        const value: unknown = JSON.parse(raw ?? '{}')
        return value && typeof value === 'object' && !Array.isArray(value) ? value as Settings : null
    } catch { return null }
}

function environmentValue(settings: Settings, env: NodeJS.ProcessEnv, key: string, conflict?: (key: string) => void): string | null {
    const a = env[key], b = typeof settings[key] === 'string' ? settings[key] : null
    if (a && b && a !== b) { conflict?.(key); return null }
    return a || b || null
}

/** Known native effort syntax by explicit model ID, not by an alias's marketing name. */
function modelEfforts(model: string | null): string[] | null {
    const id = model?.replace(/\[(?:1m|200k)\]$/i, '')
    if (/^claude-(?:fable-5(?:-1)?|opus-(?:5|4-[78])|sonnet-5)(?:-\d{8})?$/i.test(id ?? '')) return ['low', 'medium', 'high', 'xhigh', 'max']
    if (/^claude-(?:opus|sonnet)-4-6(?:-\d{8})?$/i.test(id ?? '')) return ['low', 'medium', 'high', 'max']
    if (/^claude-(?:haiku-4-5|(?:opus|sonnet)-4-[015])(?:-\d{8})?$/i.test(id ?? '')) return []
    return null // custom gateway/deployment capabilities are not inferred from an alias
}

// ---- Convention exports (parser-api.ts): adapters.ts loads these by name ----
/**
 * Static docs-sourced alias list: claude has NO model-enumeration command
 * (2.1.260: `claude model list` / `claude models` are not subcommands — they
 * fall through to a chat prompt). Aliases come from the official model-config
 * page (checked 2026-09-11) and track the latest model per tier; pin a full
 * name (e.g. claude-opus-5) by hand in config.json if you need a fixed version.
 * Gateway availability varies; a picked-but-unavailable alias fails at the endpoint.
 */
export function discoverClaudeModels(settingsJson: string | null, env: NodeJS.ProcessEnv = {}): DiscoverModelsResult {
    return configuredModels(parseSettings(settingsJson), settingsJson === null, env)
}

function configuredModels(settings: Settings | null, missing: boolean, env: NodeJS.ProcessEnv): DiscoverModelsResult {
    const native = nativeDefaults(settings, missing, env)
    const configuredEnv = record(settings?.env)
    const models: DiscoverModelsResult['models'] = ['sonnet', 'opus', 'haiku', 'fable'].map((alias) => {
        const key = `ANTHROPIC_DEFAULT_${alias.toUpperCase()}_MODEL`
        const resolved = environmentValue(configuredEnv, env, key)
        return { alias, connection: native.connection ?? null, source: 'static-alias', resolved_model: resolved,
            effort_options: modelEfforts(resolved) }
    })
    const custom = environmentValue(configuredEnv, env, 'ANTHROPIC_CUSTOM_MODEL_OPTION')
    for (const model of [native.model, custom, ...models.map(m => m.resolved_model)].filter((v): v is string => !!v)) {
        if (!models.some(m => m.alias === model)) models.push({ alias: model, connection: native.connection ?? null,
            source: 'native-config', resolved_model: model, effort_options: modelEfforts(model) })
    }
    return {
        models,
        native_defaults: native,
        notes: [
            'Claude has no enumeration command. Static aliases are selectors, not an account-accessible catalog; native ANTHROPIC_DEFAULT_*_MODEL mappings may make different aliases resolve to the same model.',
            'Pin a full model ID for a specific model; pinning opus/sonnet/etc still follows native alias mappings. Known effort lists describe CLI/model support, not gateway access or managed policy. Project settings, modelOverrides, modelPicker and availableModels require native inspection; this snapshot does not resolve those policies.',
            ...(native.notes ?? []),
        ],
    }
}

/** Partial home/environment snapshot, with unresolved precedence conflicts reported explicitly. */
export function readClaudeNativeDefaults(settingsJson: string | null, env: NodeJS.ProcessEnv = {}): NativeDefaults {
    return nativeDefaults(parseSettings(settingsJson), settingsJson === null, env)
}

function nativeDefaults(settings: Settings | null, missing: boolean, env: NodeJS.ProcessEnv): NativeDefaults {
    if (!settings) return { model: null, effort: null, notes: ['native claude settings.json is not valid JSON'] }
    const notes = ['Home settings/environment snapshot only; project, managed settings and resumed sessions may override it. Authentication and quota unverified.']
    if (missing) notes.push('native claude settings.json not found')
    const configured = record(settings.env)
    const conflicts = new Set<string>()
    const value = (key: string) => environmentValue(configured, env, key, key => {
        conflicts.add(key)
        notes.push(`Conflicting caller/settings environment for ${key}; effective selection unresolved (values withheld).`)
    })
    const modelEnv = value('ANTHROPIC_MODEL')
    const newSessionDefault = value('ANTHROPIC_DEFAULT_MODEL')
    const effortEnv = value('CLAUDE_CODE_EFFORT_LEVEL')
    const routes = [
        ['CLAUDE_CODE_USE_BEDROCK', 'bedrock'], ['CLAUDE_CODE_USE_VERTEX', 'vertex'], ['CLAUDE_CODE_USE_FOUNDRY', 'foundry'],
    ].filter(([key]) => ['1', 'true'].includes(value(key) ?? ''))
    const baseUrl = value('ANTHROPIC_BASE_URL')
    const connection = routes.length > 1 || conflicts.size > 0 ? null : routes[0]?.[1] ?? (baseUrl ? 'custom-base-url' : null)
    if (modelEnv) notes.push('ANTHROPIC_MODEL overrides settings.model in this snapshot.')
    return {
        model: conflicts.has('ANTHROPIC_MODEL') ? null : modelEnv ?? (typeof settings.model === 'string' ? settings.model : null) ?? newSessionDefault,
        effort: conflicts.has('CLAUDE_CODE_EFFORT_LEVEL') ? null : effortEnv ?? (typeof settings.effortLevel === 'string' ? settings.effortLevel : null),
        connection, credential_ready: null, notes,
    }
}

/** Bind to routing/selection metadata, never credentials or unrelated preferences. */
async function readSnapshot(configBin: string | null = null): Promise<{ settings: Settings; missing: boolean; context: string }> {
    const home = nodePath.resolve(process.env.CLAUDE_CONFIG_DIR || nodePath.join(os.homedir(), '.claude'))
    let raw: string | null
    try {
        raw = await fs.readFile(nodePath.join(home, 'settings.json'), 'utf8')
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new PaidanError('MODELS_QUERY_FAILED', 'Claude 原生 settings.json 无法读取；请检查该配置目录的文件权限。')
        raw = null
    }
    const settings = parseSettings(raw)
    if (!settings) throw new PaidanError('MODELS_QUERY_FAILED', 'Claude 原生 settings.json 格式无效；未使用其他配置代替。')
    const routeKeys = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_MODEL', 'CLAUDE_CODE_EFFORT_LEVEL',
        'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'ANTHROPIC_CUSTOM_MODEL_OPTION',
        ...['OPUS', 'SONNET', 'HAIKU', 'FABLE'].map(tier => `ANTHROPIC_DEFAULT_${tier}_MODEL`)]
    const authKeys = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']
    const envMetadata = (env: Record<string, unknown>) => [
        routeKeys.map(key => [key, typeof env[key] === 'string' ? env[key] : null]),
        authKeys.map(key => [key, typeof env[key] === 'string' && env[key] !== '']),
    ]
    const modelSettings = Object.entries(record(settings.modelSettings)).sort(([a], [b]) => a.localeCompare(b)).map(([id, v]) => [id, (v as { effortLevel?: unknown } | null)?.effortLevel ?? null])
    const overrides = Object.entries(record(settings.modelOverrides)).filter(([, v]) => typeof v === 'string').sort(([a], [b]) => a.localeCompare(b))
    const metadata = [home, configBin, envMetadata(process.env), envMetadata(record(settings.env)),
        settings.model ?? null, settings.effortLevel ?? null, modelSettings, overrides,
        settings.availableModels ?? null, settings.maxEffortLevel ?? null, settings.alwaysThinkingEnabled ?? null]
    return { settings, missing: raw === null, context: 'sha256:' + createHash('sha256').update(JSON.stringify(metadata)).digest('hex') }
}

export async function readNativeDefaults(opts?: { configBin?: string | null }): Promise<NativeDefaults> {
    const snapshot = await readSnapshot(opts?.configBin)
    return { ...nativeDefaults(snapshot.settings, snapshot.missing, process.env), selection_context: snapshot.context }
}

export async function discoverModels(opts?: { configBin?: string | null }): Promise<DiscoverModelsResult> {
    const snapshot = await readSnapshot(opts?.configBin)
    const found = configuredModels(snapshot.settings, snapshot.missing, process.env)
    return { ...found, selection_context: snapshot.context,
        native_defaults: { ...found.native_defaults, selection_context: snapshot.context },
        connections: found.native_defaults?.connection ? [{ id: found.native_defaults.connection, source: 'native-config', auth_type: 'unknown' }] : [],
    }
}

export async function validateSelection(selection: { model: string | null; effort: string | null }, opts: { configBin: string | null }): Promise<NativeDefaults> {
    const current = await discoverModels(opts)
    const native = current.native_defaults!
    const model = selection.model ?? native.model
    const options = current.models.find(m => m.alias === model)?.effort_options ?? modelEfforts(model ?? null)
    if (selection.effort !== null && options && !options.includes(selection.effort)) {
        throw new PaidanError('EFFORT_INVALID', `所选 Claude 模型声明的强度为 ${options.join(', ') || '不支持强度参数'}。请让用户选择，避免原生静默降低强度。`,
            { requested: selection, native_defaults: native, query: 'paidan models --endpoint claude-code', user_choice_required: true })
    }
    return native
}
