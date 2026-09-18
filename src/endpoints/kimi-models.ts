// Kimi connection/model discovery and native configuration metadata; never return credentials.
import * as fs from 'node:fs/promises'
import * as nodePath from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { DiscoverModelsResult, NativeDefaults } from './parser-api.js'
import { EndpointRegistry } from './registry.js'
import { buildEnv } from './invocation.js'
import { planEndpointSpawn, finalSpawnArgs, needsVerbatimArgs } from './spawn.js'
import { kimiNativeHome } from './kimi-ledger.js'
import { PaidanError } from '../engine/errors.js'

const API_KEY_ENV: Record<string, string> = {
    kimi: 'KIMI_API_KEY', openai: 'OPENAI_API_KEY', openai_responses: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY',
}

/** Whitelist the native JSON surface: it contains credentials, never return raw rows/errors. */
export function parseKimiModelsJson(text: string): DiscoverModelsResult {
    let o: Record<string, any>
    try { o = JSON.parse(text) } catch { throw new Error('kimi provider list returned invalid JSON; raw output withheld') }
    const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)
    const strings = (v: unknown): string[] | null => Array.isArray(v) && v.every(e => typeof e === 'string') ? v : null
    if (!object(o) || !object(o.models) || !object(o.providers)) {
        throw new Error('kimi provider list returned an unknown schema; raw output withheld')
    }
    return {
        connections: Object.entries(o.providers).filter(([, v]) => object(v)).map(([id, p]) => {
            const envKey = API_KEY_ENV[p.type]
            const key = typeof p.apiKey === 'string' && p.apiKey.length > 0 ? p.apiKey : p.env?.[envKey ?? '']
            return { id, source: 'native-config', protocol: typeof p.type === 'string' ? p.type : undefined,
                auth_type: object(p.oauth) ? 'oauth' : typeof key === 'string' && key.length > 0 ? 'api-key' : 'unknown' }
        }),
        models: Object.entries(o.models).filter(([, v]) => object(v)).map(([alias, m]) => {
            const capabilities = strings(m.overrides?.capabilities ?? m.capabilities) ?? []
            const defaultEffort = typeof m.overrides?.defaultEffort === 'string' ? m.overrides.defaultEffort : m.defaultEffort
            return {
                alias, connection: typeof m.provider === 'string' ? m.provider : null,
                source: 'native-config',
                resolved_model: typeof m.model === 'string' ? m.model : null,
                effort_options: strings(m.overrides?.supportEfforts ?? m.supportEfforts),
                default_effort: typeof defaultEffort === 'string' ? defaultEffort : null,
                effort_selectable: o.providers[m.provider]?.type === 'kimi' && capabilities.some(c => c === 'thinking' || c === 'always_thinking'),
                thinking_required: capabilities.includes('always_thinking'),
            }
        }),
        notes: ['Native configured providers/models; provider IDs come from model.provider, not alias prefixes. Auth type is configuration evidence only. Model overrides supersede declared metadata. The paidan effort override is verified only for the kimi protocol; other protocols must follow native effort. Catalog entries do not prove login or quota.'],
    }
}

export async function discoverModels(opts?: { configBin?: string | null }): Promise<DiscoverModelsResult & { native_defaults: NativeDefaults }> {
    const manifest = (await EndpointRegistry.load()).get('kimi-code')
    const { plan } = await planEndpointSpawn(manifest, { configBin: opts?.configBin ?? null })
    if (!plan) throw new Error('kimi binary not resolvable for provider discovery')
    let stdout: string
    try {
        ({ stdout } = await promisify(execFile)(plan.command, finalSpawnArgs(plan, ['provider', 'list', '--json']), {
            env: buildEnv(manifest), timeout: 15_000, maxBuffer: 8 * 1024 * 1024,
            windowsHide: true, windowsVerbatimArguments: needsVerbatimArgs(plan),
        }))
    } catch { throw new Error('kimi provider list --json failed; check this CLI version/native setup. Raw output withheld because it can contain credentials.') }
    const result = parseKimiModelsJson(stdout)
    const native = await readNativeDefaults()
    const selected = result.models.find(m => m.alias === native.model)
    if (selected) {
        native.connection = selected.connection
        native.auth_type = result.connections?.find(c => c.id === selected.connection)?.auth_type ?? 'unknown'
    }
    return { ...result, native_defaults: native }
}

