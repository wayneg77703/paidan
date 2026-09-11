// init wizard logic, UI-free so a future GUI console reuses it. The CLI shell
// gathers detection info (spawn plan + model discovery) and owns readline;
// this module turns answers into a config.json object.

import { WIZARD_DEFAULTS_KEYS } from './config.js'
import type { PaidanConfig } from './config.js'

export interface InitEndpointInfo {
    name: string
    detected: boolean
    version: string | null
    models: Array<{ alias: string; connection: string | null }>
    /** the endpoint can take a model on its headless argv (manifest command.model_arg); discovery may still exist for information only (zcode/dsh) */
    model_selectable?: boolean
    /** declared effort options from the manifest (null = no effort selection for this endpoint) */
    effort_options?: string[] | null
    /** read-only native-home probe: the model/effort the endpoint's own config currently carries (null = no probed surface; unset keys = null) */
    native?: { model?: string | null; effort?: string | null; notes?: string[] } | null
    /** spawn-resolution repair hint when not detected (last resolver note) */
    repair?: string | null
}

export interface InitAnswers {
    enabled: string[]
    default_endpoint: string | null
    /** per-endpoint default models (enabled endpoints with discovered models); absent key = native default */
    models?: Record<string, string | null>
    /** per-endpoint default efforts (enabled endpoints with declared effort options); absent key = native default */
    efforts?: Record<string, string | null>
    /** hosts selected for the paidan skill install (validated against detected hosts) */
    skill_hosts: string[]
}

export interface InitConfig {
    endpoints: { enabled: string[] }
    defaults: { endpoint: string | null; models: Record<string, string>; efforts: Record<string, string> }
}

/**
 * --yes semantics: enable every detected endpoint, default = first detected,
 * and leave every model/effort at the endpoint's native default — the agent's
 * own home already carries those values, and a paidan-side first-discovered
 * default is an override layer that silently changes native behavior (a wizard
 * 'first model' once masked a hand-tuned native opus). An `effort` preference
 * applies the value to every detected endpoint whose declared options include
 * it (endpoints without that level stay native). The skill installs into every
 * detected host, unless hostsFilter narrows it (init --yes --hosts a,b —
 * codex P1-03: an agent-collected subset must be faithfully installed).
 */
export function defaultInitAnswers(
    info: InitEndpointInfo[],
    detectedHosts: string[] = [],
    effortPreference?: string,
    hostsFilter: string[] | null = null,
): InitAnswers {
    const enabled = info.filter((e) => e.detected).map((e) => e.name)
    const first = info.find((e) => e.detected)
    const efforts: Record<string, string | null> = {}
    if (effortPreference !== undefined) {
        for (const e of info) {
            if (e.detected && e.effort_options?.includes(effortPreference)) efforts[e.name] = effortPreference
        }
    }
    const skillHosts = hostsFilter !== null
        ? detectedHosts.filter((h) => hostsFilter.includes(h))
        : detectedHosts
    return {
        enabled,
        default_endpoint: first?.name ?? null,
        models: {},
        efforts,
        skill_hosts: skillHosts,
    }
}

/** Parse a multi-select answer: "" = fallback, all/a, none/n, or 1-based numbers separated by space/comma. Returns sorted 0-based indexes. */
export function parseMultiSelect(input: string, count: number, fallback: number[]): number[] {
    const t = input.trim().toLowerCase()
    if (t === '') return fallback
    if (t === 'all' || t === 'a') return Array.from({ length: count }, (_, i) => i)
    if (t === 'none' || t === 'n') return []
    const parts = t.split(/[\s,]+/)
    const nums = parts.map((p) => Number(p))
    if (nums.some((n) => !Number.isInteger(n) || n < 1 || n > count)) {
        throw new Error(`invalid selection "${input}"; use numbers 1-${count}, all, or none`)
    }
    return [...new Set(nums.map((n) => n - 1))].sort((a, b) => a - b)
}

/**
 * What the wizard should ask for one endpoint's default model and effort,
 * derived from detection info and the current config. UI-free (the raw-mode
 * wizard, the line fallback, and a future GUI all render this one plan).
 */
