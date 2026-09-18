// Read-only ZCode configuration metadata. Never return credential fields.
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ModelSelection } from '../engine/types.js'

export function zcodeHome(env: NodeJS.ProcessEnv = process.env): string {
    return path.join(env.ZCODE_DATA_BASE_DIR || env.USERPROFILE || os.homedir(), '.zcode')
}

export function providerConfigPath(env: NodeJS.ProcessEnv = process.env, selected?: string | null): string {
    return selected ?? (selected === null ? undefined : env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE) ?? path.join(zcodeHome(env), 'v2', 'provider_config.json')
}

export async function readProviderConfig(file: string): Promise<any> {
    let value: any
    try { value = JSON.parse(await fs.readFile(file, 'utf8')) }
    catch { throw new Error('ZCode provider 配置无法读取或 JSON 无效；未切换配置。请检查 provider_config 指向的原生文件。') }
    if (value?.schemaVersion !== 1 || !Array.isArray(value.config?.providerConfigRules?.providerRules) || !value.config?.modelConfigRules) {
        throw new Error('ZCode provider 配置结构不受支持；未切换配置，请按当前 ZCode 版本检查。')
    }
    return value
}

export function configuredSelection(value: any): ModelSelection | null {
    const s = value?.config?.defaultModelSelection
    if (typeof s?.providerId !== 'string' || !s.providerId.trim() || typeof s?.modelId !== 'string' || !s.modelId.trim()) return null
    const p = value.config.providerConfigRules.providerRules.find((p: any) => p.providerId === s.providerId)
    return { provider: s.providerId, model: s.modelId,
        effort: typeof s.options?.reasoningLevel === 'string' && s.options.reasoningLevel.trim() ? s.options.reasoningLevel : null,
        ...(typeof p?.providerName === 'string' ? { provider_name: p.providerName } : {}),
    }
}
