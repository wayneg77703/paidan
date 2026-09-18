// Pure invocation rules: permissions, safe substitutions, argv and child environment.
import type { CapabilitySet, ModeSelection, PermissionPreset, RunRequest } from '../engine/types.js'
import { ManifestError, SAFE_SUBSTITUTION_VALUE_RE, type CapabilityStatus, type EndpointManifest } from './registry.js'

/** Capabilities each preset requires at submit time (contracts §2). */
export const PRESET_REQUIREMENTS: Readonly<Record<PermissionPreset, readonly string[]>> = {
    'read-only': ['fs.read'],
    'workspace-write': ['fs.read', 'fs.write'],
    unattended: ['fs.read', 'fs.write', 'shell.exec'],
}

export interface PermissionCheck {
    ok: boolean
    missing: string[]
    warnings: string[]
}

/** Probe tier (P1/P3 share one): most conservative supported preset; null = none (P1/P3 skip). */
export function pickProbePreset(manifest: EndpointManifest): PermissionPreset | null {
    for (const preset of ['workspace-write', 'unattended', 'read-only'] as const) {
        if (manifest.permission.presets[preset] === 'supported') return preset
    }
    return null
}

/** Validate a --capabilities JSON value: plain object, values true/false/object, ≥1 required key. */
export function parseCapabilitySet(value: unknown): CapabilitySet | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    let required = 0
    for (const [cap, req] of Object.entries(value as Record<string, unknown>)) {
        if (cap.trim() === '') return null
        if (req === false || req === null) continue
        if (req === true || (typeof req === 'object' && !Array.isArray(req))) {
            required++
            continue
        }
        return null
    }
    return required > 0 ? (value as CapabilitySet) : null
}

export function checkPermission(manifest: EndpointManifest, mode: ModeSelection): PermissionCheck {
    const missing: string[] = []
    const warnings: string[] = []
    const checkCap = (cap: string) => {
        const entry = manifest.permission[cap] as CapabilityStatus | undefined
        const status = entry?.status
        if (status === 'unsupported') {
            missing.push(cap)
        } else if (status === 'soft' || status === 'unverified' || status === undefined) {
            warnings.push(
                `permission:${cap} is ${status ?? 'undeclared'} on this endpoint` +
                (entry?.verified_at ? `, verified_at ${entry.verified_at}` : ''),
            )
        }
    }
    if (typeof mode !== 'string') {
        // explicit capability set: the truthy keys are the requirements; no preset
        // tier status applies (and no mode_args/mode_env tier flags are spliced)
        for (const [cap, req] of Object.entries(mode)) {
            if (req) checkCap(cap)
        }
        return { ok: missing.length === 0, missing, warnings }
    }
    const presetStatus = manifest.permission.presets[mode]
    if (presetStatus === 'unsupported') {
        missing.push(`preset:${mode}`)
    } else if (presetStatus === 'soft' || presetStatus === 'unverified' || presetStatus === undefined) {
        warnings.push(`preset ${mode} is ${presetStatus ?? 'undeclared'} on endpoint ${manifest.name}`)
    }
    for (const cap of PRESET_REQUIREMENTS[mode]) {
        checkCap(cap)
    }
    return { ok: missing.length === 0, missing, warnings }
}

/** command.prompt_cwd_hint (contracts §6): append one fixed cwd/absolute-paths line to the delivered task text. */
export function withPromptCwdHint(
    manifest: EndpointManifest,
    taskText: string,
    cwd: string,
): { text: string; appended: boolean } {
    if (manifest.command.prompt_cwd_hint !== true) return { text: taskText, appended: false }
    return {
        text: `${taskText}\n\nThe current working directory is ${cwd}. Use absolute paths for all file operations.`,
        appended: true,
    }
}

/** argv-delivery submit guard (contracts §6): Windows caps the command line at 32767 chars; 26 KiB prompts have died in practice. */
export const DEFAULT_PROMPT_MAX_BYTES = 24000

