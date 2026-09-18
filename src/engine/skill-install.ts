// Host skill installation for the init wizard. Data-driven by skills/hosts.json;
// a host's skill directory is written ONLY on explicit user selection (a checked
// host is the consent — paidan never silently patches an agent's native home).
// The payload is paidan's own skills/paidan/SKILL.md, copied atomically.

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import { constants } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'

export interface HostEntry {
    name: string
    /** {home}-leading template, e.g. "{home}/.kimi-code/skills" */
    skills_dir: string
    verified_at?: string
    notes?: string
    /**
     * Frontmatter keys this host's skill spec allows, in order (e.g.
     * ["name","description"]). Absent = the payload's full frontmatter is
     * installed verbatim (kimi-code additionally reads `whenToUse`).
     */
    frontmatter_fields?: string[]
    /** repo-relative path to this host's natively-authored skill variant; absent = registry.skill.source */
    source?: string
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
    /** frontmatter keys this host's spec allows; absent = payload verbatim */
    frontmatter_fields?: string[]
    /** repo-relative path to this host's natively-authored skill variant; absent = registry default */
    source?: string
}

export type SkillInstallStatus = 'created' | 'updated' | 'unchanged' | 'error'

export interface SkillInstallResult {
    host: string
    path: string
    status: SkillInstallStatus
    backup?: string
    /** failure message when status is 'error' (reported by the caller, which keeps installing other hosts) */
    error?: string
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
            ...(host.frontmatter_fields ? { frontmatter_fields: host.frontmatter_fields } : {}),
            ...(host.source ? { source: host.source } : {}),
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
    opts: { expectedSha256?: string } = {},
): Promise<SkillInstallResult> {
    const payload = adaptSkillPayload(await fs.readFile(sourcePath, 'utf8'), host.frontmatter_fields)
    // A discovered directory or an existing filename does not authorize
    // following links or replacing a user's customized skill.
    const skillsRoot = nodePath.resolve(host.skills_dir)
    const relative = nodePath.relative(skillsRoot, nodePath.resolve(host.target))
    if (!relative || relative.startsWith(`..${nodePath.sep}`) || relative === '..' || nodePath.isAbsolute(relative)) {
        throw new SkillInstallError('skill target must be inside the selected host skills directory')
    }
    // Inspect the selected skill tree, not unrelated OS ancestors (macOS /var
    // itself is a symlink). The host root is the caller's selected scope.
    for (let item = nodePath.resolve(host.target); ; item = nodePath.dirname(item)) {
        const stat = await fs.lstat(item).catch((err: NodeJS.ErrnoException) => {
            if (err.code === 'ENOENT') return null
            throw err
        })
        if (stat?.isSymbolicLink()) throw new SkillInstallError(`skill target traverses a link; inspect the actual destination first: ${item}`)
        if (item === skillsRoot) break
    }
    let status: SkillInstallStatus = 'created'
    let existing: Buffer | null = null
    let backup: string | undefined
    try {
        existing = await fs.readFile(host.target)
        if (existing.equals(Buffer.from(payload))) return { host: host.name, path: host.target, status: 'unchanged' }
        if (createHash('sha256').update(existing).digest('hex') !== opts.expectedSha256) {
            throw new SkillInstallError(`existing skill differs; preserve it and review the changes before replacing: ${host.target}`)
        }
        status = 'updated'
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
    await fs.mkdir(nodePath.dirname(host.target), { recursive: true })
    if (existing) {
        backup = `${host.target}.bak-${randomUUID()}`
        await fs.copyFile(host.target, backup, constants.COPYFILE_EXCL)
        if (!(await fs.readFile(backup)).equals(existing)) {
            throw new SkillInstallError('skill changed while backing up; existing target preserved')
        }
    }
    const tmp = nodePath.join(
        nodePath.dirname(host.target),
        `.SKILL.md.${process.pid}.${Date.now()}.tmp`,
    )
    await fs.writeFile(tmp, payload, 'utf8')
    try {
        if (existing) {
            if (!(await fs.readFile(host.target)).equals(existing)) throw new SkillInstallError('skill changed during installation; refusing to replace it')
            await fs.rename(tmp, host.target)
        } else {
            // Exclusive creation also preserves a file created after our read.
            await fs.link(tmp, host.target)
            await fs.rm(tmp)
        }
    } catch (err) {
        // never leave the staged tmp file behind (e.g. locked/readonly target)
        await fs.rm(tmp, { force: true }).catch(() => {})
        throw err
    }
    return { host: host.name, path: host.target, status, ...(backup ? { backup } : {}) }
}

/**
 * Per-host frontmatter adaptation: each agent's skill spec allows a specific
 * key set (kimi-code reads name/description/whenToUse; every other verified
 * host spec is name+description only). Fields are split into blocks at
 * `key:` line starts (continuation lines stay with their field), unlisted
 * fields are dropped, order and values are preserved verbatim, and the body
 * is never touched. A payload without a frontmatter block passes through.
 */
export function adaptSkillPayload(source: string, fields?: string[]): string {
    if (!fields) return source
    const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(source)
    if (!m) return source
    const lines = (m[1] as string).split('\n')
    const blocks: Array<{ key: string; text: string[] }> = []
    const preamble: string[] = []
    for (const line of lines) {
        const keyMatch = /^([A-Za-z_][A-Za-z0-9_-]*):/.exec(line)
        if (keyMatch) {
            blocks.push({ key: keyMatch[1] as string, text: [line] })
        } else if (blocks.length > 0) {
            ;(blocks[blocks.length - 1] as { key: string; text: string[] }).text.push(line)
        } else {
            // non-field lines before the first key (comments etc.) are kept verbatim
            preamble.push(line)
        }
    }
    if (blocks.length === 0) {
        // a frontmatter block that parses to no fields is a broken payload — say so
        throw new SkillInstallError('skill payload frontmatter contains no fields')
    }
    const kept = blocks.filter((b) => fields.includes(b.key))
    if (kept.length === blocks.length && preamble.length === 0) return source
    const frontmatter = [...preamble, ...kept.map((b) => b.text.join('\n'))].join('\n')
    return `---\n${frontmatter}\n---\n${source.slice(m[0].length)}`
}
