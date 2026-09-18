// Pure question/default helpers for the optional terminal UI.
// Configuration validation, merging and persistence live in installation.ts.

import type { PaidanConfig } from './config.js'

export interface InitEndpointInfo {
    name: string
    bin?: string | null
    detected: boolean
    version: string | null
    models: Array<{ alias: string; connection: string | null }>
    /** the endpoint can take a model on its headless argv (manifest command.model_arg); discovery may still exist for information only (zcode/dsh) */
    model_selectable?: boolean
    /** declared effort options from the manifest (null = no effort selection for this endpoint) */
    effort_options?: string[] | null
    /** read-only native-home probe: the model/effort the endpoint's own config currently carries (null = no probed surface; unset keys = null) */
    native?: { model?: string | null; effort?: string | null; selection_context?: string; notes?: string[] } | null
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
    const existingModel = config.defaults.models[name] ?? null
    let model: EndpointDefaultQuestions['model']
    if (ep.model_selectable === false) {
        model = { kind: 'skip-no-selection' }
    } else if (aliases.length === 0) {
        if (existingModel) {
            // discovery came back empty but a hand-set default exists — silently
            // dropping it would lose config the user wrote (codex F3); ask
            // keep-vs-native instead, preselecting keep (enter = keep)
            model = {
                kind: 'ask',
                options: [nativeModelLabel, `(keep current: ${existingModel})`],
                fallback: `(keep current: ${existingModel})`,
                staleModelValue: existingModel,
            }
        } else {
            model = { kind: 'skip-none' }
        }
    } else {
        // every model-selectable endpoint asks, single-candidate included: a
        // wizard-side default is an override layer that silently changes native
        // behavior (a single-candidate auto-pick once masked a hand-tuned opus).
        // First choice = native; a configured value inside the lineup preselects;
        // a configured value OUTSIDE the lineup stays selectable via a
        // "(keep current: X)" entry, and that entry is the fallback — enter keeps
        // the current value, native is always an explicit pick (codex F3).
        const staleModelValue = existingModel && !aliases.includes(existingModel) ? existingModel : null
        const keepLabel = staleModelValue ? `(keep current: ${staleModelValue})` : null
        const fallback = existingModel && aliases.includes(existingModel) ? existingModel : (keepLabel ?? nativeModelLabel)
        model = {
            kind: 'ask',
            options: [
                nativeModelLabel,
                ...aliases,
                ...(keepLabel ? [keepLabel] : []),
            ],
            fallback,
            staleModelValue,
        }
    }
    let effort: EndpointDefaultQuestions['effort']
    const effOpts = ep.effort_options ?? null
    if (effOpts && effOpts.length > 0) {
        const existingEff = config.defaults.efforts[name] ?? null
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
