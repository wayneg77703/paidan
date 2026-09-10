// Layered endpoint spawn resolution. Node >= 20.12 on Windows refuses to spawn
// .cmd/.bat without a shell (EINVAL), and several agent CLIs install only npm
// script shims on PATH. Resolution order:
//   1. machine-config override (config.json endpoints.overrides.<name>.bin)
//   2. PATH scan (resolveBin; .EXE beats .CMD in the same directory)
//      - .cmd/.bat shim hit -> try the manifest's npm layout from the shim dir
//      - .js/.cjs/.mjs hit   -> spawn via process.execPath
//   3. manifest npm layout under the standard npm global roots (works even
//      when the shim was removed from PATH)
//   4. manifest detect.known_paths: well-known per-platform install locations
//      as {home}/{env:NAME} templates (repo stays free of machine-absolute paths)
//   5. cmd.exe /d /s /c fallback with caret-escaped argv (verbatim arguments)
// npm_entry/npm_exe are package-relative templates (e.g.
// "@openai/codex/node_modules/.../bin/codex.exe"), never machine-absolute.

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import { resolveBin } from '../engine/supervisor.js'
import type { EndpointManifest } from './registry.js'

export type SpawnSource = 'config-override' | 'path' | 'npm-exe' | 'npm-entry' | 'known-path' | 'cmd-shim'

export interface SpawnPlan {
    /** what to spawn: the binary itself, process.execPath (node-wrapped), or cmd.exe */
    command: string
    prefixArgs: string[]
    resolved_from: SpawnSource
    /** the real endpoint binary/script, for doctor reporting */
    endpoint_bin: string | null
    notes: string[]
}

export interface SpawnResolution {
    plan: SpawnPlan | null
    notes: string[]
}

const NODE_WRAP_EXTS = new Set(['.js', '.cjs', '.mjs'])
const SHIM_EXTS = new Set(['.cmd', '.bat'])

/** npm global module roots, pure fs (NPM_CONFIG_PREFIX, then the win32 default). */
function npmModuleRoots(env: NodeJS.ProcessEnv): string[] {
    const roots: string[] = []
    if (env.NPM_CONFIG_PREFIX) roots.push(nodePath.join(env.NPM_CONFIG_PREFIX, 'node_modules'))
    if (env.APPDATA) roots.push(nodePath.join(env.APPDATA, 'npm', 'node_modules'))
    return [...new Set(roots)]
}

async function isFile(p: string): Promise<boolean> {
    try {
        return (await fs.stat(p)).isFile()
    } catch {
        return false
    }
}

const KNOWN_PATH_TOKEN_RE = /\{home\}|\{env:([A-Za-z0-9_()\s]+)\}/g

/**
 * Expand a detect.known_paths template. `{home}` = the user's home directory;
 * `{env:NAME}` = an environment variable (unset/empty => candidate skipped).
 * Returns a normalized absolute path, or null when a token cannot expand.
 */
export function expandKnownPath(template: string, env: NodeJS.ProcessEnv, home: string): string | null {
    let failed = false
    const out = template.replace(KNOWN_PATH_TOKEN_RE, (whole, envName: string | undefined) => {
        if (whole === '{home}') return home
        const value = envName ? env[envName] : undefined
        if (!value) failed = true
        return value ?? ''
    })
    if (failed) return null
    return nodePath.normalize(out)
}

function planForPath(resolved: string, from: SpawnSource, notes: string[]): SpawnPlan {
    const ext = nodePath.extname(resolved).toLowerCase()
    if (NODE_WRAP_EXTS.has(ext)) {
        // a JS bundle is spawned through the current Node, never directly
        return { command: process.execPath, prefixArgs: [resolved], resolved_from: from, endpoint_bin: resolved, notes }
    }
    return { command: resolved, prefixArgs: [], resolved_from: from, endpoint_bin: resolved, notes }
}

/** npm_exe (native binary) beats npm_entry (node-wrapped entry point). */
async function planFromNpmLayout(
    manifest: EndpointManifest,
    roots: readonly string[],
    notes: string[],
): Promise<SpawnPlan | null> {
    const { npm_exe: npmExe, npm_entry: npmEntry } = manifest.detect
    for (const root of roots) {
        if (npmExe) {
            const candidate = nodePath.join(root, npmExe)
            if (await isFile(candidate)) {
                return {
                    command: candidate,
                    prefixArgs: [],
                    resolved_from: 'npm-exe',
                    endpoint_bin: candidate,
                    notes,
                }
            }
        }
        if (npmEntry) {
            const candidate = nodePath.join(root, npmEntry)
            if (await isFile(candidate)) {
                return {
                    command: process.execPath,
                    prefixArgs: [candidate],
                    resolved_from: 'npm-entry',
                    endpoint_bin: candidate,
                    notes,
                }
            }
        }
    }
    return null
}

