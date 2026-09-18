// Native metadata only. Tasks continue to use exec; no server or model invocation.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { promisify } from 'node:util'
import type { DiscoverModelsResult, ModelEntry, NativeDefaults } from './parser-api.js'
import { EndpointRegistry } from './registry.js'
import { buildEnv } from './invocation.js'
import { finalSpawnArgs, needsVerbatimArgs, planEndpointSpawn } from './spawn.js'

const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex')
const safe = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/@+\[\]-]*$/.test(v)
const rootKeys = new Set(['model', 'model_provider', 'model_reasoning_effort', 'profile', 'model_catalog_json', 'openai_base_url', 'chatgpt_base_url', 'forced_login_method', 'model_providers', 'profiles'])

/** Limited scalar reader, never a general TOML parser. Unsupported selection syntax is unknown. */
export function codexConfigMetadata(raw: string | null): { values: Record<string, string>; routes: string[]; unresolved: boolean; providers: string[] } {
    const values: Record<string, string> = Object.create(null)
    const routes: string[] = [], providers: string[] = []
    let section = '', unresolved = false, multiline: string | null = null
    for (const line of (raw ?? '').split(/\r?\n/)) {
        if (multiline) { if (line.includes(multiline)) multiline = null; continue }
        const header = /^\s*\[(.+)\]\s*(?:#.*)?$/.exec(line)
        if (header) {
            section = header[1]!.trim()
            const provider = /^model_providers\.(?:"([^"]+)"|'([^']+)'|([\w-]+))$/.exec(section)
            const id = provider?.[1] ?? provider?.[2] ?? provider?.[3]
            if (id && safe(id)) providers.push(id)
            continue
        }
        const assignment = /^\s*([\w.-]+|"[^"]+")\s*=\s*(.*)$/.exec(line)
        if (!assignment) continue
        const key = assignment[1]!.replace(/^"|"$/g, '')
        const value = assignment[2]!
        const relevant = section === '' && rootKeys.has(key)
        // Hash routing fields only, excluding API keys, token values and HTTP headers.
        const routing = relevant || /^(model_providers|profiles)(\.|$)/.test(section)
            && /^(model|model_provider|model_reasoning_effort|model_catalog_json|base_url|env_key|requires_openai_auth|wire_api)$/.test(key)
            || section === '' && /^(model_providers|profiles)\..*\.(base_url|env_key|requires_openai_auth|wire_api|model|model_provider|model_reasoning_effort|model_catalog_json)$/.test(key)
        const quoted = /^("(?:[^"\\]|\\.)*"|'[^']*')\s*(?:#.*)?$/.exec(value)?.[1]
        let scalar: string | undefined
        if (quoted) {
            try { scalar = quoted.startsWith("'") ? quoted.slice(1, -1) : JSON.parse(quoted) }
            catch { /* unknown TOML escapes remain unresolved */ }
        }
        if (routing) routes.push(`${section}:${key}=${scalar !== undefined ? JSON.stringify(scalar) : value}`)
        if (value.startsWith('"""') || value.startsWith("'''")) {
            const delimiter = value.slice(0, 3)
            if (!value.slice(3).includes(delimiter)) multiline = delimiter
            if (relevant) unresolved = true
            continue
        }
        if (!relevant) continue
        if (scalar === undefined || key in values) { unresolved = true; continue }
        values[key] = scalar
    }
    if (values.profile || multiline) unresolved = true // native profile precedence varies by CLI version
    return { values, routes: routes.sort(), unresolved, providers }
}

async function optionalRead(file: string): Promise<string | null> {
    try { return await fs.readFile(file, 'utf8') }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new Error('Codex native configuration is unreadable; check file access.') }
}

