// AGY model IDs can encode effort. Keep that native choice intact instead of combining incompatible flags.
import * as os from 'node:os'
import * as path from 'node:path'
import type { DiscoverModelsResult, ModelEntry, NativeDefaults } from './parser-api.js'
import { queryNative, optionalFile, jsonObject, text, selectionContext, validateCatalogSelection, type NativeQueryOptions } from './native-metadata.js'

/** `agy models` prints TSV rows: <model-id>\t<Display Name> (live 1.1.28, 2026-09-10). */
export function parseAgyModelsOutput(text: string): DiscoverModelsResult {
    const models: ModelEntry[] = []
    for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim()
        if (!trimmed) continue
        const tab = trimmed.indexOf('\t')
        const alias = (tab >= 0 ? trimmed.slice(0, tab) : trimmed).trim()
        if (!alias || /\s/.test(alias)) continue
        models.push({ alias, label: tab >= 0 ? trimmed.slice(tab + 1).trim() : alias,
            connection: null, source: 'native-catalog', effort_selectable: false,
            default_effort: /-(low|medium|high)$/i.exec(alias)?.[1]?.toLowerCase() ?? null, effort_options: [] })
    }
    const notes = models.length === 0
        ? ['`agy models` returned no rows']
        : ['Native catalog; authentication method/account cannot be inferred from model IDs. Model suffixes may encode thinking tiers. Some CLI versions expose --effort, but paidan does not yet deliver that flag; follow native settings.']
    return { models, notes }
}


async function snapshot(opts: NativeQueryOptions = {}): Promise<NativeDefaults> {
    const home = process.env.PAIDAN_HOST_HOME ?? process.env.USERPROFILE ?? os.homedir()
    const raw = await optionalFile(path.join(home, '.gemini', 'antigravity-cli', 'settings.json'))
    const settings = raw === null ? {} : jsonObject(raw, 'AGY')
    const model = text(settings.model), provider = text(settings.modelProvider)
    return { model, effort: /(?:-|\()(low|medium|high)\)?$/i.exec(model ?? '')?.[1]?.toLowerCase() ?? null,
        connection: provider ?? 'antigravity', auth_type: 'unknown', credential_ready: null,
        selection_context: selectionContext([home, opts.configBin ?? null, model, provider]),
        notes: ['AGY 模型可自带强度档位；固定完整模型 ID 即固定这个模型档位，不叠加独立 --effort。',
            '原生设置中的显示名称会在本次模型目录中匹配；登录账号/额度未知，不将 Antigravity 自动标为 Google OAuth。配置摘要无法检测所有原生登录态变化。',
            ...(raw === null ? ['未找到 AGY 原生设置文件；原生默认模型未知。'] : [])] }
}

export async function readNativeDefaults(opts?: NativeQueryOptions): Promise<NativeDefaults> { return snapshot(opts) }

export async function discoverModels(opts?: NativeQueryOptions): Promise<DiscoverModelsResult> {
    const [found, native] = await Promise.all([queryNative('agy', ['models'], opts).then(parseAgyModelsOutput), snapshot(opts)])
    const selected = found.models.find(m => m.alias === native.model || m.label === native.model)
    if (selected) { native.model = selected.alias; native.effort = selected.default_effort ?? null }
    for (const model of found.models) model.connection = native.connection ?? null
    return { ...found, native_defaults: native, selection_context: native.selection_context,
        connections: [{ id: native.connection!, label: 'AGY 原生连接', source: 'native-cli', auth_type: 'unknown' }],
        notes: [...found.notes, ...native.notes!] }
}

export async function validateSelection(selection: { model: string | null; effort: string | null }, opts: NativeQueryOptions): Promise<NativeDefaults> {
    return validateCatalogSelection('agy', selection, await discoverModels(opts))
}
