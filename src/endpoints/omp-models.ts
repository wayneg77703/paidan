// OMP queries inherit the native profile; only selection metadata leaves this module.
import * as path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { DiscoverModelsResult, ModelEntry, NativeDefaults, ConnectionEntry } from './parser-api.js'
import { queryNative, jsonObject, record, text, optionalFile, routeIdentity, selectionContext, validateCatalogSelection, type NativeQueryOptions } from './native-metadata.js'

/** Pure parse of `omp models --json` output. Broken output (non-JSON / wrong shape) THROWS so the caller keeps the last good cache — a shape failure is a discovery failure, not an honest empty catalog (codex F7). A genuinely empty but well-formed catalog returns an empty list. */
export function parseOmpModelsJson(text: string): DiscoverModelsResult {
    const notes: string[] = []
    let parsed: unknown
    try {
        parsed = JSON.parse(text)
    } catch {
        throw new Error('omp models --json returned non-JSON output (discovery failed; keeping the last good cache)')
    }
    const list = (parsed as { models?: unknown } | null)?.models
    if (!Array.isArray(list)) throw new Error('omp models --json: no models array in output (discovery failed; keeping the last good cache)')
    const models: ModelEntry[] = []
    for (const entry of list) {
        const e = entry as Record<string, unknown>
        if (typeof e?.selector !== 'string' || !e.selector) continue
        models.push({
            alias: e.selector, ...(typeof e.name === 'string' ? { label: e.name } : {}),
            connection: typeof e.provider === 'string' ? e.provider : null,
            source: 'native-catalog',
            effort_options: Array.isArray(e.thinking) && e.thinking.every((v) => typeof v === 'string') ? e.thinking : null,
        })
    }
    if (models.length === 0) notes.push('omp models --json returned an empty catalog; authentication state unknown')
    notes.push('Catalog for the inherited native OMP_PROFILE; provider is not an account identity. Per-model thinking levels take precedence over the CLI-wide option list. Main/smol/slow/plan roles are separate native settings.')
    return { models, notes }
}


export function ompSnapshot(settings: Record<string, any>, auth: Array<{ provider: string; credential_type: string; disabled: number }>, identity: unknown): { native: NativeDefaults; connections: ConnectionEntry[] } {
    const value = (key: string) => settings[key]?.value
    const roles = record(value('modelRoles'))
    const selected = text(roles.default)
    // OMP also accepts fuzzy patterns/role references; do not resolve those by picking a catalog row.
    const model = selected?.includes('/') && !/[*?{}\s]/.test(selected) ? selected : null
    const connections: ConnectionEntry[] = [...new Set(auth.map(a => a.provider))].sort().map(id => {
        const active = auth.filter(a => a.provider === id && !a.disabled)
        const kinds = new Set(active.map(a => a.credential_type))
        return { id, source: 'native-auth-metadata', auth_type: kinds.size === 1 && kinds.has('oauth') ? 'oauth'
            : kinds.size === 1 && kinds.has('api_key') ? 'api-key' : 'unknown', enabled: active.length > 0 }
    })
    const keys = ['modelRoles', 'modelRoleStorage', 'defaultThinkingLevel', 'enabledModels', 'enabledProviders', 'disabledProviders', 'modelProviderOrder',
        'retry.modelFallback', 'retry.usageAwareFallback', 'retry.fallbackChains', 'prewalk.enabled']
    const metadata = Object.fromEntries(keys.map(k => [k, value(k) ?? null]))
    const connection = model?.slice(0, model.indexOf('/')) ?? null
    return { connections, native: { model, connection, effort: text(value('defaultThinkingLevel')), profile: process.env.OMP_PROFILE ?? null,
        credential_ready: null, auth_type: connections.find(c => c.id === connection)?.auth_type ?? 'unknown',
        selection_context: selectionContext([identity, metadata, connections]),
        notes: ['仅检查当前 OMP_PROFILE；主模型读取 modelRoles.default，角色引用、模糊名称及自动选择保持未知，不改动 smol/slow/plan。',
            '同一 provider 可有多个原生账号；paidan 固定完整模型 selector，不声称固定了某个账号。认证记录不证明额度。',
            ...(value('retry.modelFallback') || value('retry.usageAwareFallback') || value('prewalk.enabled')
                ? ['原生配置启用了模型 fallback 或角色切换；固定请求模型不等于禁止原生换路。需要严格固定时，由用户决定是否调整这些原生设置。'] : [])] } }
}

async function snapshot(opts: NativeQueryOptions = {}) {
    const [raw, location] = await Promise.all([queryNative('omp', ['config', 'list', '--json'], opts), queryNative('omp', ['config', 'path'], opts)])
    const home = location.trim()
    if (!path.isAbsolute(home) || /[\r\n]/.test(home)) throw new Error('OMP 当前 profile 目录未识别，请检查 config path。')
    let auth: Array<{ provider: string; credential_type: string; disabled: number }> = []
    let authKnown = false
    let db: DatabaseSync | undefined
    try {
        db = new DatabaseSync(path.join(home, 'agent.db'), { readOnly: true })
        // Never select the credential data, identity, email or token columns.
        auth = db.prepare('SELECT provider, credential_type, disabled_cause IS NOT NULL AS disabled FROM auth_credentials ORDER BY provider, credential_type, disabled').all() as typeof auth
        authKnown = true
    } catch { /* Older/broker layouts stay unknown; native catalog remains authoritative. */ }
    finally { db?.close() }
    const routes: unknown[] = []
    for (const file of ['models.yml', 'models.yaml']) {
        const raw = await optionalFile(path.join(home, file))
        if (raw) routes.push(raw.split(/\r?\n/).flatMap(line => {
            const m = /^\s*(baseURL|baseUrl|api|id):\s*["']?([^"'\r\n#]+?)["']?\s*(?:#.*)?$/.exec(line)
            return m ? [[m[1], m[1].startsWith('base') ? routeIdentity(m[2]) : m[2]]] : []
        }))
    }
    const state = ompSnapshot(jsonObject(raw, 'OMP'), auth, [opts.configBin ?? null, home, process.env.OMP_PROFILE ?? null, routes])
    if (!authKnown) state.native.notes!.push('原生认证元数据不可读或使用了不同存储格式；账号类型未知，由原生登录工具检查。')
    return state
}

export async function readNativeDefaults(opts?: NativeQueryOptions): Promise<NativeDefaults> { return (await snapshot(opts)).native }

export async function discoverModels(opts?: NativeQueryOptions): Promise<DiscoverModelsResult> {
    const [found, state] = await Promise.all([queryNative('omp', ['models', '--json'], opts).then(parseOmpModelsJson), snapshot(opts)])
    const connections = [...state.connections]
    for (const m of found.models) {
        if (m.effort_options) m.effort_options = [...new Set([...m.effort_options, 'auto'])]
        if (m.connection && !connections.some(c => c.id === m.connection)) connections.push({ id: m.connection, source: 'native-catalog', auth_type: 'unknown' })
    }
    return { ...found, connections, native_defaults: state.native, selection_context: state.native.selection_context,
        notes: [...found.notes, ...state.native.notes!, 'auto 是原生自动强度策略，不代表固定到某个思考档位。'] }
}

export async function validateSelection(selection: { model: string | null; effort: string | null }, opts: NativeQueryOptions): Promise<NativeDefaults> {
    return validateCatalogSelection('omp', selection, await discoverModels(opts))
}
