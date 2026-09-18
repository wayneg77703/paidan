// Agent-facing setup: inventory -> choices -> reviewed application. No interactive UI or model tasks.
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { fileURLToPath } from 'node:url'
import type { PaidanConfig } from './engine/config.js'
import type { EndpointRegistry } from './endpoints/registry.js'
const pkgRoot = fileURLToPath(new URL('..', import.meta.url))
export interface InstallationContext { config: PaidanConfig; configPath: string; dataDir: string; registry: EndpointRegistry }
import { PaidanError } from './engine/errors.js'
import { parseConfig } from './engine/config.js'
import { ModelsCache } from './engine/models-cache.js'
import { readOptionalBytes, fileDigest } from './engine/approved-write.js'
import { installationFile, checkInstallationTarget, readInstallationReceipt, previewFiles, applyInstallationFiles, type InstallationFile } from './engine/installation-files.js'
import { detectHosts, loadHostRegistry, adaptSkillPayload } from './engine/skill-install.js'
import { discoverInstallations } from './endpoints/installation-discovery.js'
import { detectVersion, discoverAndCacheModels, readEndpointNativeDefaults } from './endpoints/inspection.js'
import { supportsEffort, assertSafeSubstitutionValue, checkPermission } from './endpoints/invocation.js'
import { PERMISSION_PRESETS, type PermissionPreset } from './engine/types.js'
import { selectionContext } from './endpoints/native-metadata.js'
import { providerConfigPath, readProviderConfig, zcodeHome } from './endpoints/zcode-config.js'
import { buildZcodeProfile } from './endpoints/zcode-setup.js'
import { prepareZcodeRuntime } from './endpoints/zcode-runtime.js'
import { dshSettingsPath } from './endpoints/dsh-models.js'
import { updateDshSettings } from './endpoints/dsh-setup.js'

export interface EndpointChoice {
    bin?: string; locations?: string[]; enabled?: boolean; native?: boolean; model?: string | null; effort?: string | null; provider?: string
    mode?: PermissionPreset | null
    native_settings?: { provider: string; model: string; effort?: string | null }
}
export interface Choices {
    endpoints: Record<string, EndpointChoice>
    default_endpoint?: string | null
    hosts?: Array<string | { name: string; replace?: boolean }>
}

function object(value: unknown, keys: string[], where: string): Record<string, any> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PaidanError('SETUP_INVALID', `${where} 必须是对象。`)
    for (const key of Object.keys(value)) if (!keys.includes(key)) throw new PaidanError('SETUP_INVALID', `${where} 不支持字段 ${key}。`)
    return value as Record<string, any>
}

