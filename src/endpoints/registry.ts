// Endpoint manifest registry: loads and validates endpoints/*.json.
// Data definitions and validation only; invocation and adapter loading live separately.

import * as fs from 'node:fs/promises'
import * as nodePath from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PermissionPreset } from '../engine/types.js'
import { writeJsonAtomic } from '../engine/run-store.js'

export interface CapabilityStatus {
    status: 'supported' | 'soft' | 'unsupported' | 'unverified'
    via?: string
    verified_at?: string
    version?: string
}

export interface EndpointManifest {
    schema_version: '1.0.0'
    name: string
    detect: {
        bin: string
        version_args?: string[]
        version_re?: string
        /** package-relative JS entry spawned via process.execPath (npm shim fallback) */
        npm_entry?: string
        /** package-relative native binary in the npm install tree (preferred over npm_entry) */
        npm_exe?: string
        /** well-known install locations as {home}/{env:NAME}-leading templates (no machine-absolute literals) */
        known_paths?: string[]
    }
    command: {
        argv: string[]
        prompt_delivery: 'stdin' | 'argv' | 'file'
        /** alternative argv template for resume runs ({session}/{prompt} replaced; mode_args/cwd_arg NOT spliced) */
        resume_argv?: string[]
        /** per-preset argv fragments spliced in front of the template tail */
        mode_args?: Partial<Record<PermissionPreset, string[]>>
        /** {cwd} -> request.cwd; spliced AFTER mode_args so a subcommand in mode_args stays left of it */
        cwd_arg?: string[] | null
        /** per-preset env fragments applied on top of env for that mode */
        mode_env?: Partial<Record<PermissionPreset, Record<string, string>>>
        model_arg?: string[]
        add_dir_arg?: string[]
        env?: Record<string, string>
        /** append a fixed cwd/absolute-paths hint line to the delivered task text (all delivery forms, resume included) */
        prompt_cwd_hint?: boolean
        /** argv-delivery guard: submit is rejected when the final argv exceeds this many bytes (default 24000) */
        prompt_max_bytes?: number
    }
    permission: {
        presets: Partial<Record<PermissionPreset, CapabilityStatus['status']>>
        default_mode?: PermissionPreset
        headless_notes?: string
        [capability: string]: unknown
    }
    resume?: {
        kind: string
        args?: string[]
        cross_process?: boolean
        notes?: string
        verified_at?: string
        version?: string
    }
    models?: {
        command: string[] | null
        parse?: string
        /** Fixed defaults require the native configuration context approved at selection time. */
        bind_selection?: boolean
    }
    /** effort/intensity selection: delivered via argv (arg) and/or env; a value is spliced whenever one is configured (absent = no effort selection for this endpoint) */
    effort?: {
        options: string[]
        /** Provider/model-defined names (OpenCode variants); options are examples only. */
        allow_custom?: boolean
        /** argv splice template containing {effort}; env-only blocks may omit it */
        arg?: string[]
        /** env-delivered form (values contain {effort}); applied on top of command.env/mode_env — e.g. kimi KIMI_MODEL_THINKING_EFFORT, which has no CLI flag */
        env?: Record<string, string>
        status?: string
        verified_at?: string
        version?: string
        notes?: string
    }
    parser: string
    /** read-only native-settings check: required allow rules in a {home}/{env:} templated file */
    native_preflight?: {
        file: string
        require_allow: string[]
    }
    capabilities?: {
        background_native?: boolean
        cancel_native?: boolean
        completed_nonzero_exit?: boolean
        /** documentation-only native total-time cap in seconds; null = none, the engine cap backstops */
        max_run_sec?: number | null
    }
}

export class ManifestError extends Error {
    override name = 'ManifestError'
}

/** dist/endpoints/registry.js -> <repo>/endpoints; PAIDAN_ENDPOINTS_DIR overrides (tests). */
export function defaultEndpointsDir(env: NodeJS.ProcessEnv = process.env): string {
    if (env.PAIDAN_ENDPOINTS_DIR) return env.PAIDAN_ENDPOINTS_DIR
    return fileURLToPath(new URL('../../endpoints/', import.meta.url))
}

export class EndpointRegistry {
    private readonly manifests = new Map<string, EndpointManifest>()

    private constructor(readonly dir: string) {}