export function measureArgvBytes(parts: readonly string[]): number {
    return parts.reduce((n, a) => n + Buffer.byteLength(a, 'utf8') + 1, 0)
}

/**
 * argv-substitution safety for {model}/{session} values: they land on the
 * endpoint command line as single arguments, so whitespace, quotes and shell
 * metacharacters are forbidden. The leading class also bars a '-' first char,
 * so a value can never be mistaken for a flag by the endpoint.
 */
// Claude's context-window suffix is a model selector, not a shell operator.
// Keep session and effort validation unchanged; allow only this bounded suffix.
export const SAFE_MODEL_VALUE_RE = /^[A-Za-z0-9_][A-Za-z0-9_.:/-]{0,127}(?:\[(?:1[mM]|200[kK])\])?$/

export function assertSafeSubstitutionValue(value: string, kind: 'model' | 'session'): void {
    const pattern = kind === 'model' ? SAFE_MODEL_VALUE_RE : SAFE_SUBSTITUTION_VALUE_RE
    if (!pattern.test(value)) {
        throw new ManifestError(
            `unsafe ${kind} value ${JSON.stringify(value)}: must match ${pattern.source}` +
            ' (1-128 chars: letter/digit/underscore first, then letters/digits/_/.:/-)',
        )
    }
}

/** Drop discovered model aliases that could not survive argv substitution; returns the kept list and the drop count. */
export function filterSafeAliases<T extends { alias: string }>(models: readonly T[]): { models: T[]; dropped: number } {
    const kept = models.filter((m) => SAFE_MODEL_VALUE_RE.test(m.alias))
    return { models: kept, dropped: models.length - kept.length }
}

/** Check a selected effort against the declared options or provider-defined token syntax. */
export function supportsEffort(manifest: EndpointManifest, effort: string): boolean {
    const block = manifest.effort
    return !!block && (block.options.includes(effort) || block.allow_custom === true && SAFE_SUBSTITUTION_VALUE_RE.test(effort))
}

/** Selection is deterministic; an unsupported user override is rejected later, never replaced. */
export function resolvePermissionMode(manifest: EndpointManifest, configured?: PermissionPreset, explicit?: string): PermissionPreset {
    return (explicit ?? configured ?? manifest.permission.default_mode ?? 'workspace-write') as PermissionPreset
}

function effortArgs(manifest: EndpointManifest, effort: string): string[] {
    const block = manifest.effort
    if (!block) throw new ManifestError(`endpoint ${manifest.name} has no effort selection`)
    if (!supportsEffort(manifest, effort)) {
        throw new ManifestError(`effort "${effort}" is not one of ${manifest.name}'s options: ${block.options.join(', ')}`)
    }
    if (!block.arg) return [] // env-delivered effort (buildEnv applies the fragment)
    return block.arg.map((a) => a.replaceAll('{effort}', effort))
}

/**
 * Build the endpoint argument list (without {bin}; the spawn plan resolves the
 * command). Splice order in front of the template tail: resume, model,
 * add-dirs, mode_args, cwd_arg — flags never land after the prompt value.
 * Resume semantics (resume_argv replacement vs resume.args splice + re-tiered
 * mode_args) per contracts §6.
 */
