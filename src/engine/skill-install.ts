// Host skill installation for the init wizard. Data-driven by skills/hosts.json;
// a host's skill directory is written ONLY on explicit user selection (a checked
// host is the consent — paidan never silently patches an agent's native home).
// The payload is paidan's own skills/paidan/SKILL.md, copied atomically.

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as nodePath from 'node:path'

export interface HostEntry {
    name: string
    /** {home}-leading template, e.g. "{home}/.kimi-code/skills" */
    skills_dir: string
    verified_at?: string
    notes?: string
}

export interface HostRegistry {
    schema_version: string
    skill: { source: string; dir_name: string }
    hosts: HostEntry[]
}

export interface HostInfo {
    name: string
    skills_dir: string
    detected: boolean
    /** final install target: <skills_dir>/<dir_name>/SKILL.md */
    target: string
    /** the target already holds a copy (any content) */
    installed: boolean
    notes?: string
}

export type SkillInstallStatus = 'created' | 'updated' | 'unchanged'

export interface SkillInstallResult {
    host: string
    path: string
    status: SkillInstallStatus
}

export class SkillInstallError extends Error {}

async function isDirectory(p: string): Promise<boolean> {
    try {
        return (await fs.stat(p)).isDirectory()
    } catch {
        return false
    }
}

/** Read and minimally validate skills/hosts.json from the package root. */
export async function loadHostRegistry(pkgRoot: string): Promise<HostRegistry> {
    const file = nodePath.join(pkgRoot, 'skills', 'hosts.json')
    const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as HostRegistry
    if (!Array.isArray(parsed.hosts) || typeof parsed.skill?.dir_name !== 'string') {
        throw new SkillInstallError(`${file}: malformed host registry`)
    }
    return parsed
}

/**
 * Resolve templates and probe presence. A host counts as detected when its
 * skills dir already exists, or its parent (the host home) does — the install
 * step creates the skills dir on demand.
 */
export async function detectHosts(
    registry: HostRegistry,
    home: string = os.homedir(),
): Promise<HostInfo[]> {
    const out: HostInfo[] = []
    for (const host of registry.hosts) {
        if (!host.skills_dir.startsWith('{home}')) {
            throw new SkillInstallError(`hosts.json: ${host.name} skills_dir must start with {home}`)
        }
        const skillsDir = nodePath.normalize(host.skills_dir.replace('{home}', home))
        const target = nodePath.join(skillsDir, registry.skill.dir_name, 'SKILL.md')
        const detected = (await isDirectory(skillsDir)) || (await isDirectory(nodePath.dirname(skillsDir)))
        let installed = false
        try {
            installed = (await fs.stat(target)).isFile()
        } catch { /* absent */ }
        out.push({
            name: host.name,
            skills_dir: skillsDir,
            detected,
            target,
            installed,
            ...(host.notes ? { notes: host.notes } : {}),
        })
    }
    return out
}

/** Validate a user/--yes selection against detected hosts. */
export function selectSkillHosts(hosts: HostInfo[], names: string[]): HostInfo[] {
    const detected = new Map(hosts.filter((h) => h.detected).map((h) => [h.name, h]))
    return names.map((name) => {
        const host = detected.get(name)
        if (!host) throw new SkillInstallError(`cannot install skill into unknown or undetected host "${name}"`)
        return host
    })
}

/** Copy the skill file into the host, atomically; report created/updated/unchanged. */
export async function installSkill(
    host: HostInfo,
    sourcePath: string,
): Promise<SkillInstallResult> {
    const source = await fs.readFile(sourcePath)
    let status: SkillInstallStatus = 'created'
    try {
        const existing = await fs.readFile(host.target)
        if (existing.equals(source)) return { host: host.name, path: host.target, status: 'unchanged' }
        status = 'updated'
    } catch {
        // absent target -> created
    }
    await fs.mkdir(nodePath.dirname(host.target), { recursive: true })
    const tmp = nodePath.join(
        nodePath.dirname(host.target),
        `.SKILL.md.${process.pid}.${Date.now()}.tmp`,
    )
    await fs.writeFile(tmp, source)
    await fs.rename(tmp, host.target)
    return { host: host.name, path: host.target, status }
}
