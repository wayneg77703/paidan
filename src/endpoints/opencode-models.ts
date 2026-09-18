// OpenCode metadata is resolved in the task directory; credentials never leave native custody.
import * as path from 'node:path'
import type { DiscoverModelsResult, ModelEntry, NativeDefaults, ConnectionEntry } from './parser-api.js'
import { queryNative, optionalFile, jsonObject, record, text, routeIdentity, selectionContext, validateCatalogSelection, type NativeQueryOptions } from './native-metadata.js'

/** Verbose format: provider/model line followed by a pretty-printed JSON object. */
export function parseVerboseModelsOutput(text: string): DiscoverModelsResult {
    const models: ModelEntry[] = []
    const lines = text.replace(/\r/g, '').split('\n')
    let alias: string | null = null
    let block: string[] = []
    const flush = () => {
        if (!alias) return
        let o: Record<string, unknown>
        try { o = JSON.parse(block.join('\n')) } catch { throw new Error('opencode models --verbose returned an incomplete model record; raw output withheld') }
        if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('opencode models --verbose returned an unknown schema')
        const variants = o.variants
        models.push({
            alias, ...(typeof o.name === 'string' ? { label: o.name } : {}),
            connection: alias.slice(0, alias.indexOf('/')), source: 'native-catalog',
            effort_options: variants && typeof variants === 'object' && !Array.isArray(variants)
                ? Object.entries(variants).filter(([, v]) => !(v && typeof v === 'object' && (v as Record<string, unknown>).disabled === true)).map(([key]) => key)
                : null,
        })
    }
    for (const line of lines) {
        if (/^[a-z0-9][a-z0-9.-]*\/\S+$/i.test(line)) { flush(); alias = line; block = [] }
        else if (alias) block.push(line)
        else if (line.trim()) throw new Error('opencode models --verbose returned an unknown preamble; raw output withheld')
    }
    flush()
    return { models, notes: ['Native verbose catalog; effort_options are the selected model variants, including custom names. Catalog entries do not verify authentication or quota; inspect native providers list before choosing a connection.'] }
}


export function opencodeSnapshot(config: Record<string, any>, auth: Record<string, any>, identity: unknown): { native: NativeDefaults; connections: ConnectionEntry[] } {
    const providers = record(config.provider)
    const ids = [...new Set([...Object.keys(providers), ...Object.keys(auth)])].sort()
    const connections: ConnectionEntry[] = ids.map(id => ({ id, source: 'native-config',
        auth_type: auth[id]?.type === 'oauth' ? 'oauth' : auth[id]?.type === 'api' || text(providers[id]?.options?.apiKey) ? 'api-key' : 'unknown' }))
    const build = record(config.agent?.build)
    const model = text(build.model) ?? text(config.model)
    const connection = model?.includes('/') ? model.slice(0, model.indexOf('/')) : null
    const routes = ids.map(id => {
        const p = record(providers[id])
        return [id, p.npm ?? null, routeIdentity(p.options?.baseURL), connections.find(c => c.id === id)?.auth_type,
            Object.keys(record(p.options?.headers)).sort(), p.whitelist ?? null, p.blacklist ?? null,
            Object.entries(record(p.models)).map(([id, m]) => [id, m.id ?? null, m.npm ?? null, routeIdentity(m.options?.baseURL),
                Object.entries(record(m.variants)).map(([v, config]) => [v, config?.disabled === true])])]
    })
    const native: NativeDefaults = { model, connection, effort: text(build.variant), credential_ready: null,
        auth_type: connections.find(c => c.id === connection)?.auth_type ?? 'unknown',
        selection_context: selectionContext([identity, model, build.variant ?? null, routes, config.enabled_providers ?? null, config.disabled_providers ?? null]),
        notes: ['所选 CLI 在当前目录解析的配置；认证类型仅表示原生配置记录，不证明登录有效、额度或实际调用。',
            '未显式配置的默认模型保持未知，可能由原生最近选择、插件或会话决定；不拿目录第一项充当默认值。'],
    }
    return { native, connections }
}

async function snapshot(opts: NativeQueryOptions = {}) {
    const [raw, paths] = await Promise.all([queryNative('opencode', ['debug', 'config'], opts), queryNative('opencode', ['debug', 'paths'], opts)])
    const data = /^data\s+(.+)$/m.exec(paths)?.[1]?.trim()
    if (!data || !path.isAbsolute(data)) throw new Error('OpenCode 原生数据目录未识别；请检查所选 CLI 的 debug paths。')
    const auth = await optionalFile(path.join(data, 'auth.json'))
    return opencodeSnapshot(jsonObject(raw, 'OpenCode'), auth === null ? {} : jsonObject(auth, 'OpenCode'), [opts.configBin ?? null, data])
}

export async function readNativeDefaults(opts?: NativeQueryOptions): Promise<NativeDefaults> {
    return (await snapshot(opts)).native
}

export async function discoverModels(opts?: NativeQueryOptions): Promise<DiscoverModelsResult> {
    const [found, state] = await Promise.all([
        queryNative('opencode', ['models', '--verbose'], opts).then(parseVerboseModelsOutput), snapshot(opts),
    ])
    const connections = [...state.connections]
    for (const m of found.models) if (m.connection && !connections.some(c => c.id === m.connection)) {
        connections.push({ id: m.connection, source: 'native-catalog', auth_type: 'unknown' })
    }
    return { ...found, connections, native_defaults: state.native, selection_context: state.native.selection_context,
        notes: [...found.notes, ...state.native.notes!] }
}

export async function validateSelection(selection: { model: string | null; effort: string | null }, opts: NativeQueryOptions): Promise<NativeDefaults> {
    return validateCatalogSelection('opencode', selection, await discoverModels(opts))
}