/** Small read-only scalar snapshot; native provider list owns model metadata and overrides. */
export function readKimiNativeDefaults(configToml: string | null, env: NodeJS.ProcessEnv = {}): NativeDefaults {
    const sections = new Map<string, Map<string, string | boolean>>()
    let section = '', multiline: string | null = null
    const decode = (raw: string): string | null => {
        try { return raw.startsWith("'") ? raw.slice(1, -1) : JSON.parse(raw) as string }
        catch { return null }
    }
    for (const line of (configToml ?? '').split(/\r?\n/)) {
        if (multiline) { if (line.includes(multiline)) multiline = null; continue }
        const header = /^\s*\[(.+)\]\s*(?:#.*)?$/.exec(line)
        if (header) {
            section = header[1].trim()
            const named = /^(models|providers)\.("(?:[^"\\]|\\.)*"|'[^']*'|[\w-]+)$/.exec(section)
            if (named) section = named[1] + ':' + (/^["']/.test(named[2]) ? decode(named[2]) : named[2])
            continue
        }
        const assignment = /^\s*(\w+)\s*=\s*(.*)$/.exec(line)
        if (!assignment) continue
        const raw = assignment[2]
        if (raw.startsWith('"""') || raw.startsWith("'".repeat(3))) {
            if (!raw.slice(3).includes(raw.slice(0, 3))) multiline = raw.slice(0, 3)
            continue
        }
        if (!['default_model', 'effort', 'enabled', 'provider', 'type'].includes(assignment[1])) continue
        const scalar = /^("(?:[^"\\]|\\.)*"|'[^']*'|true|false)\s*(?:#.*)?$/.exec(raw)?.[1]
        if (!scalar) continue
        const value = scalar === 'true' ? true : scalar === 'false' ? false : decode(scalar)
        if (value === null) continue
        const fields = sections.get(section) ?? new Map<string, string | boolean>()
        fields.set(assignment[1], value)
        sections.set(section, fields)
    }
    const string = (group: string, key: string): string | null => {
        const value = sections.get(group)?.get(key)
        return typeof value === 'string' ? value : null
    }
    const fromEnv = !!env.KIMI_MODEL_NAME?.trim()
    const model = fromEnv ? '__kimi_env_model__' : string('', 'default_model')
    const connection = fromEnv ? '__kimi_env__' : string('models:' + model, 'provider')
    const protocol = fromEnv ? env.KIMI_MODEL_PROVIDER_TYPE?.trim() || 'kimi' : string('providers:' + connection, 'type')
    const forced = env.KIMI_MODEL_THINKING_EFFORT?.trim()
    const enabled = sections.get('thinking')?.get('enabled')
    const notes = ['原生配置快照，不是实际请求证明；有效强度还受模型能力、overrides 和 thinking 开关影响。']
    if (configToml === null) notes.push('native kimi config.toml not found')
    if (fromEnv) notes.push('KIMI_MODEL_NAME 启用了临时环境模型；-m 完整别名优先于它。凭据仍由 Kimi 原生读取。')
    if (forced && protocol !== 'kimi') notes.push('当前协议未验证 KIMI_MODEL_THINKING_EFFORT 覆盖，不能把环境强度当成生效值。')
    return { model, connection, effort: forced && protocol === 'kimi' ? forced : string('thinking', 'effort'),
        thinking_enabled: typeof enabled === 'boolean' ? enabled : null, credential_ready: null, notes }
}

export async function readNativeDefaults(): Promise<NativeDefaults> {
    const toml = await fs.readFile(nodePath.join(kimiNativeHome(), 'config.toml'), 'utf8').catch(() => null)
    return readKimiNativeDefaults(toml, process.env)
}

export async function validateSelection(selection: { model: string | null; effort: string | null }, opts: { configBin: string | null }): Promise<NativeDefaults> {
    let current: Awaited<ReturnType<typeof discoverModels>>
    try { current = await discoverModels(opts) }
    catch { throw new PaidanError('MODELS_QUERY_FAILED', 'Kimi 当前连接/模型查询失败，尚未派发。请检查该 CLI 的原生配置；原始输出可能含凭据，已隐藏。') }
    const native = current.native_defaults
    const alias = selection.model ?? native.model
    const model = current.models.find(m => m.alias === alias)
    const details = { requested: selection, native_defaults: native, query: 'paidan models --endpoint kimi-code', user_choice_required: true }
    if (!model) throw new PaidanError('MODEL_UNAVAILABLE', 'Kimi 所选别名已不存在或无法确定。请展示当前连接与模型，让用户重新选择；不会自动换路。', details)
    if (selection.effort === null) return native
    if (!model.effort_selectable || native.thinking_enabled === false && !model.thinking_required) {
        throw new PaidanError('EFFORT_UNSUPPORTED', '此 Kimi 连接/模型或 thinking 关闭状态不能保证 paidan 的强度覆盖生效。请让用户选择跟随原生强度、调整原生设置或另选组合。', details)
    }
    if (model.effort_options && !model.effort_options.includes(selection.effort)) {
        throw new PaidanError('EFFORT_INVALID', `所选 Kimi 模型声明的强度为 ${model.effort_options.join(', ') || '无'}；请让用户重新选择。`, details)
    }
    return native
}
