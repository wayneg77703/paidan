// Endpoint manifest registry: loads and validates endpoints/*.json.
// The engine reaches endpoint knowledge only through this module.

import * as fs from 'node:fs/promises'
import * as nodePath from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PermissionPreset, RunRequest } from '../engine/types.js'
import type { EndpointParserModule, EndpointStreamParser } from './parser-api.js'

export interface CapabilityStatus {
    status: 'supported' | 'soft' | 'unsupported' | 'unverified'
    via?: string
    verified_at?: string
    version?: string
}

export interface EndpointManifest {
    schema_version: '1.0.0'
    name: string
    family?: string
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
        /** full alternative argv template used instead of argv on resume runs
         *  ({session}/{prompt} replaced; mode_args/cwd_arg are NOT spliced) */
        resume_argv?: string[]
        /** per-preset argv fragments spliced in front of the template tail */
        mode_args?: Partial<Record<PermissionPreset, string[]>>
        /** argv fragment with {cwd} -> request.cwd; spliced AFTER mode_args so a
         *  subcommand carried in mode_args (codex exec, opencode run) stays left of it */
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
        [capability: string]: unknown
    }
    resume?: {
        kind: string
        args?: string[]
        cross_process?: boolean
        notes?: string
    }
    models?: {
        command: string[] | null
        parse?: string
        connections?: unknown[]
    }
    parser: string
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

    if (typeof m.parser !== 'string' || m.parser.length === 0) {
        throw new ManifestError(`${source}: missing parser`)
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

/**
 * Capabilities each preset requires; checked against the manifest's capability
 * map at submit time. unsupported -> reject naming the capability; soft and
 * unverified -> warnings recorded on the request.
 */
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

/**
 * Preset for contract probes (P1/P3 share one tier): the most conservative
 * supported preset, preferring workspace-write, then unattended, then
 * read-only. null when the endpoint supports no preset (P1/P3 then skip).
 */
export function pickProbePreset(manifest: EndpointManifest): PermissionPreset | null {
    for (const preset of ['workspace-write', 'unattended', 'read-only'] as const) {
        if (manifest.permission.presets[preset] === 'supported') return preset
    }
    return null
}

export function checkPermission(manifest: EndpointManifest, mode: PermissionPreset): PermissionCheck {
    const missing: string[] = []
    const warnings: string[] = []
    const presetStatus = manifest.permission.presets[mode]
    if (presetStatus === 'unsupported') {
        missing.push(`preset:${mode}`)
    } else if (presetStatus === 'soft' || presetStatus === 'unverified' || presetStatus === undefined) {
        warnings.push(`preset ${mode} is ${presetStatus ?? 'undeclared'} on endpoint ${manifest.name}`)
    }
    for (const cap of PRESET_REQUIREMENTS[mode]) {
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
    return { ok: missing.length === 0, missing, warnings }
}

/**
 * command.prompt_cwd_hint: endpoints whose tools ignore the spawn cwd (agy
 * 1.2.0 run_command starts in its own scratch dir) need the cwd stated inside
 * the task text. The delivered text gets one fixed line appended; request.json
 * keeps the original (the fingerprint already pins cwd).
 */
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

/**
 * Windows CreateProcess caps the command line at 32767 chars; argv-delivered
 * prompts died at 26 KiB in practice (omp lesson). The guard measures the
 * would-be command line (bin + space-joined args) in UTF-8 bytes and rejects
 * at submit time; manifest command.prompt_max_bytes overrides the default.
 */
export const DEFAULT_PROMPT_MAX_BYTES = 24000

export function measureArgvBytes(parts: readonly string[]): number {
    return parts.reduce((n, a) => n + Buffer.byteLength(a, 'utf8') + 1, 0)
}


/**
 * Build the endpoint argument list (without the bin itself; the spawn plan
 * resolves the command separately). Optional segments (resume / model /
 * add-dir / per-preset mode flags / cwd pin) are spliced in front of the
 * template tail, so flags never land after the prompt value. Splice order:
 * resume, model, add-dirs, mode_args, cwd_arg.
 *
 * Resume: when the manifest declares command.resume_argv, that template fully
 * replaces command.argv and only model_arg is spliced (mode_args and add_dirs
 * do not translate across a resume — e.g. codex exec resume accepts -m but
 * neither -s nor --add-dir). Otherwise resume.args flags are spliced and
 * mode_args are re-passed (claude semantics: a resumed -p invocation re-tiers
 * from the new invocation, so flags must be re-passed).
 */
export function buildArgs(manifest: EndpointManifest, request: RunRequest): string[] {
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
        const argv = manifest.command.resume_argv.map((a) =>
            a.replaceAll('{session}', request.resume_session as string).replaceAll('{prompt}', request.task_text),
        )
        // argv[0] is the {bin} placeholder; the caller spawns the resolved bin.
        return [...insert, ...argv.slice(1)]
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
    const addDirArg = manifest.command.add_dir_arg
    for (const dir of request.add_dirs) {
        if (!addDirArg) throw new ManifestError(`endpoint ${manifest.name} does not support add_dirs`)
        insert.push(...addDirArg.map((a) => a.replaceAll('{dir}', dir)))
    }
    // per-preset flags (e.g. codex -s <sandbox>, claude --permission-mode)
    const modeArgs = manifest.command.mode_args?.[request.mode]
    if (modeArgs === undefined && manifest.command.mode_args !== undefined) {
        throw new ManifestError(`endpoint ${manifest.name} has no mode_args for preset "${request.mode}"`)
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
 * Child env: inherit the caller env, then apply manifest command.env and (for
 * the run's mode) command.mode_env[mode] on top. Value sentinels:
 *   "{native_default}" — never set the variable (endpoint runs against its
 *     native config home; paidan never stages or copies config)
 *   "{unset}" — delete an inherited variable (e.g. opencode unsets PWD, which
 *     would otherwise re-anchor the project root away from the spawn cwd)
 * Keys starting with "_" are documentation fields, never exported (a manifest
 * "_env_notes" key must not become a child-process variable).
 */
export function buildEnv(
    manifest: EndpointManifest,
    base: NodeJS.ProcessEnv = process.env,
    mode: PermissionPreset | null = null,
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
    const modeEnv = mode ? manifest.command.mode_env?.[mode] : undefined
    if (modeEnv) apply(modeEnv)
    return env
}

export interface EndpointParserBundle {
    parser: EndpointStreamParser
    detectRefusals: (stderrText: string, exitCode: number | null) => string[]
    readLedgerUsage?: EndpointParserModule['readLedgerUsage']
    captureLedgerCursor?: EndpointParserModule['captureLedgerCursor']
}

const PARSER_NAME_RE = /^[a-z0-9][a-z0-9-]*$/

/**
 * Convention-based parser loading: manifest.parser "<name>" maps to
 * src/endpoints/<name>.ts exporting createParser + detectRefusals
 * (+ optional discoverModels). Adding an endpoint never touches this file.
 */
export async function loadParserModule(parserName: string): Promise<EndpointParserModule> {
    if (!PARSER_NAME_RE.test(parserName)) {
        throw new ManifestError(`invalid parser name ${JSON.stringify(parserName)}`)
    }
    let mod: Record<string, unknown>
    try {
        mod = await import(`./${parserName}.js`)
    } catch {
        throw new ManifestError(`parser module not found for "${parserName}" (expected src/endpoints/${parserName}.ts)`)
    }
    if (typeof mod.createParser !== 'function' || typeof mod.detectRefusals !== 'function') {
        throw new ManifestError(`parser module "${parserName}" must export createParser and detectRefusals`)
    }
    return mod as unknown as EndpointParserModule
}

/** Parser selection by manifest.parser; the only place engine code reaches parser code. */
export async function createEndpointParser(manifest: EndpointManifest): Promise<EndpointParserBundle> {
    const mod = await loadParserModule(manifest.parser)
    return {
        parser: mod.createParser(),
        detectRefusals: mod.detectRefusals,
        readLedgerUsage: mod.readLedgerUsage,
        captureLedgerCursor: mod.captureLedgerCursor,
    }
}
