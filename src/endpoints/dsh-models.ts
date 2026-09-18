// DSH remains profile-owned: read configured routes, never inject unsupported model/effort flags.
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import type { DiscoverModelsResult, NativeDefaults, ModelEntry, ConnectionEntry } from './parser-api.js'

export function readDshNativeDefaults(settingsYaml: string | null): NativeDefaults {
    const notes: string[] = []
    if (settingsYaml === null) {
        notes.push('native dsh settings.yaml not found; install/login dsh first')
        return { model: null, connection: null, effort: null, notes }
    }
    const block = /^agent-default-model:[ \t]*(?:#.*)?\r?\n((?:[ \t]+\S[^\r\n]*\r?\n?)+)/m.exec(settingsYaml)
    const pick = (key: string): string | null => {
        if (!block) return null
        const m = new RegExp(`^[ \\t]+${key}:[ \\t]*(?:"([^"\\r\\n]*)"|'([^'\\r\\n]*)'|([A-Za-z0-9_.:/-]+))[ \\t]*(?:#.*)?\\r?$`, 'm').exec(block[1] ?? '')
        return m ? m[1] ?? m[2] ?? m[3] ?? null : null
    }
    const provider = pick('provider')
    const model = pick('model')
    const effort = pick('reasoningEffort')
    if (!provider || !model) {
        notes.push('no agent-default-model provider/model in native settings.yaml; dsh profile default applies')
        return { model: null, connection: provider, effort, notes }
    }
    notes.push(
        'default model from native settings.yaml agent-default-model (profile-only; no CLI model-list surface)' +
        (effort ? `; reasoningEffort=${effort}` : ''),
    )
    notes.push('Settings-file snapshot only: headless profile/plugin layers may override it. DSH profiles compose plugins; they are not interchangeable with OMP account-isolation profiles. No paidan model/effort override; authentication unverified.')
    return { model, connection: provider, effort, credential_ready: null, notes }
}


/** Restricted metadata reader for ordinary block-style settings, not a general YAML evaluator. */
export function discoverDshModels(settingsYaml: string | null): DiscoverModelsResult {
    const native = readDshNativeDefaults(settingsYaml)
    native.profile = 'headless'
    const models: ModelEntry[] = [], connections: ConnectionEntry[] = []
    let section = '', provider: string | null = null, inProviders = false
    const scalar = (v: string) => /^["']?([A-Za-z0-9_.:/-]+)["']?(?:\s+#.*)?$/.exec(v.trim())?.[1] ?? null
    const addProvider = (id: string) => {
        if (!connections.some(c => c.id === id)) connections.push({ id, source: 'native-config', auth_type: 'unknown' })
    }
    const addModel = (connection: string, id: string) => {
        if (!models.some(m => m.alias === connection + '/' + id)) models.push({ alias: connection + '/' + id,
            connection, resolved_model: id, source: 'native-config', effort_selectable: false,
            default_effort: connection === native.connection && id === native.model ? native.effort ?? null : null })
    }
    for (const line of (settingsYaml ?? '').split(/\r?\n/)) {
        const root = /^([\w-]+):/.exec(line)
        if (root) { section = root[1]; provider = null; inProviders = false }
        if (section === 'llm-deepseek') {
            provider = 'deepseek-official' // native plugin's registered route ID
            addProvider(provider)
        } else if (section === 'llm-pi-ai') {
            if (/^  providers:\s*(?:#.*)?$/.test(line)) inProviders = true
            else if (/^  \S/.test(line)) { inProviders = false; provider = null }
            const key = inProviders ? /^    ["']?([\w.-]+)["']?:\s*(?:#.*)?$/.exec(line) : null
            if (key) { provider = key[1]; addProvider(provider) }
        } else continue
        if (!provider) continue
        const model = /^\s+-\s+id:\s*(.+)$/.exec(line)
        if (model) { const id = scalar(model[1]); if (id) addModel(provider, id) }
        const ref = /^\s+apiKeyEnv:\s*(.+)$/.exec(line)
        if (ref && scalar(ref[1])) {
            const c = connections.find(c => c.id === provider)!
            c.auth_type = 'api-key'
            c.access_type = 'native-credential-reference' // not a claim that the referenced credential exists
        }
    }
    if (native.connection && native.model) { addProvider(native.connection); addModel(native.connection, native.model) }
    return { models, connections, native_defaults: native,
        notes: [...native.notes ?? [], '只列 settings.yaml 中明确配置的普通块式 provider/model；插件内置目录、复杂 YAML 和 profile 覆盖不在此菜单范围。缺项不等于不可用，请在原生模型设置中选择。',
            'DSH 的 provider/model/reasoningEffort 由原生配置共同控制。调整时先展示具体字段并取得用户同意；paidan 不保存假的固定覆盖、不修改原生文件。'] }
}

export function dshSettingsPath(): string {
    return nodePath.join(process.env.DSH_HOME ?? nodePath.join(os.homedir(), '.dsh'), 'settings.yaml')
}

async function readSettings(): Promise<string | null> {
    let yaml: string | null = null
    try {
        yaml = await fs.readFile(dshSettingsPath(), 'utf8')
    } catch {
        yaml = null
    }
    return yaml
}

export async function readNativeDefaults(): Promise<NativeDefaults> {
    return { ...readDshNativeDefaults(await readSettings()), profile: 'headless' }
}

export async function discoverModels(): Promise<DiscoverModelsResult> {
    return discoverDshModels(await readSettings())
}