export function parseChoices(value: unknown, ctx: InstallationContext): Choices {
    const o = object(value, ['endpoints', 'default_endpoint', 'hosts'], 'choices')
    object(o.endpoints, ctx.registry.list().map(m => m.name), 'endpoints')
    for (const [name, value] of Object.entries(o.endpoints)) {
        if (['__proto__', 'constructor', 'prototype'].includes(name)) throw new PaidanError('SETUP_INVALID', '端点名称使用了保留字段。')
        const c = object(value, ['bin', 'locations', 'enabled', 'native', 'model', 'effort', 'provider', 'mode', 'native_settings'], name)
        for (const field of ['bin', 'provider', 'model', 'effort']) {
            if (c[field] !== undefined && c[field] !== null && (typeof c[field] !== 'string' || !c[field])) throw new PaidanError('SETUP_INVALID', `${name}.${field} 必须是非空字符串。`)
        }
        for (const field of ['bin', 'provider']) if (c[field] === null) throw new PaidanError('SETUP_INVALID', `${name}.${field} 不能为 null。`)
        if (c.native !== undefined && typeof c.native !== 'boolean') throw new PaidanError('SETUP_INVALID', `${name}.native 必须是布尔值。`)
        if (c.native && ['model', 'effort', 'provider'].some(k => c[k] != null)) throw new PaidanError('SETUP_INVALID', `${name} 跟随原生不能同时指定固定组合。`)
        if (c.provider !== undefined && name !== 'zcode') throw new PaidanError('SETUP_INVALID', '只有 ZCode 专用配置使用 provider 字段，其他端点使用目录中的完整模型 ID。')
        if (c.locations !== undefined && (!Array.isArray(c.locations) || c.locations.some((p: unknown) => typeof p !== 'string' || !path.isAbsolute(p)))) throw new PaidanError('SETUP_INVALID', 'locations 必须是安装目录或程序文件的绝对路径数组。')
        if (c.enabled !== undefined && typeof c.enabled !== 'boolean') throw new PaidanError('SETUP_INVALID', 'enabled 必须是布尔值。')
        if (c.enabled === false && Object.keys(c).some(k => k !== 'enabled')) throw new PaidanError('SETUP_INVALID', '禁用端点时只填写 enabled:false，原有组合保留。')
        if (c.mode != null && !PERMISSION_PRESETS.includes(c.mode)) throw new PaidanError('SETUP_INVALID', 'mode 必须是受支持的权限预设。')
        if (c.native_settings !== undefined) {
            const n = object(c.native_settings, ['provider', 'model', 'effort'], 'native_settings')
            if (name !== 'dsh' || ![n.provider, n.model].every(v => typeof v === 'string' && /^[A-Za-z0-9_.:/-]+$/.test(v))
                || n.effort != null && (typeof n.effort !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(n.effort))) throw new PaidanError('SETUP_INVALID', 'native_settings 仅用于 DSH 原生 provider/model/effort 的明确选择。')
            if (c.model != null || c.effort != null) throw new PaidanError('SETUP_INVALID', 'DSH 原生设置不能与 paidan 模型/强度覆盖混用。')
        }
    }
    if (o.default_endpoint != null && typeof o.default_endpoint !== 'string') throw new PaidanError('SETUP_INVALID', 'default_endpoint 必须是端点名称或 null。')
    if (o.hosts !== undefined && !Array.isArray(o.hosts)) throw new PaidanError('SETUP_INVALID', 'hosts 必须是数组。')
    for (const host of o.hosts ?? []) {
        if (typeof host === 'string') continue
        const h = object(host, ['name', 'replace'], 'host')
        if (typeof h.name !== 'string' || h.replace !== undefined && typeof h.replace !== 'boolean') throw new PaidanError('SETUP_INVALID', 'host 需要 name 和可选的 replace 布尔值。')
    }
    return o as Choices
}

export async function surveyInstallation(ctx: InstallationContext, name: string, choice: EndpointChoice, cwd: string) {
    const manifest = ctx.registry.get(name)
    const pinned = choice.bin ?? (choice.locations?.length ? undefined : ctx.config.endpoints.overrides[name]?.bin)
    if (pinned && (!path.isAbsolute(pinned) || /\.ps1$/i.test(pinned)
        || /\.(cmd|bat)$/i.test(pinned) && manifest.command.prompt_delivery === 'argv')) {
        throw new PaidanError('SETUP_INVALID', `${name} 需要可直接调用的完整入口路径；argv 传任务的端点须选原生程序或 Node 脚本。`)
    }
    const found = await discoverInstallations(manifest, { configBin: pinned, locations: choice.locations })
    const candidates = await Promise.all(found.candidates.map(async p => {
        let versionError: string | null = null
        const version = await detectVersion(manifest, p, reason => { versionError = reason })
        return { bin: p.endpoint_bin!, source: p.resolved_from, version, version_error: versionError }
    }))
    const pin = pinned ? await fs.realpath(pinned).catch(() => null) : null
    const chosen = pinned ? candidates.find(c => c.bin === pin) : candidates.length === 1 ? candidates[0] : undefined
    const selectionRequired = !chosen
    let menu = null, native = null, error: string | null = null, resources = null
    if (chosen?.version) {
        try {
            menu = await discoverAndCacheModels(manifest, new ModelsCache(ctx.dataDir), chosen.version, chosen.bin,
                { persist: false, cwd, providerConfig: name === 'zcode' ? null : undefined })
            native = menu?.native_defaults ?? await readEndpointNativeDefaults(manifest, chosen.bin, name === 'zcode' ? null : undefined, cwd)
            if (name === 'zcode') resources = (await prepareZcodeRuntime(found.candidates.find(p => p.endpoint_bin === chosen.bin)!, process.env, cwd, null)).check
        } catch (e) { error = e instanceof Error ? e.message : String(e) }
    }
    return { name, candidates, selected_bin: chosen?.bin ?? null, selection_required: selectionRequired, version_error: chosen?.version_error ?? null, checked: found.checked, runtime_resources: resources,
        native_defaults: native, configured_defaults: { model: ctx.config.defaults.models[name] ?? null, effort: ctx.config.defaults.efforts[name] ?? null,
            provider_config: ctx.config.endpoints.overrides[name]?.provider_config ?? null },
        connections: menu?.connections ?? [], models: (menu?.models ?? []).map(m => ({ ...m,
            current: m.alias === native?.model || m.connection === native?.connection && m.resolved_model != null && m.resolved_model === native?.model })),
        selection_context: menu?.selection_context ?? native?.selection_context, notes: [...found.notes, ...(menu?.notes ?? native?.notes ?? [])], error }
}

