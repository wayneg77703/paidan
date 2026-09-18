// native_preflight: read-only check of an endpoint's native settings file for
// required allow rules (agy: ~/.gemini/antigravity-cli/settings.json
// permissions.allow). Consumed by doctor (per-endpoint status) and run (missing
// rules -> a request warning, never a refusal — soft semantics). paidan NEVER
// writes the file (invariant 4); a failure here is reported, not repaired.

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import { expandKnownPath } from './spawn.js'

export interface NativePreflightSpec {
    /** {home}/{env:NAME}-leading template, e.g. "{home}/.gemini/antigravity-cli/settings.json" */
    file: string
    /** rule strings that must be present in the file's permissions.allow list */
    require_allow: string[]
}

export type NativePreflightResult = {
    /** expanded absolute path (null when a template token could not expand) */
    file: string | null
} & (
    | { status: 'ok' }
    | { status: 'missing'; missing: string[] }
    | { status: 'unreadable'; detail: string }
)

export async function checkNativePreflight(
    spec: NativePreflightSpec,
    env: NodeJS.ProcessEnv = process.env,
): Promise<NativePreflightResult> {
    const file = expandKnownPath(spec.file, env, os.homedir())
    if (!file) {
        return { file: null, status: 'unreadable', detail: `template "${spec.file}" could not expand (unset env token)` }
    }
    let raw: string
    try {
        raw = await fs.readFile(file, 'utf8')
    } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        return { file, status: 'unreadable', detail: code === 'ENOENT' ? `${file} does not exist` : `${file} is not readable (${code})` }
    }
    let parsed: unknown
    try {
        parsed = JSON.parse(raw)
    } catch {
        return { file, status: 'unreadable', detail: `${file} is not valid JSON` }
    }
    const permissions = isRecord(parsed) ? parsed.permissions : undefined
    const allow = isRecord(permissions) && Array.isArray(permissions.allow)
        ? new Set(permissions.allow.filter((r): r is string => typeof r === 'string'))
        : new Set<string>()
    const missing = spec.require_allow.filter((rule) => !allow.has(rule))
    return missing.length > 0 ? { file, status: 'missing', missing } : { file, status: 'ok' }
}

function isRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v)
}
