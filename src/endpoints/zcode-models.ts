// Candidate metadata from local rules, without starting ZCode or fetching remote config.
// Interpret only enabled flags and reasoning choices; native expressions/credentials stay native.
import type { DiscoverModelsResult, ModelEntry, ConnectionEntry } from './parser-api.js'

export function discoverZcodeApiCandidates(personal: any, builtin: any): DiscoverModelsResult {
    const notes = ['本地配置候选，不是认证或额度验证；运行时的缓存模板、账号状态可能不同。仅列已配置且已启用的 API provider。']
    const templates = new Map<string, any>((builtin?.config?.providerConfigRules?.templateRules ?? []).map((r: any) => [r.templateId, r]))
    const baseProviders = new Map<string, any>((builtin?.config?.providerConfigRules?.providerRules ?? []).map((r: any) => [r.providerId, r]))
    const rules = builtin?.config?.modelConfigRules ?? {}
    const userModels = personal?.config?.modelConfigRules ?? {}
    const models: ModelEntry[] = [], connections: ConnectionEntry[] = []
    const seen = new Set<string>()
    for (const p of personal?.config?.providerConfigRules?.providerRules ?? []) {
        if (typeof p?.providerId !== 'string') continue
        if (seen.has(p.providerId)) throw new Error('ZCode provider rules 含重复标识，无法可靠展示候选。')
        seen.add(p.providerId)
        if (p.enabled === false || p.providerId.startsWith('account:')) continue
        const base = baseProviders.get(p.providerId)
        const templateId = p.templateId ?? base?.templateId
        const template = templates.get(templateId)
        if (templateId && !template) { notes.push(`provider ${p.providerId}: 本地缺少模板，候选未知。`); continue }
        const layers = [template?.config, base?.config, p.config].filter(Boolean)
        const cfg = Object.assign({}, ...layers)
        const access = Object.assign({}, ...layers.map(c => c.access ?? {})).type
        const api = Object.assign({}, ...layers.map(c => c.api ?? {}))
        if (access !== 'api-key' && access !== 'zhipu-coding-plan-api-key') continue
        connections.push({ id: p.providerId, label: p.providerName ?? template?.templateNameMap?.['zh-CN'] ?? p.providerId,
            source: 'native-config', auth_type: 'api-key', access_type: access })
        const ids = [...new Set<string>([...(cfg.builtinModelIds ?? []), ...(cfg.personalModelIds ?? [])].filter(v => typeof v === 'string'))]
        for (const model of ids) {
            let enabled = true, levels: string[] | null = null, certain = true
            const apply = (config: any) => {
                if (typeof config?.enabled === 'boolean') enabled = config.enabled
                const values = config?.optionSpecs?.reasoningLevel?.values
                if (values !== undefined) levels = Array.isArray(values) && values.every((v: any) => typeof v === 'string') ? values : null
            }
            const matches = (pattern: any, value: any) => {
                if (pattern === undefined) return true
                if (typeof pattern !== 'string' || typeof value !== 'string') return false
                try { return new RegExp(`^(?:${pattern})$`, 'i').test(value) }
                catch { certain = false; return false }
            }
            for (const group of ['modelRules', 'modelApiRules', 'providerSiteRules']) {
                for (const r of rules[group] ?? []) if (matches(r.modelMatch, model) && matches(r.apiTypeMatch, api.type) && matches(r.baseUrlMatch, api.baseUrl)) apply(r.config)
            }
            for (const r of rules.templateModelRules ?? []) if (r.templateId === templateId && r.modelId === model) apply(r.config)
            for (const r of rules.builtinProviderModelRules ?? []) if (r.providerId === p.providerId && r.modelId === model) apply(r.config)
            for (const group of ['providerModelRules', 'manualProviderModelRules']) {
                for (const r of userModels[group] ?? []) {
                    if (r.providerId !== p.providerId) continue
                    if (r.modelId === model) apply(r.config)
                    else if (r.modelMatch !== undefined) certain = false // unsupported personal matcher; never guess its effort override
                }
            }
            if (enabled) models.push({ alias: `${p.providerId}/${model}`, connection: p.providerId, source: 'native-config',
                effort_options: certain ? levels : null, default_effort: certain ? (levels as string[] | null)?.at(-1) ?? null : null })
        }
    }
    if (!builtin) notes.push('缺少当前安装的内置模板；模型/强度清单可能不完整，请在 ZCode 原生界面核对。')
    return { models, connections, notes }
}