export async function installationHosts() {
    const registry = await loadHostRegistry(pkgRoot)
    return { registry, hosts: await detectHosts(registry, process.env.PAIDAN_HOST_HOME ?? os.homedir()) }
}

export function choicesTemplate(ctx: InstallationContext, endpoints: Awaited<ReturnType<typeof surveyInstallation>>[]) {
    return { endpoints: Object.fromEntries(endpoints.map(e => [e.name, {
        ...(e.selected_bin ? { bin: e.selected_bin } : {}),
        ...(e.configured_defaults.provider_config || e.configured_defaults.model || e.configured_defaults.effort ? {} : { native: true }),
    }])), ...(ctx.config.defaults.endpoint ? { default_endpoint: ctx.config.defaults.endpoint } : {}), hosts: [] }
}

export async function planInstallation(ctx: InstallationContext, choices: Choices, cwd: string,
    surveyed?: Awaited<ReturnType<typeof surveyInstallation>>[]) {
    choices = parseChoices(choices, ctx)
    const endpoints = surveyed ?? await Promise.all(Object.entries(choices.endpoints).filter(([, c]) => c.enabled !== false).map(([name, c]) => surveyInstallation(ctx, name, c, cwd)))
    const { registry: hostRegistry, hosts } = await installationHosts()
    const original = await readOptionalBytes(ctx.configPath)
    const next = original ? JSON.parse(original.toString('utf8')) : {}
    next.endpoints ??= {}; next.endpoints.overrides ??= {}; next.defaults ??= {}
    for (const key of ['models', 'efforts', 'selection_contexts', 'modes']) next.defaults[key] ??= {}
    const names = Object.keys(choices.endpoints), enabled = names.filter(n => choices.endpoints[n].enabled !== false)
    const disabled = names.filter(n => choices.endpoints[n].enabled === false)
    if (!original || Array.isArray(next.endpoints.enabled) || disabled.length) next.endpoints.enabled = [...new Set([...(next.endpoints.enabled ?? (original ? ctx.registry.list().map(m => m.name) : [])), ...enabled])].filter(n => !disabled.includes(n))
    if (choices.default_endpoint === null) delete next.defaults.endpoint
    else if (choices.default_endpoint !== undefined) next.defaults.endpoint = choices.default_endpoint
    else if (!next.defaults.endpoint && enabled.length === 1) next.defaults.endpoint = enabled[0]
    if (choices.default_endpoint === undefined && !next.defaults.endpoint && enabled.length > 1) throw new PaidanError('SETUP_INVALID', '请在最后的配置摘要中选一个 default_endpoint。')
    if (next.defaults.endpoint && (!ctx.registry.list().some(m => m.name === next.defaults.endpoint) || Array.isArray(next.endpoints.enabled) && !next.endpoints.enabled.includes(next.defaults.endpoint))) throw new PaidanError('SETUP_INVALID', '默认端点必须存在且已启用。')

    const files: InstallationFile[] = []
    const decisions: unknown[] = disabled.map(endpoint => ({ endpoint, enabled: false, kept_saved_selection: true }))
    const receipt = await readInstallationReceipt(ctx.configPath)
    const addFile = async (root: string, target: string, payload: string, kind: string, owner?: string) => {
        if (!files.some(f => f.target === target)) files.push(await installationFile(root, target, payload, kind, owner))
    }
    for (const e of endpoints) {
        if (!e.selected_bin) throw new PaidanError('SETUP_CHOICE_REQUIRED', `${e.name} 需要选择有效入口。`, { endpoint: e.name, candidates: e.candidates })
        if (e.version_error) throw new PaidanError('SETUP_VERSION_FAILED', `${e.name} ${e.version_error}；入口已选定，请检查该程序的运行环境。`, { bin: e.selected_bin })
        const c = choices.endpoints[e.name], manifest = ctx.registry.get(e.name)
        next.endpoints.overrides[e.name] = { ...next.endpoints.overrides[e.name], bin: e.selected_bin }
        if (c.mode !== undefined) {
            if (c.mode === null) delete next.defaults.modes[e.name]
            else {
                const check = checkPermission(manifest, c.mode)
                if (!check.ok) throw new PaidanError('PERMISSION_UNSUPPORTED', `${e.name} 不支持 ${c.mode}。`, check)
                next.defaults.modes[e.name] = c.mode
            }
        }
        if (c.native_settings) {
            const file = dshSettingsPath(), raw = await readOptionalBytes(file)
            if (!raw) throw new PaidanError('SETUP_NATIVE_UNSUPPORTED', 'DSH 原生设置不存在，请先通过 DSH 配置接入。')
            const payload = updateDshSettings(raw.toString('utf8'), c.native_settings)
            await addFile(path.dirname(file), file, payload, 'dsh-settings', 'dsh')
            decisions.push({ endpoint: 'dsh', native_settings: c.native_settings, affects_other_native_sessions: true, model_access_and_effort_unverified: true })
        }
        if (c.native || c.native_settings) {
            for (const key of ['models', 'efforts', 'selection_contexts']) delete next.defaults[key][e.name]
            if (e.name === 'zcode') delete next.endpoints.overrides.zcode.provider_config
        } else if (c.model !== undefined || c.effort !== undefined || c.provider !== undefined) {
            let model = c.model === undefined ? next.defaults.models[e.name] ?? null : c.model
            const effort = c.effort === undefined ? next.defaults.efforts[e.name] ?? null : c.effort
            if (model !== null) {
                const exact = e.models.filter(m => m.alias === model)
                const matches = exact.length ? exact : e.models.filter(m => m.label === model)
                const zcode = c.provider && e.models.find(m => m.alias === `${c.provider}/${model}`)
                if (!zcode && matches.length !== 1) throw new PaidanError('MODEL_UNAVAILABLE', `${e.name} 模型无法唯一对应，请从当前完整菜单选择，不使用近似值。`, { models: e.models, error: e.error })
                model = zcode ? zcode.alias : matches[0].alias
                assertSafeSubstitutionValue(model, 'model')
            }
            const selected = e.models.find(m => m.alias === (model ?? e.native_defaults?.model))
            if (effort !== null && (!selected || selected.effort_selectable === false || !selected.effort_options?.includes(effort)
                || e.native_defaults?.thinking_enabled === false && !selected.thinking_required)) throw new PaidanError('EFFORT_INVALID', `${e.name} 请从所选模型的强度菜单选择，未知时可跟随原生。`, { model, effort, models: e.models, error: e.error })
            if (c.provider) {
                if (!model || !effort || selected?.connection !== c.provider || !e.connections.some(p => p.id === c.provider && p.auth_type === 'api-key')) throw new PaidanError('SETUP_INVALID', 'ZCode 专用配置需要所选启用 API provider 的模型和强度。')
                const source = providerConfigPath(process.env, null)
                await checkInstallationTarget(zcodeHome(), source)
                const selection = { provider: c.provider, model: model.slice(c.provider.length + 1), effort }
                const profile = buildZcodeProfile(await readProviderConfig(source), selection)
                const target = path.join(zcodeHome(), 'paidan', 'provider_config.json')
                await addFile(zcodeHome(), target, JSON.stringify(profile, null, 2) + '\n', 'zcode-provider', 'zcode')
                next.endpoints.overrides.zcode.provider_config = target
                for (const key of ['models', 'efforts', 'selection_contexts']) delete next.defaults[key].zcode
                decisions.push({ endpoint: e.name, bin: e.selected_bin, fixed: selection, provider_config: target, contains_native_api_credentials: true })
                continue
            }
            if (model !== null && !manifest.command.model_arg || effort !== null && !supportsEffort(manifest, effort)) throw new PaidanError('SETUP_INVALID', `${e.name} 不支持此模型/强度覆盖；请选择跟随原生。`)
            for (const [key, value] of [['models', model], ['efforts', effort]]) {
                if (value === null) delete next.defaults[key!][e.name]
                else next.defaults[key!][e.name] = value
            }
            if (manifest.models?.bind_selection && (model || effort)) {
                if (!e.selection_context) throw new PaidanError('SETUP_INVALID', `${e.name} 当前配置摘要不可用，不能固定。`)
                next.defaults.selection_contexts[e.name] = e.selection_context
            } else delete next.defaults.selection_contexts[e.name]
        }
        decisions.push({ endpoint: e.name, bin: e.selected_bin, model: next.defaults.models[e.name] ?? null,
            effort: next.defaults.efforts[e.name] ?? null, mode: next.defaults.modes[e.name] ?? manifest.permission.default_mode ?? 'workspace-write',
            provider_config: next.endpoints.overrides[e.name].provider_config ?? null, notes: e.notes, runtime_resources: e.runtime_resources, error: e.error })
    }
    for (const requested of choices.hosts ?? []) {
        const name = typeof requested === 'string' ? requested : requested.name
        const host = hosts.find(h => h.name === name)
        if (!host) throw new PaidanError('SETUP_INVALID', `未知宿主 ${name}。`)
        const payload = adaptSkillPayload(await fs.readFile(path.join(pkgRoot, host.source ?? hostRegistry.skill.source), 'utf8'), host.frontmatter_fields)
        const file = await installationFile(host.skills_dir, host.target, payload, 'skill', name)
        if (file.before && file.before !== fileDigest(payload) && (typeof requested === 'string' || !requested.replace)) throw new PaidanError('SETUP_SKILL_CONFLICT', `${name} 已有不同的 skill，先展示差异让用户选择保留或更新；更新时 hosts 使用 {name, replace:true}。`, { target: host.target })
        if (!files.some(f => f.target === file.target)) files.push(file)
    }
    parseConfig(next)
    if (names.length || choices.default_endpoint !== undefined) {
        await addFile(path.dirname(ctx.configPath), ctx.configPath, JSON.stringify(next, null, 2) + '\n', 'config')
        const previousEntries = receipt.value.files[ctx.configPath]?.entries ?? {}
        files.at(-1)!.entries = Object.fromEntries([
            ...endpoints.map(e => {
                const candidate = e.candidates.find(c => c.bin === e.selected_bin)!
                const previous = previousEntries[e.name]
                return [e.name, { enabled: true, ...candidate, source: candidate.source === 'config-override' && previous?.bin === candidate.bin ? previous.source ?? candidate.source : candidate.source }] as const
            }),
            ...disabled.map(name => [name, { ...previousEntries[name], enabled: false }] as const),
        ])
    }
    const confirmation = selectionContext([files.map(f => [f.kind, f.target, f.before, fileDigest(f.payload)]), receipt.before])
    const preview = { config_path: ctx.configPath, decisions, default_endpoint: next.defaults.endpoint ?? null, files: previewFiles(files),
        receipt: { path: receipt.target, action: 'merge-completed-writes' }, confirmation }
    return { files, preview, receipt }
}

export async function applyInstallation(plan: Awaited<ReturnType<typeof planInstallation>>, expect: string) {
    const { files, preview, receipt } = plan
    if (expect !== preview.confirmation && !files.every(f => f.before === fileDigest(f.payload))) throw new PaidanError('SETUP_CHANGED', '选择、原生配置或目标文件已变化，请查看新的摘要；尚未写入。', preview)
    const version = (JSON.parse(await fs.readFile(path.join(pkgRoot, 'package.json'), 'utf8')) as { version: string }).version
    const result = await applyInstallationFiles(files, receipt, version)
    return { applied: true, ...preview, ...result, guidance: '配置与安装记录已保存，未调用模型。未登录或暂无额度的端点可保留；首次真实任务再验证调用。' }
}