export async function codexSnapshot(configBin: string | null = null): Promise<{ native: NativeDefaults; metadata: ReturnType<typeof codexConfigMetadata>; custom: boolean }> {
    const home = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'))
    const metadata = codexConfigMetadata(await optionalRead(path.join(home, 'config.toml')))
    const { values, unresolved } = metadata
    // Watch only the selected profile, without guessing version-dependent precedence.
    const profiles: unknown[] = []
    if (values.profile && /^[A-Za-z0-9_-]+$/.test(values.profile)) {
        const name = `${values.profile}.config.toml`
        const raw = await optionalRead(path.join(home, name))
        profiles.push([name, raw === null ? null : codexConfigMetadata(raw).routes])
    }
    let authMode: string | null = null
    try {
        const auth = JSON.parse(await optionalRead(path.join(home, 'auth.json')) ?? '{}')
        if (['chatgpt', 'apikey', 'api_key', 'chatgptAuthTokens'].includes(auth.auth_mode)) authMode = auth.auth_mode
    } catch { /* no credential material is returned or hashed */ }
    const envRoute = ['OPENAI_BASE_URL', 'CODEX_HOME'].map(k => [k, process.env[k] ?? null])
    const context = 'sha256:' + hash([home, configBin, metadata.routes, profiles, authMode, envRoute,
        !!process.env.CODEX_API_KEY, !!process.env.OPENAI_API_KEY])
    const connection = unresolved ? null : values.model_provider ? (safe(values.model_provider) ? values.model_provider : null) : 'openai'
    const custom = connection !== 'openai' || metadata.providers.includes('openai') || !!values.openai_base_url || !!values.chatgpt_base_url || !!process.env.OPENAI_BASE_URL
    const authType = !custom && (process.env.CODEX_API_KEY || ['apikey', 'api_key'].includes(authMode ?? '')) ? 'api-key'
        : !custom && ['chatgpt', 'chatgptAuthTokens'].includes(authMode ?? '') ? 'oauth' : 'unknown'
    const notes = ['配置快照不证明认证、额度或模型调用成功；任务目录配置及托管策略可能影响模型默认值。']
    if (unresolved) notes.push('原生 profile 或复杂 TOML 选择未解析；不能把顶层默认值当成有效选择，请由安装 agent 核对所选 CLI 的原生配置。')
    return { metadata, custom, native: {
        connection, model: !unresolved && safe(values.model) ? values.model : null,
        effort: !unresolved && safe(values.model_reasoning_effort) ? values.model_reasoning_effort : null,
        profile: values.profile && safe(values.profile) ? values.profile : null,
        selection_context: context, credential_ready: null, notes,
        auth_type: authType,
    } }
}

export function parseCodexCatalog(stdout: string, connection: string): ModelEntry[] {
    let data: unknown
    try { data = JSON.parse(stdout) } catch { throw new Error('Codex model catalog is not valid JSON; raw output withheld.') }
    const rows = (data as { models?: unknown } | null)?.models
    if (!Array.isArray(rows)) throw new Error('Codex model catalog has an unsupported schema.')
    const found = new Map<string, ModelEntry>()
    for (const row of rows) {
        if (!row || !safe(row.slug) || row.visibility !== 'list') continue
        const efforts = Array.isArray(row.supported_reasoning_levels)
            ? row.supported_reasoning_levels.map((v: { effort?: unknown }) => v?.effort).filter(safe) : null
        found.set(row.slug, { alias: row.slug, connection, source: 'native-catalog', effort_options: efforts,
            default_effort: safe(row.default_reasoning_level) ? row.default_reasoning_level : null })
    }
    return [...found.values()]
}

export async function discoverCodexLive(opts?: { configBin?: string | null; cwd?: string }): Promise<DiscoverModelsResult> {
    const bin = opts?.configBin ?? null
    const before = await codexSnapshot(bin)
    const { native, metadata, custom } = before
    const models: ModelEntry[] = native.model ? [{ alias: native.model, connection: native.connection ?? null, source: 'native-config' }] : []
    const notes = [...native.notes!]
    if (native.connection && (!custom || metadata.values.model_catalog_json)) {
        const manifest = (await EndpointRegistry.load()).get('codex')
        const { plan } = await planEndpointSpawn(manifest, { configBin: bin })
        if (!plan) throw new Error('Codex binary is not resolvable for model discovery.')
        try {
            const { stdout } = await promisify(execFile)(plan.command, finalSpawnArgs(plan, ['debug', 'models']), {
                cwd: opts?.cwd, env: buildEnv(manifest), timeout: 20_000, maxBuffer: 16 * 1024 * 1024,
                windowsHide: true, windowsVerbatimArguments: needsVerbatimArgs(plan),
            })
            const catalog = parseCodexCatalog(stdout, native.connection)
            for (const model of catalog) {
                const index = models.findIndex(m => m.alias === model.alias)
                if (index >= 0) models[index] = model
                else models.push(model)
            }
            notes.push('来自所选 CLI 的 debug models 可见菜单；原生可能使用缓存或内置目录，不等于账号实时可调用名单。')
        } catch {
            notes.push('原生模型目录查询失败或此 CLI 不支持 debug models；只展示当前配置中可读取的模型，不借用旧缓存。检查版本、网络或登录后再查询。')
        }
    } else {
        notes.push('第三方连接未配置原生 model_catalog_json，或有效 provider 未解析；只展示已配置模型，不把 OpenAI 内置目录当成此连接可用模型。更多模型/强度需核对该服务的配置或文档。')
    }
    const after = await codexSnapshot(bin)
    if (after.native.selection_context !== native.selection_context) throw new Error('Codex configuration changed during discovery; query again before choosing.')
    return { models, native_defaults: native, selection_context: native.selection_context,
        connections: [...new Set([...(native.connection ? [native.connection] : []), ...metadata.providers])].map(id => ({
            id, source: id === native.connection ? 'native-config-active' : 'native-config-inactive',
            auth_type: id === native.connection ? native.auth_type ?? 'unknown' : 'unknown',
        })), notes }
}