export interface EndpointDefaultQuestions {
    model:
        | { kind: 'skip-no-selection' } // endpoint cannot take a model headless; its native config owns it
        | { kind: 'skip-none' } // no discovered models; native default
        | { kind: 'ask'; options: string[]; fallback: string; staleModelValue: string | null }
    effort:
        | { kind: 'skip' } // endpoint declares no effort block; native default
        | { kind: 'ask'; options: string[]; fallback: string; staleValue: string | null }
    /** label of the "leave it to the native home" effort choice: '(native default)' or '(native default, currently max)' when the read-only probe saw a value */
    nativeEffortLabel: string
    /** sentence-fragment twin for skip notes: "native default" / "native default, currently max" (no nested parens) */
    nativeEffortNote: string
    /** label of the "leave it to the native home" model choice ('(native default)' / '(native default, currently opus)') */
    nativeModelLabel: string
    /** the native home's current model (from the read-only probe), shown on skip notes; null = unset/unprobed */
    nativeModel: string | null
}

export const NATIVE_DEFAULT_LABEL = '(native default)'

export function nativeEffortLabelFor(nativeEffort: string | null | undefined): string {
    return nativeEffort ? `(native default, currently ${nativeEffort})` : NATIVE_DEFAULT_LABEL
}

/** Sentence-fragment twin of the label, for skip notes: "native default" / "native default, currently max" (no nested parens). */
export function nativeEffortNoteFor(nativeEffort: string | null | undefined): string {
    return nativeEffort ? `native default, currently ${nativeEffort}` : 'native default'
}

/** Model twin: '(native default)' / '(native default, currently opus)'. */
export function nativeModelLabelFor(nativeModel: string | null | undefined): string {
    return nativeModel ? `(native default, currently ${nativeModel})` : NATIVE_DEFAULT_LABEL
}

export function planEndpointDefaultQuestions(ep: InitEndpointInfo, config: PaidanConfig): EndpointDefaultQuestions {
    const name = ep.name
    const aliases = ep.models.map((m) => m.alias)
    const nativeModelLabel = nativeModelLabelFor(ep.native?.model)
    const existingModel = config.defaults.models[name] ?? (name === config.defaults.endpoint ? config.defaults.model : null)
    let model: EndpointDefaultQuestions['model']
    if (ep.model_selectable === false || aliases.length === 0) {
        // nothing to ask: the native config owns the model (no headless selection,
        // or discovery found nothing — an override without a menu entry would be
        // a silent behavior change, so a found-nothing run keeps/stays native)
        model = { kind: ep.model_selectable === false ? 'skip-no-selection' : 'skip-none' }
    } else {
        // every model-selectable endpoint asks, single-candidate included: a
        // wizard-side default is an override layer that silently changes native
        // behavior (a single-candidate auto-pick once masked a hand-tuned opus).
        // First choice = native; a configured value inside the lineup preselects;
        // a configured value OUTSIDE the lineup (hand-set, discovery missed it)
        // stays selectable via a "(keep current: X)" entry.
        const staleModelValue = existingModel && !aliases.includes(existingModel) ? existingModel : null
        const fallback = existingModel && aliases.includes(existingModel) ? existingModel : nativeModelLabel
        model = {
            kind: 'ask',
            options: [
                nativeModelLabel,
                ...aliases,
                ...(staleModelValue ? [`(keep current: ${staleModelValue})`] : []),
            ],
            fallback,
            staleModelValue,
        }
    }
    let effort: EndpointDefaultQuestions['effort']
    const effOpts = ep.effort_options ?? null
    if (effOpts && effOpts.length > 0) {
        const existingEff = config.defaults.efforts[name] ?? config.defaults.effort
        const staleValue = existingEff && !effOpts.includes(existingEff) ? existingEff : null
        const fallback = existingEff && effOpts.includes(existingEff) ? existingEff : nativeEffortLabelFor(ep.native?.effort)
        effort = { kind: 'ask', options: [nativeEffortLabelFor(ep.native?.effort), ...effOpts], fallback, staleValue }
    } else {
        effort = { kind: 'skip' }
    }
    return {
        model,
        effort,
        nativeEffortLabel: nativeEffortLabelFor(ep.native?.effort),
        nativeEffortNote: nativeEffortNoteFor(ep.native?.effort),
        nativeModelLabel,
        nativeModel: ep.native?.model ?? null,
    }
}

