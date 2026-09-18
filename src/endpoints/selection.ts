// Selection checks shared by normal delegation and probes. No dispatch, writes or fallback.
import type { PaidanConfig } from '../engine/config.js'
import type { RunRequest } from '../engine/types.js'
import { PaidanError } from '../engine/errors.js'
import { supportsEffort } from './invocation.js'
import { loadParserModule } from './adapters.js'
import type { EndpointManifest } from './registry.js'
import { readEndpointNativeDefaults } from './inspection.js'
import type { NativeDefaults } from './parser-api.js'

interface SelectionOptions {
    cwd?: string
    model?: string
    effort?: string
    native?: boolean
    'selection-context'?: string
}

type Selection = Pick<RunRequest, 'model' | 'effort' | 'provider_config' | 'selection_context' | 'native_selection'>

export async function resolveSelection(config: PaidanConfig, manifest: EndpointManifest, options: SelectionOptions = {}): Promise<Selection> {
    const endpoint = manifest.name
    const cwd = options.cwd
    if (options.native && (options.model !== undefined || options.effort !== undefined || options['selection-context'] !== undefined)) {
        throw new PaidanError('ARGS_INVALID', '--native cannot be combined with --model/--effort/--selection-context')
    }
    if (options['selection-context'] !== undefined && (!manifest.models?.bind_selection || !/^sha256:[a-f0-9]{64}$/.test(options['selection-context']))) {
        throw new PaidanError('ARGS_INVALID', '--selection-context requires an endpoint with configuration binding and the sha256 value returned by paidan models')
    }
    const model = options.native ? null : options.model ?? config.defaults.models[endpoint] ?? null
    const effort = options.native ? null : options.effort ?? config.defaults.efforts[endpoint] ?? null
    if (model !== null && !manifest.command.model_arg) {
        throw new PaidanError('MODEL_UNSUPPORTED', `endpoint "${endpoint}" has no headless model selection (its native config owns the model), but "${model}" is configured. Repair: remove defaults.models.${endpoint} from config.json, or don't pass --model.`)
    }
    if (effort !== null && !manifest.effort) {
        throw new PaidanError('EFFORT_UNSUPPORTED', `endpoint "${endpoint}" has no effort selection (native default only). Repair: remove defaults.efforts.${endpoint} / defaults.effort from config.json, or don't pass --effort.`)
    }
    if (effort !== null && !supportsEffort(manifest, effort)) {
        throw new PaidanError('EFFORT_INVALID', `effort "${effort}" is not one of ${endpoint}'s options: ${manifest.effort!.options.join(', ')}`)
    }
    let inspected: NativeDefaults | undefined
    if (manifest.models?.parse && (model !== null || effort !== null)) {
        const adapter = await loadParserModule(manifest.parser)
        inspected = await adapter.validateSelection?.({ model, effort }, { configBin: config.endpoints.overrides[endpoint]?.bin ?? null, cwd })
    }
    const providerConfig = endpoint === 'zcode' ? (options.native ? null : config.endpoints.overrides.zcode?.provider_config) : undefined
    const native = inspected ?? await readEndpointNativeDefaults(manifest, config.endpoints.overrides[endpoint]?.bin ?? null, providerConfig, cwd)
    let context: string | undefined
    if (manifest.models?.bind_selection && (model !== null || effort !== null)) {
        context = native?.selection_context
        const usesSaved = options.model === undefined && model !== null || options.effort === undefined && effort !== null
        const approved = options['selection-context'] ?? (usesSaved ? config.defaults.selection_contexts[endpoint] : context)
        if (!context || approved !== context) {
            throw new PaidanError('SELECTION_RECONFIRM_REQUIRED',
                `${endpoint} 固定选择的原生配置已变化，或尚未绑定当前配置。任务尚未派发。请查询当前配置/模型并让用户选择跟随原生、重新固定或暂停；不得自动覆盖旧选择。`,
                { endpoint, requested: { model, effort }, native_defaults: native,
                    query: `paidan models --endpoint ${endpoint}`, user_choice_required: true })
        }
    }
    return {
        model, effort,
        ...(providerConfig !== undefined ? { provider_config: providerConfig } : {}),
        ...(context ? { selection_context: context } : {}),
        ...(native ? { native_selection: { connection: native.connection ?? null, model: native.model ?? null, effort: native.effort ?? null, profile: native.profile ?? null } } : {}),
    }
}