export function buildArgs(manifest: EndpointManifest, request: RunRequest): string[] {
    if (manifest.name === 'zcode' && request.resume_session?.startsWith('zapi_')) {
        throw new ManifestError('0.1.8 app-server 会话不能交给 print 续接；请创建新 print 会话，保留已有结果。')
    }
    // substituted values ride argv verbatim — validate before any replaceAll below
    if (request.model !== null) assertSafeSubstitutionValue(request.model, 'model')
    if (request.resume_session !== null) assertSafeSubstitutionValue(request.resume_session, 'session')
    if (request.resume_session && manifest.command.resume_argv) {
        if (request.add_dirs.length > 0) {
            throw new ManifestError(`endpoint ${manifest.name} does not support add_dirs on resume`)
        }
        const insert: string[] = []
        if (request.model) {
            const modelArg = manifest.command.model_arg
            if (!modelArg) throw new ManifestError(`endpoint ${manifest.name} does not support model selection`)
            insert.push(...modelArg.map((a) => a.replaceAll('{model}', request.model as string)))
        }
        if (request.effort) insert.push(...effortArgs(manifest, request.effort))
        const argv = manifest.command.resume_argv.map((a) =>
            a.replaceAll('{session}', request.resume_session as string).replaceAll('{prompt}', request.task_text),
        )
        return [...insert, ...argv.slice(1)] // argv[0] is the {bin} placeholder; the caller spawns the resolved bin
    }

    const insert: string[] = []
    if (request.resume_session) {
        const args = manifest.resume?.args
        if (!manifest.resume || manifest.resume.kind !== 'flag' || !args) {
            throw new ManifestError(`endpoint ${manifest.name} does not support resume`)
        }
        insert.push(...args.map((a) => a.replaceAll('{session}', request.resume_session as string)))
    }
    if (request.model) {
        const modelArg = manifest.command.model_arg
        if (!modelArg) throw new ManifestError(`endpoint ${manifest.name} does not support model selection`)
        insert.push(...modelArg.map((a) => a.replaceAll('{model}', request.model as string)))
    }
    if (request.effort) insert.push(...effortArgs(manifest, request.effort))
    const addDirArg = manifest.command.add_dir_arg
    for (const dir of request.add_dirs) {
        if (!addDirArg) throw new ManifestError(`endpoint ${manifest.name} does not support add_dirs`)
        insert.push(...addDirArg.map((a) => a.replaceAll('{dir}', dir)))
    }
    // per-preset flags (e.g. codex -s <sandbox>, claude --permission-mode);
    // an explicit capability set has no tier — mode_args/mode_env stay unspliced
    const preset = typeof request.mode === 'string' ? request.mode : null
    const modeArgs = preset ? manifest.command.mode_args?.[preset] : undefined
    if (preset && modeArgs === undefined && manifest.command.mode_args !== undefined) {
        throw new ManifestError(`endpoint ${manifest.name} has no mode_args for preset "${preset}"`)
    }
    if (modeArgs) insert.push(...modeArgs)
    // cwd pin (e.g. opencode --dir): after mode_args so a subcommand riding in
    // mode_args stays left of it
    const cwdArg = manifest.command.cwd_arg
    if (cwdArg) insert.push(...cwdArg.map((a) => a.replaceAll('{cwd}', request.cwd)))
    const argv = manifest.command.argv.map((a) => a.replaceAll('{prompt}', request.task_text))
    // argv[0] is the {bin} placeholder; the caller spawns the resolved bin.
    return [...insert, ...argv.slice(1)]
}

/**
 * Child env: caller env, then command.env, then (for a preset run) command.mode_env[preset],
 * then (when a value is configured) the effort block's env form. Sentinels
 * "{native_default}"/"{unset}" and "_" documentation keys per contracts §6.
 */
export function buildEnv(
    manifest: EndpointManifest,
    base: NodeJS.ProcessEnv = process.env,
    mode: ModeSelection | null = null,
    effort: string | null = null,
): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...base }
    const apply = (fragment: Record<string, string>) => {
        for (const [key, value] of Object.entries(fragment)) {
            if (key.startsWith('_')) continue
            if (value === '{native_default}') continue
            if (value === '{unset}') {
                delete env[key]
                continue
            }
            env[key] = value
        }
    }
    apply(manifest.command.env ?? {})
    // partial mode_env coverage is normal: only tiers needing an env override declare it
    const modeEnv = typeof mode === 'string' ? manifest.command.mode_env?.[mode] : undefined
    if (modeEnv) apply(modeEnv)
    if (effort !== null && manifest.effort?.env) {
        const fragment: Record<string, string> = {}
        for (const [key, value] of Object.entries(manifest.effort.env)) fragment[key] = value.replaceAll('{effort}', effort)
        apply(fragment)
    }
    return env
}
