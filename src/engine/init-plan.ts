// init wizard logic, UI-free so a future GUI console reuses it. The CLI shell
// gathers detection info (spawn plan + model discovery) and owns readline;
// this module turns answers into a config.json object.

export interface InitEndpointInfo {
    name: string
    detected: boolean
    version: string | null
    models: Array<{ alias: string; connection: string | null }>
}

export interface InitAnswers {
    enabled: string[]
    default_endpoint: string | null
    default_model: string | null
    /** hosts selected for the paidan skill install (validated against detected hosts) */
    skill_hosts: string[]
}

export interface InitConfig {
    endpoints: { enabled: string[] }
    defaults: { endpoint: string | null; model: string | null }
}

/** --yes semantics: enable every detected endpoint; default = first detected; model = its first; install the skill into every detected host. */
export function defaultInitAnswers(info: InitEndpointInfo[], detectedHosts: string[] = []): InitAnswers {
    const enabled = info.filter((e) => e.detected).map((e) => e.name)
    const first = info.find((e) => e.detected)
    return {
        enabled,
        default_endpoint: first?.name ?? null,
        default_model: first && first.models.length > 0 ? (first.models[0]?.alias ?? null) : null,
        skill_hosts: detectedHosts,
    }
}

/** Answers are validated against reality: enabled ⊆ known, default ∈ enabled, model ∈ its models. */
export function buildInitConfig(info: InitEndpointInfo[], answers: InitAnswers): InitConfig {
    const known = new Set(info.map((e) => e.name))
    for (const name of answers.enabled) {
        if (!known.has(name)) throw new Error(`cannot enable unknown endpoint "${name}"`)
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
    return {
        endpoints: { enabled: answers.enabled },
        defaults: { endpoint: answers.default_endpoint, model: answers.default_endpoint ? answers.default_model : null },
    }
}

/** The JSON written to config.json; absent keys keep built-in defaults. */
export function initConfigToJson(cfg: InitConfig): Record<string, unknown> {
    const defaults: Record<string, unknown> = {}
    if (cfg.defaults.endpoint !== null) defaults.endpoint = cfg.defaults.endpoint
    if (cfg.defaults.model !== null) defaults.model = cfg.defaults.model
    const out: Record<string, unknown> = { endpoints: { enabled: cfg.endpoints.enabled } }
    if (Object.keys(defaults).length > 0) out.defaults = defaults
    return out
}

/**
 * Merge fresh init answers into an existing config.json document: only
 * endpoints.enabled and defaults are replaced; machine-local keys the wizard
 * does not own (endpoints.overrides, dataDir, run_timeout_sec, ...) survive a
 * re-init verbatim.
 */
export function mergeInitConfig(existing: Record<string, unknown>, cfg: InitConfig): Record<string, unknown> {
    const fresh = initConfigToJson(cfg)
    const existingEndpoints = (existing.endpoints ?? {}) as Record<string, unknown>
    return {
        ...existing,
        ...('defaults' in fresh ? { defaults: fresh.defaults } : {}),
        endpoints: { ...existingEndpoints, enabled: cfg.endpoints.enabled },
    }
}