/** Answers are validated against reality: enabled ⊆ detected, default ∈ enabled, every model ∈ its own endpoint's models (or the hand-set value being kept — discovery misses do not delete config) and only where the endpoint can take one headless, every effort ∈ its own endpoint's declared options. Pass the current config so keep-current model values survive the check. */
export function buildInitConfig(info: InitEndpointInfo[], answers: InitAnswers, config?: PaidanConfig): InitConfig {
    const detected = new Map(info.filter((e) => e.detected).map((e) => [e.name, e]))
    for (const name of answers.enabled) {
        if (!detected.has(name)) throw new Error(`cannot enable endpoint "${name}": not detected on this machine`)
    }
    if (answers.default_endpoint !== null && !answers.enabled.includes(answers.default_endpoint)) {
        throw new Error(`default endpoint "${answers.default_endpoint}" is not enabled`)
    }
    const models: Record<string, string> = {}
    for (const [name, model] of Object.entries(answers.models ?? {})) {
        if (model === null) continue
        if (!answers.enabled.includes(name)) {
            throw new Error(`default model given for endpoint "${name}" which is not enabled`)
        }
        const ep = detected.get(name)
        if (!ep) throw new Error(`default model given for endpoint "${name}": not detected on this machine`)
        if (ep.model_selectable === false) {
            throw new Error(`endpoint "${name}" has no headless model selection (its native config owns the model)`)
        }
        const aliases = new Set(ep.models.map((m) => m.alias))
        // a value outside the lineup is legal only when it is the kept current one
        const keptCurrent = config?.defaults.models[name] ?? null
        if (aliases.size > 0 && !aliases.has(model) && model !== keptCurrent) {
            throw new Error(`model "${model}" is not a discovered alias of ${name}`)
        }
        models[name] = model
    }
    const efforts: Record<string, string> = {}
    for (const [name, effort] of Object.entries(answers.efforts ?? {})) {
        if (effort === null) continue
        if (!answers.enabled.includes(name)) {
            throw new Error(`default effort given for endpoint "${name}" which is not enabled`)
        }
        const ep = detected.get(name)
        if (!ep) throw new Error(`default effort given for endpoint "${name}": not detected on this machine`)
        const options = ep.effort_options ?? null
        if (!options) throw new Error(`endpoint "${name}" has no effort selection`)
        if (!options.includes(effort)) {
            throw new Error(`effort "${effort}" is not one of ${name}'s options: ${options.join(', ')}`)
        }
        efforts[name] = effort
    }
    return {
        endpoints: { enabled: answers.enabled },
        // note: InitConfig.defaults has no `model` — the wizard never writes the
        // global defaults.model (it poisons endpoints with no headless model
        // selection); per-endpoint defaults.models only.
        defaults: { endpoint: answers.default_endpoint, models, efforts },
    }
}

/** The JSON written to config.json; absent keys keep built-in defaults. */
export function initConfigToJson(cfg: InitConfig): Record<string, unknown> {
    const defaults: Record<string, unknown> = {}
    if (cfg.defaults.endpoint !== null) defaults.endpoint = cfg.defaults.endpoint
    if (Object.keys(cfg.defaults.models ?? {}).length > 0) defaults.models = cfg.defaults.models
    if (Object.keys(cfg.defaults.efforts ?? {}).length > 0) defaults.efforts = cfg.defaults.efforts
    const out: Record<string, unknown> = { endpoints: { enabled: cfg.endpoints.enabled } }
    if (Object.keys(defaults).length > 0) out.defaults = defaults
    return out
}

/**
 * Merge fresh init answers into an existing config.json document: only
 * endpoints.enabled and the wizard-owned defaults keys (endpoint, model,
 * models, efforts) are replaced; machine-local keys the wizard does not own
 * (endpoints.overrides, dataDir, defaults.run_timeout_sec, the hand-set
 * global defaults.effort, ...) survive a re-init verbatim.
 */
export function mergeInitConfig(existing: Record<string, unknown>, cfg: InitConfig): Record<string, unknown> {
    const fresh = initConfigToJson(cfg)
    const existingEndpoints = (existing.endpoints ?? {}) as Record<string, unknown>
    const existingDefaults = { ...((existing.defaults ?? {}) as Record<string, unknown>) }
    // wizard-owned keys (WIZARD_DEFAULTS_KEYS, single source in config.ts) are
    // cleared first so a stale one never survives an answer that no longer sets
    // it. 'model' is cleared deliberately: the wizard never writes the global
    // model (it poisons endpoints with no headless model selection), so re-init
    // self-heals a hand-set value. The global 'effort' is NOT wizard-owned
    // (no global effort menu) and survives like the machine-local keys.
    for (const key of WIZARD_DEFAULTS_KEYS) delete existingDefaults[key]
    const mergedDefaults = { ...existingDefaults, ...((fresh.defaults ?? {}) as Record<string, unknown>) }
    const out: Record<string, unknown> = {
        ...existing,
        endpoints: { ...existingEndpoints, enabled: cfg.endpoints.enabled },
    }
    if (Object.keys(mergedDefaults).length > 0) out.defaults = mergedDefaults
    else delete out.defaults
    return out
}
