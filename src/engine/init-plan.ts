// init wizard logic, UI-free so a future GUI console reuses it. The CLI shell
// gathers detection info (spawn plan + model discovery) and owns readline;
// this module turns answers into a config.json object.

export interface InitEndpointInfo {
    name: string
    detected: boolean
    version: string | null
    models: Array<{ alias: string; connection: string | null }>
    /** spawn-resolution repair hint when not detected (last resolver note) */
    repair?: string | null
}

export interface InitAnswers {
    enabled: string[]
    default_endpoint: string | null
    default_model: string | null
    /** per-endpoint default models (enabled endpoints with discovered models); absent key = native default */
    models?: Record<string, string | null>
    /** hosts selected for the paidan skill install (validated against detected hosts) */
    skill_hosts: string[]
}

export interface InitConfig {
    endpoints: { enabled: string[] }
    defaults: { endpoint: string | null; model: string | null; models: Record<string, string> }
}

/** --yes semantics: enable every detected endpoint; default = first detected; each detected endpoint's first discovered model becomes its default; install the skill into every detected host. */
export function defaultInitAnswers(info: InitEndpointInfo[], detectedHosts: string[] = []): InitAnswers {
    const enabled = info.filter((e) => e.detected).map((e) => e.name)
    const first = info.find((e) => e.detected)
    const models: Record<string, string | null> = {}
    for (const e of info) {
        if (e.detected && e.models.length > 0) models[e.name] = e.models[0]?.alias ?? null
    }
    return {
        enabled,
        default_endpoint: first?.name ?? null,
        default_model: first && first.models.length > 0 ? (first.models[0]?.alias ?? null) : null,
        models,
        skill_hosts: detectedHosts,
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

/** Answers are validated against reality: enabled ⊆ detected, default ∈ enabled, every model ∈ its own endpoint's models. */
export function buildInitConfig(info: InitEndpointInfo[], answers: InitAnswers): InitConfig {
    const detected = new Map(info.filter((e) => e.detected).map((e) => [e.name, e]))
    for (const name of answers.enabled) {
        if (!detected.has(name)) throw new Error(`cannot enable endpoint "${name}": not detected on this machine`)
    }
    if (answers.default_endpoint !== null) {
        if (!answers.enabled.includes(answers.default_endpoint)) {
            throw new Error(`default endpoint "${answers.default_endpoint}" is not enabled`)
        }
        if (answers.default_model !== null) {
            const ep = info.find((e) => e.name === answers.default_endpoint)
            const aliases = new Set((ep?.models ?? []).map((m) => m.alias))
            if (aliases.size > 0 && !aliases.has(answers.default_model)) {
                throw new Error(`model "${answers.default_model}" is not a discovered alias of ${answers.default_endpoint}`)
            }
        }
    }
    const models: Record<string, string> = {}
    for (const [name, model] of Object.entries(answers.models ?? {})) {
        if (model === null) continue
        if (!answers.enabled.includes(name)) {
            throw new Error(`default model given for endpoint "${name}" which is not enabled`)
        }
        const ep = detected.get(name)
        if (!ep) throw new Error(`default model given for endpoint "${name}": not detected on this machine`)
        const aliases = new Set(ep.models.map((m) => m.alias))
        if (aliases.size > 0 && !aliases.has(model)) {
            throw new Error(`model "${model}" is not a discovered alias of ${name}`)
        }
        models[name] = model
    }
    return {
        endpoints: { enabled: answers.enabled },
        defaults: { endpoint: answers.default_endpoint, model: answers.default_endpoint ? answers.default_model : null, models },
    }
}

/** The JSON written to config.json; absent keys keep built-in defaults. */
export function initConfigToJson(cfg: InitConfig): Record<string, unknown> {
    const defaults: Record<string, unknown> = {}
    if (cfg.defaults.endpoint !== null) defaults.endpoint = cfg.defaults.endpoint
    if (cfg.defaults.model !== null) defaults.model = cfg.defaults.model
    if (Object.keys(cfg.defaults.models).length > 0) defaults.models = cfg.defaults.models
    const out: Record<string, unknown> = { endpoints: { enabled: cfg.endpoints.enabled } }
    if (Object.keys(defaults).length > 0) out.defaults = defaults
    return out
}

/**
 * Merge fresh init answers into an existing config.json document: only
 * endpoints.enabled and the wizard-owned defaults keys (endpoint, model,
 * models) are replaced; machine-local keys the wizard does not own
 * (endpoints.overrides, dataDir, defaults.run_timeout_sec, ...) survive a
 * re-init verbatim.
 */
export function mergeInitConfig(existing: Record<string, unknown>, cfg: InitConfig): Record<string, unknown> {
    const fresh = initConfigToJson(cfg)
    const existingEndpoints = (existing.endpoints ?? {}) as Record<string, unknown>
    const existingDefaults = { ...((existing.defaults ?? {}) as Record<string, unknown>) }
    // wizard-owned keys are cleared first so a stale one never survives an
    // answer that no longer sets it (e.g. re-init onto a model-less endpoint)
    for (const key of ['endpoint', 'model', 'models']) delete existingDefaults[key]
    const mergedDefaults = { ...existingDefaults, ...((fresh.defaults ?? {}) as Record<string, unknown>) }
    const out: Record<string, unknown> = {
        ...existing,
        endpoints: { ...existingEndpoints, enabled: cfg.endpoints.enabled },
    }
    if (Object.keys(mergedDefaults).length > 0) out.defaults = mergedDefaults
    else delete out.defaults
    return out
}