export async function planEndpointSpawn(
    manifest: EndpointManifest,
    opts: { configBin?: string | null; env?: NodeJS.ProcessEnv } = {},
): Promise<SpawnResolution> {
    const env = opts.env ?? process.env
    const notes: string[] = []

    // 1. machine-config override wins; a configured-but-unresolvable override
    //    fails closed (the user asked for exactly that binary)
    if (opts.configBin) {
        const resolved = await resolveBin(opts.configBin, env)
        if (!resolved) {
            notes.push(`endpoints.overrides.${manifest.name}.bin = ${JSON.stringify(opts.configBin)} does not resolve to a file`)
            return { plan: null, notes }
        }
        const plan = planForPath(resolved, 'config-override', notes)
        if (SHIM_EXTS.has(nodePath.extname(resolved).toLowerCase())) {
            return { plan: cmdShimPlan(resolved, env, notes), notes }
        }
        return { plan, notes }
    }

    // 2. PATH scan
    const pathHit = await resolveBin(manifest.detect.bin, env)
    if (pathHit) {
        const ext = nodePath.extname(pathHit).toLowerCase()
        if (SHIM_EXTS.has(ext)) {
            const shimDir = nodePath.dirname(pathHit)
            const npmPlan = await planFromNpmLayout(
                manifest,
                [nodePath.join(shimDir, 'node_modules'), ...npmModuleRoots(env)],
                notes,
            )
            if (npmPlan) return { plan: npmPlan, notes }
            notes.push(
                `only a script shim (${nodePath.basename(pathHit)}) is on PATH and no npm layout matched;` +
                ' falling back to cmd.exe with escaped argv',
            )
            return { plan: cmdShimPlan(pathHit, env, notes), notes }
        }
        return { plan: planForPath(pathHit, 'path', notes), notes }
    }

    // 3. npm global roots without a PATH shim (shim removed, or never installed)
    const npmPlan = await planFromNpmLayout(manifest, npmModuleRoots(env), notes)
    if (npmPlan) return { plan: npmPlan, notes }

    // 4. well-known install locations from the manifest (template-expanded)
    for (const template of manifest.detect.known_paths ?? []) {
        const candidate = expandKnownPath(template, env, os.homedir())
        if (candidate && (await isFile(candidate))) {
            notes.push(`resolved via known install location: ${template}`)
            return { plan: planForPath(candidate, 'known-path', notes), notes }
        }
    }

    notes.push(
        `"${manifest.detect.bin}" is not on PATH and no npm layout or known install location matched` +
        `; repair: set endpoints.overrides.${manifest.name}.bin in config.json to the native binary` +
        ' or JS bundle (machine paths live in machine config, never in the repo), or install a PATH shim',
    )
    return { plan: null, notes }
}

function cmdShimPlan(shimPath: string, env: NodeJS.ProcessEnv, notes: string[]): SpawnPlan {
    const comspec = env.ComSpec ?? env.COMSPEC ?? 'cmd.exe'
    return {
        command: comspec,
        prefixArgs: [],
        resolved_from: 'cmd-shim',
        endpoint_bin: shimPath,
        notes,
    }
}

/** Final argv for the plan; cmd-shim plans collapse everything into one escaped command line. */
export function finalSpawnArgs(plan: SpawnPlan, args: string[]): string[] {
    if (plan.resolved_from !== 'cmd-shim') return [...plan.prefixArgs, ...args]
    const cmdline = buildCmdLine(plan.endpoint_bin ?? '', args)
    return ['/d', '/s', '/c', cmdline]
}

/** cmd-shim plans must be spawned with verbatim arguments (no libuv re-quoting). */
export function needsVerbatimArgs(plan: SpawnPlan): boolean {
    return plan.resolved_from === 'cmd-shim'
}

const CMD_SPECIAL_RE = /[\s&|<>^%"()]/g

/**
 * cmd.exe command-line escaping without entering quote mode: every metachar
 * (including space, %, ", &) is caret-escaped, so the token stays one argument
 * and %VAR% never expands. CR/LF and empty strings cannot be represented
 * safely (command-splitting / token-loss risk) and are rejected — the repair
 * path is a native binary or a config override.
 */
export function quoteCmdArg(arg: string): string {
    if (arg.length === 0) {
        throw new Error('cmd.exe shim spawn cannot carry an empty argument')
    }
    if (/\r|\n/.test(arg)) {
        throw new Error(
            'cmd.exe shim spawn cannot carry CR/LF in arguments; set endpoints.overrides.<name>.bin' +
            ' to a native binary or install one',
        )
    }
    return arg.replace(CMD_SPECIAL_RE, (c) => `^${c}`)
}

export function buildCmdLine(bin: string, args: string[]): string {
    return [bin, ...args].map(quoteCmdArg).join(' ')
}
