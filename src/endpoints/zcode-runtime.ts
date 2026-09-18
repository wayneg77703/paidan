// Desktop-bundled ZCode CLI needs its companion provider catalog. This is a
// public application resource, not the user's provider/credential config.
import * as fs from 'node:fs/promises'
import * as nodePath from 'node:path'
import type { SpawnPlan } from './spawn.js'
import { configuredSelection, providerConfigPath, readProviderConfig } from './zcode-config.js'

export async function prepareZcodeRuntime(plan: SpawnPlan, base: NodeJS.ProcessEnv, cwd = process.cwd(), providerConfig?: string | null) {
    const env = { ...base }
    const key = 'ZCODE_BUILTIN_PROVIDER_CONFIG_FILE'
    const explicit = Object.hasOwn(base, key)
    const entry = plan.endpoint_bin ? await fs.realpath(plan.endpoint_bin).catch(() => plan.endpoint_bin!) : null
    const candidates = explicit
        ? (base[key] ? [nodePath.resolve(cwd, base[key])] : [])
        : entry ? [
            nodePath.resolve(nodePath.dirname(entry), '..', 'config', 'provider', 'zcode-builtin.json'),
            nodePath.join(nodePath.dirname(entry), 'provider', 'zcode-builtin.json'),
        ] : []
    let file: string | null = null
    for (const candidate of candidates) {
        if (await fs.stat(candidate).then((s) => s.isFile(), () => false)) { file = candidate; break }
    }
    if (file && !explicit) env[key] = file
    if (providerConfig === null) delete env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE
    else if (providerConfig !== undefined) env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = providerConfig
    const personalFile = providerConfigPath(env)
    const dedicated = providerConfig !== undefined && providerConfig !== null
    let personal: any = null
    try { personal = await readProviderConfig(personalFile) }
    catch (error) { if (dedicated || Object.hasOwn(env, 'ZCODE_PERSONAL_PROVIDER_CONFIG_FILE')) throw error }
    const expected = configuredSelection(personal)
    if (dedicated && (!expected || expected.effort === null)) throw new Error('ZCode 专用配置缺少完整 defaultModelSelection（provider、model、reasoningLevel）；未改走原生配置。')
    if (dedicated) {
        const providers = personal.config.providerConfigRules.providerRules
        if (providers.length !== 1 || providers[0]?.providerId !== expected!.provider || providers[0]?.enabled === false) {
            throw new Error('ZCode 专用配置必须只包含所选的一个启用 provider；未自动改用其他连接。')
        }
    }
    return {
        env,
        expected,
        provider_config: personalFile,
        check: {
            ready: file !== null,
            source: explicit ? 'explicit-environment' : file ? 'selected-installation' : 'unresolved',
            file: file ?? (explicit ? base[key] ?? null : null),
            notes: file
                ? ['Bundled provider catalog located; no credentials or native configuration changed. Authentication remains unverified.']
                : ['ZCode bundled provider catalog not found. Keep the full installation and inspect this version\'s native launch environment. An explicit environment value is never replaced. This is not a reason to copy login credentials.'],
        },
    }
}