    static async load(dir: string = defaultEndpointsDir()): Promise<EndpointRegistry> {
        const registry = new EndpointRegistry(dir)
        let entries: string[]
        try {
            entries = await fs.readdir(dir)
        } catch {
            return registry
        }
        for (const entry of entries.sort()) {
            if (!entry.endsWith('.json')) continue
            const raw = await fs.readFile(nodePath.join(dir, entry), 'utf8')
            let parsed: unknown
            try {
                parsed = JSON.parse(raw)
            } catch {
                throw new ManifestError(`endpoint manifest is not valid JSON: ${entry}`)
            }
            const manifest = validateManifest(parsed, entry)
            registry.manifests.set(manifest.name, manifest)
        }
        return registry
    }

    get(name: string): EndpointManifest {
        const manifest = this.manifests.get(name)
        if (!manifest) {
            throw new ManifestError(`unknown endpoint "${name}" (known: ${[...this.manifests.keys()].join(', ') || 'none'})`)
        }
        return manifest
    }

    list(): EndpointManifest[] {
        return [...this.manifests.values()]
    }
}

export function validateManifest(value: unknown, source: string): EndpointManifest {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new ManifestError(`${source}: manifest must be a JSON object`)
    }
    const m = value as Record<string, unknown>
    const section = (key: string): Record<string, unknown> => {
        const v = m[key]
        if (!v || typeof v !== 'object' || Array.isArray(v)) {
            throw new ManifestError(`${source}: missing ${key} section`)
        }
        return v as Record<string, unknown>
    }
    if (m.schema_version !== '1.0.0') {
        throw new ManifestError(`${source}: unsupported schema_version ${JSON.stringify(m.schema_version)}`)
    }
    if (typeof m.name !== 'string' || m.name.length === 0) {
        throw new ManifestError(`${source}: missing name`)
    }
    if (nodePath.basename(source, '.json') !== m.name) {
        throw new ManifestError(`${source}: name "${m.name}" must match file name`)
    }

    const detect = section('detect')
    if (typeof detect.bin !== 'string' || detect.bin.length === 0) {
        throw new ManifestError(`${source}: detect.bin must be a non-empty string`)
    }
    if (detect.version_args !== undefined && !isStringArray(detect.version_args)) {
        throw new ManifestError(`${source}: detect.version_args must be a string array`)
    }
    if (detect.version_re !== undefined && typeof detect.version_re !== 'string') {
        throw new ManifestError(`${source}: detect.version_re must be a string`)
    }
    for (const key of ['npm_entry', 'npm_exe'] as const) {
        const v = detect[key]
        if (v === undefined) continue
        if (typeof v !== 'string' || v.length === 0 || nodePath.isAbsolute(v) || /^[A-Za-z]:/.test(v) || v.includes('..')) {
            throw new ManifestError(`${source}: detect.${key} must be a package-relative path (no absolute paths, no "..")`)
        }
    }
    if (detect.known_paths !== undefined) {
        if (!isStringArray(detect.known_paths)) {
            throw new ManifestError(`${source}: detect.known_paths must be a string array`)
        }
        for (const template of detect.known_paths) {
            // templates expand at runtime; the repo must stay free of machine-absolute literals
            if (!/^\{(home|env:[A-Za-z0-9_()\s]+)\}/.test(template) || template.includes('..')) {
                throw new ManifestError(
                    `${source}: detect.known_paths entries must start with a {home} or {env:NAME} token and contain no ".."`,
                )
            }
        }
    }

    const command = section('command')
    if (!isStringArray(command.argv) || command.argv.length === 0) {
        throw new ManifestError(`${source}: command.argv must be a non-empty string array`)
    }
    if (command.argv[0] !== '{bin}') {
        throw new ManifestError(`${source}: command.argv must start with {bin}`)
    }
    if (!['stdin', 'argv', 'file'].includes(command.prompt_delivery as string)) {
        throw new ManifestError(`${source}: command.prompt_delivery must be stdin | argv | file`)
    }
    if (command.prompt_delivery === 'argv' && !command.argv.includes('{prompt}')) {
        throw new ManifestError(`${source}: command.argv must contain {prompt} when prompt_delivery is argv`)
    }
    if (command.prompt_cwd_hint !== undefined && typeof command.prompt_cwd_hint !== 'boolean') {
        throw new ManifestError(`${source}: command.prompt_cwd_hint must be a boolean`)
    }
    if (command.prompt_max_bytes !== undefined
        && (typeof command.prompt_max_bytes !== 'number' || !Number.isFinite(command.prompt_max_bytes) || command.prompt_max_bytes <= 0)) {
        throw new ManifestError(`${source}: command.prompt_max_bytes must be a positive number`)
    }
    for (const key of ['model_arg', 'add_dir_arg'] as const) {
        if (command[key] !== undefined && !isStringArray(command[key])) {
            throw new ManifestError(`${source}: command.${key} must be a string array`)
        }
    }
    if (m.effort !== undefined) {
        const eff = m.effort as Record<string, unknown>
        if (!eff || typeof eff !== 'object' || Array.isArray(eff)) {
            throw new ManifestError(`${source}: effort must be an object`)
        }
        if (eff.allow_custom !== undefined && typeof eff.allow_custom !== 'boolean') {
            throw new ManifestError(`${source}: effort.allow_custom must be boolean`)
        }
        if (!isStringArray(eff.options) || eff.options.length === 0) {
            throw new ManifestError(`${source}: effort.options must be a non-empty string array`)
        }
        for (const opt of eff.options) {
            if (!SAFE_SUBSTITUTION_VALUE_RE.test(opt)) {
                throw new ManifestError(`${source}: effort option ${JSON.stringify(opt)} would not survive argv substitution`)
            }
        }
        const hasArg = eff.arg !== undefined
        const hasEnv = eff.env !== undefined
        if (hasArg && (!isStringArray(eff.arg) || !eff.arg.some((a) => a.includes('{effort}')))) {
            throw new ManifestError(`${source}: effort.arg must be a string array containing {effort}`)
        }
        if (hasEnv) {
            if (!isPlainObject(eff.env)) {
                throw new ManifestError(`${source}: effort.env must be an object`)
            }
            for (const [key, value] of Object.entries(eff.env)) {
                if (typeof value !== 'string' || !value.includes('{effort}')) {
                    throw new ManifestError(`${source}: effort.env["${key}"] must be a string containing {effort}`)
                }
            }
        }
        if (!hasArg && !hasEnv) {
            throw new ManifestError(`${source}: effort must deliver via arg and/or env (at least one form containing {effort})`)
        }
        if (eff.default !== undefined && eff.default !== null && !eff.options.includes(eff.default as string)) {
            throw new ManifestError(`${source}: effort.default must be one of effort.options`)
        }
    }
    if (command.resume_argv !== undefined) {
        if (!isStringArray(command.resume_argv) || command.resume_argv.length === 0) {
            throw new ManifestError(`${source}: command.resume_argv must be a non-empty string array`)
        }
        if (command.resume_argv[0] !== '{bin}') {
            throw new ManifestError(`${source}: command.resume_argv must start with {bin}`)
        }
        if (!command.resume_argv.some((a) => a.includes('{session}'))) {
            throw new ManifestError(`${source}: command.resume_argv must contain {session}`)
        }
        if (command.prompt_delivery === 'argv' && !command.resume_argv.some((a) => a.includes('{prompt}'))) {
            throw new ManifestError(`${source}: command.resume_argv must contain {prompt} when prompt_delivery is argv`)
        }
    }
    if (command.cwd_arg !== undefined && command.cwd_arg !== null && !isStringArray(command.cwd_arg)) {
        throw new ManifestError(`${source}: command.cwd_arg must be a string array or null`)
    }
    if (command.mode_env !== undefined) {
        if (!isPlainObject(command.mode_env)) {
            throw new ManifestError(`${source}: command.mode_env must be an object`)
        }
        for (const [preset, fragment] of Object.entries(command.mode_env)) {
            if (!['read-only', 'workspace-write', 'unattended'].includes(preset) || !isPlainObject(fragment)
                || !Object.values(fragment).every((v) => typeof v === 'string')) {
                throw new ManifestError(`${source}: command.mode_env["${preset}"] must be a string->string object keyed by a known preset`)
            }
        }
    }
    if (command.mode_args !== undefined) {
        if (!isPlainObject(command.mode_args)) {
            throw new ManifestError(`${source}: command.mode_args must be an object`)
        }
        for (const [preset, fragment] of Object.entries(command.mode_args)) {
            if (!['read-only', 'workspace-write', 'unattended'].includes(preset) || !isStringArray(fragment)) {
                throw new ManifestError(`${source}: command.mode_args["${preset}"] must be a string array keyed by a known preset`)
            }
        }
    }

    const permission = section('permission')
    const presets = permission.presets
    if (!presets || typeof presets !== 'object' || Array.isArray(presets)) {
        throw new ManifestError(`${source}: missing permission.presets`)
    }
    for (const [preset, status] of Object.entries(presets)) {
        if (!['supported', 'soft', 'unsupported', 'unverified'].includes(status as string)) {
            throw new ManifestError(`${source}: permission.presets["${preset}"] has invalid status ${JSON.stringify(status)}`)
        }
    }
    if (permission.default_mode !== undefined) {
        if (!['read-only', 'workspace-write', 'unattended'].includes(permission.default_mode as string)
            || !['supported', 'soft'].includes((presets as Record<string, string>)[permission.default_mode as string] ?? '')) {
            throw new ManifestError(`${source}: permission.default_mode must name a supported or soft preset`)
        }
    }
    if (permission.headless_notes !== undefined && typeof permission.headless_notes !== 'string') {
        throw new ManifestError(`${source}: permission.headless_notes must be a string`)
    }

    if (typeof m.parser !== 'string' || m.parser.length === 0) {
        throw new ManifestError(`${source}: missing parser`)
    }
    if (isPlainObject(m.models) && m.models.bind_selection !== undefined && typeof m.models.bind_selection !== 'boolean') {
        throw new ManifestError(`${source}: models.bind_selection must be a boolean`)
    }
    if (m.native_preflight !== undefined) {
        if (!isPlainObject(m.native_preflight)) {
            throw new ManifestError(`${source}: native_preflight must be an object`)
        }
        const pf = m.native_preflight
        if (typeof pf.file !== 'string'
            || !/^\{(home|env:[A-Za-z0-9_()\s]+)\}/.test(pf.file) || pf.file.includes('..')) {
            throw new ManifestError(
                `${source}: native_preflight.file must start with a {home} or {env:NAME} token and contain no ".."`,
            )
        }
        if (!isStringArray(pf.require_allow)) {
            throw new ManifestError(`${source}: native_preflight.require_allow must be a string array`)
        }
    }
    if (m.capabilities !== undefined) {
        if (!isPlainObject(m.capabilities)) {
            throw new ManifestError(`${source}: capabilities must be an object`)
        }
        const maxRun = m.capabilities.max_run_sec
        if (maxRun !== undefined && maxRun !== null
            && (typeof maxRun !== 'number' || !Number.isFinite(maxRun) || maxRun <= 0)) {
            throw new ManifestError(`${source}: capabilities.max_run_sec must be a positive number or null`)
        }
    }
    return m as unknown as EndpointManifest
}

