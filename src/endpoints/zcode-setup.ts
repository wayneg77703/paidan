// Installation-only profile construction. The caller writes it solely inside ZCode's native home.
import { PaidanError } from '../engine/errors.js'

export function buildZcodeProfile(native: any, selection: { provider: string; model: string; effort: string }): unknown {
    const providers = native?.config?.providerConfigRules?.providerRules
    const chosen = Array.isArray(providers) ? providers.filter(p => p?.providerId === selection.provider) : []
    if (native?.schemaVersion !== 1 || chosen.length !== 1 || chosen[0].enabled === false || selection.provider.startsWith('account:')) {
        throw new PaidanError('SETUP_INVALID', 'ZCode 必须选择唯一、启用的 API provider；未修改原生配置。')
    }
    const access = chosen[0].config?.access?.type
    if (access !== undefined && !['api-key', 'zhipu-coding-plan-api-key'].includes(access)) throw new PaidanError('SETUP_INVALID', '专用配置只复制 API provider，不复制原生登录态。')
    const rules = native.config.modelConfigRules
    const ownRules = (key: string) => {
        if (rules?.[key] !== undefined && !Array.isArray(rules[key])) throw new PaidanError('SETUP_INVALID', 'ZCode 模型规则格式无法识别。')
        return (rules?.[key] ?? []).filter((r: any) => r?.providerId === selection.provider)
    }
    return { schemaVersion: 1, config: {
        providerOrder: [selection.provider],
        providerConfigRules: { providerRules: chosen },
        modelConfigRules: { providerModelRules: ownRules('providerModelRules'), manualProviderModelRules: ownRules('manualProviderModelRules') },
        defaultModelSelection: { providerId: selection.provider, modelId: selection.model, options: { reasoningLevel: selection.effort } },
    } }
}