function isStringArray(v: unknown): v is string[] {
    return Array.isArray(v) && v.every((x) => typeof x === 'string')
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return v !== null && typeof v === 'object' && !Array.isArray(v)
}

// Safe token syntax shared by manifest effort validation and invocation.
export const SAFE_SUBSTITUTION_VALUE_RE = /^[A-Za-z0-9_][A-Za-z0-9_.:/-]{0,127}$/

/** Write probe-verified verified_at/version fields back into a manifest (manifest structure knowledge lives here, not in the CLI). */
export async function refreshManifestVerifiedAt(
    dir: string,
    name: string,
    probes: Array<{ name: string; verdict: string }>,
    today: string,
    version: string | null,
): Promise<void> {
    const file = nodePath.join(dir, `${name}.json`)
    const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>
    const permission = parsed.permission as Record<string, Record<string, unknown>> | undefined
    const passed = new Set(probes.filter((p) => p.verdict === 'pass').map((p) => p.name))
    if (passed.has('P1-write') && permission) {
        for (const cap of ['fs.read', 'fs.write']) {
            if (permission[cap] && typeof permission[cap] === 'object') {
                permission[cap].verified_at = today
                if (version) permission[cap].version = version
            }
        }
    }
    if (passed.has('P3-resume') && parsed.resume && typeof parsed.resume === 'object') {
        const resume = parsed.resume as Record<string, unknown>
        resume.verified_at = today
        if (version) resume.version = version
    }
    await writeJsonAtomic(file, parsed)
}
