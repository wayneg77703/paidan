// Host skill install (engine/skill-install.ts): detection against fixture home
// dirs, selection validation, and created/updated/unchanged atomic copies.
// Nothing touches a real agent home; all fixtures are tmp dirs.

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { test } from 'node:test'
import {
    detectHosts,
    installSkill,
    loadHostRegistry,
    selectSkillHosts,
} from '../dist/engine/skill-install.js'

const execFileAsync = promisify(execFile)
const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const CLI = nodePath.join(repoRoot, 'dist', 'cli.js')

async function paidan(env, args) {
    try {
        const { stdout } = await execFileAsync(process.execPath, [CLI, ...args], { env, timeout: 120_000 })
        return JSON.parse(stdout.trim())
    } catch (err) {
        // error envelopes are JSON on stdout too; only the exit code is non-zero
        if (err.stdout) return JSON.parse(err.stdout.trim())
        throw err
    }
}

async function tmpDir() {
    return fs.mkdtemp(nodePath.join(os.tmpdir(), 'paidan-skill-'))
}

test('repo host registry loads and its skill payload exists', async () => {
    const registry = await loadHostRegistry(repoRoot)
    assert.ok(registry.hosts.length >= 3)
    const source = nodePath.join(repoRoot, registry.skill.source)
    assert.ok((await fs.stat(source)).isFile(), `${source} must exist`)
})

test('detectHosts resolves {home} templates; detection = skills dir or its parent exists', async () => {
    const home = await tmpDir()
    try {
        await fs.mkdir(nodePath.join(home, '.kimi-code', 'skills'), { recursive: true })
        await fs.mkdir(nodePath.join(home, '.claude'), { recursive: true }) // parent only
        const registry = await loadHostRegistry(repoRoot)
        const hosts = await detectHosts(registry, home)
        const byName = new Map(hosts.map((h) => [h.name, h]))
        assert.equal(byName.get('kimi-code')?.detected, true)
        assert.equal(byName.get('claude-code')?.detected, true)
        assert.equal(byName.get('zcode')?.detected, false) // neither .zcode/skills nor .zcode exists
        assert.ok(byName.get('kimi-code')?.target.endsWith(nodePath.join('paidan', 'SKILL.md')))
    } finally {
        await fs.rm(home, { recursive: true, force: true })
    }
})

test('selectSkillHosts rejects unknown or undetected hosts', async () => {
    const home = await tmpDir()
    try {
        await fs.mkdir(nodePath.join(home, '.kimi-code', 'skills'), { recursive: true })
        const hosts = await detectHosts(await loadHostRegistry(repoRoot), home)
        assert.equal(selectSkillHosts(hosts, ['kimi-code']).length, 1)
        assert.throws(() => selectSkillHosts(hosts, ['zcode']), /undetected/)
        assert.throws(() => selectSkillHosts(hosts, ['nope']), /unknown|undetected/)
    } finally {
        await fs.rm(home, { recursive: true, force: true })
    }
})

test('installSkill reports created -> unchanged -> updated and keeps content exact', async () => {
    const dir = await tmpDir()
    try {
        const source = nodePath.join(dir, 'SKILL.md.src')
        const host = {
            name: 'fake-host',
            skills_dir: nodePath.join(dir, 'home', '.fake', 'skills'),
            detected: true,
            target: nodePath.join(dir, 'home', '.fake', 'skills', 'paidan', 'SKILL.md'),
        }
        await fs.writeFile(source, '# skill v1\n')
        const first = await installSkill(host, source)
        assert.equal(first.status, 'created')
        assert.equal(await fs.readFile(host.target, 'utf8'), '# skill v1\n')

        const second = await installSkill(host, source)
        assert.equal(second.status, 'unchanged')

        await fs.writeFile(source, '# skill v2\n')
        await assert.rejects(installSkill(host, source), /existing skill differs/)
        assert.equal(await fs.readFile(host.target, 'utf8'), '# skill v1\n')
        const third = await installSkill(host, source, { expectedSha256: createHash('sha256').update('# skill v1\n').digest('hex') })
        assert.equal(await fs.readFile(third.backup, 'utf8'), '# skill v1\n')
        assert.equal(third.status, 'updated')
        assert.equal(await fs.readFile(host.target, 'utf8'), '# skill v2\n')
    } finally {
        await fs.rm(dir, { recursive: true, force: true })
    }
})

test('installSkill preserves a directory at the target path and creates no staged file', async () => {
    const dir = await tmpDir()
    try {
        const source = nodePath.join(dir, 'SKILL.md.src')
        const targetDir = nodePath.join(dir, 'home', '.fake', 'skills', 'paidan')
        // A directory is rejected before staging; it does not simulate a rename failure.
        await fs.mkdir(nodePath.join(targetDir, 'SKILL.md'), { recursive: true })
        const host = {
            name: 'fake-host',
            skills_dir: nodePath.join(dir, 'home', '.fake', 'skills'),
            detected: true,
            target: nodePath.join(targetDir, 'SKILL.md'),
        }
        await fs.writeFile(source, '# skill\n')
        await assert.rejects(installSkill(host, source))
        assert.equal((await fs.stat(host.target)).isDirectory(), true)
        const leftovers = (await fs.readdir(targetDir)).filter((f) => f.endsWith('.tmp'))
        assert.deepEqual(leftovers, [], 'no staged file should be created')
    } finally {
        await fs.rm(dir, { recursive: true, force: true })
    }
})

test('init and setup reject an invalid host target before any installation writes', async () => {
    const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'paidan-skill-init-'))
    try {
        const hostHome = nodePath.join(root, 'hosts')
        // kimi-code: skills dir exists, but the SKILL.md target is a DIRECTORY -> install fails
        const kimiTargetDir = nodePath.join(hostHome, '.kimi-code', 'skills', 'paidan')
        await fs.mkdir(nodePath.join(kimiTargetDir, 'SKILL.md'), { recursive: true })
        // claude-code is valid, but the shared planner must first validate all selected targets.
        await fs.mkdir(nodePath.join(hostHome, '.claude', 'skills'), { recursive: true })
        const env = {
            ...process.env,
            PAIDAN_HOME: nodePath.join(root, 'home'),
            PAIDAN_DATA_DIR: nodePath.join(root, 'data'),
            PAIDAN_ENDPOINTS_DIR: nodePath.join(root, 'endpoints'),
            PAIDAN_HOST_HOME: hostHome,
        }
        await fs.mkdir(nodePath.join(root, 'endpoints'), { recursive: true })
        const res = await paidan(env, ['init', '--yes'])
        assert.equal(res.ok, false, JSON.stringify(res))
        assert.equal(res.error.code, 'SETUP_UNSAFE_TARGET')
        assert.equal(res.error.details.target, nodePath.join(kimiTargetDir, 'SKILL.md'))
        // the failing host left no staged tmp file behind
        const leftovers = (await fs.readdir(kimiTargetDir)).filter((f) => f.endsWith('.tmp'))
        assert.deepEqual(leftovers, [])
        const installed = nodePath.join(hostHome, '.claude', 'skills', 'paidan', 'SKILL.md')
        assert.equal(await fs.stat(installed).then(() => true, () => false), false)
        assert.equal(await fs.stat(env.PAIDAN_HOME).then(() => true, () => false), false)
    } finally {
        await fs.rm(root, { recursive: true, force: true })
    }
})

test('adaptSkillPayload: per-host frontmatter fields are honored, body untouched', async () => {
    const { adaptSkillPayload } = await import('../dist/engine/skill-install.js')
    const source = [
        '---',
        'name: paidan',
        'description: long single-line description here',
        'whenToUse: kimi-only field',
        '---',
        '# Body',
        'kept verbatim',
        '',
    ].join('\n')
    // kimi-code carries no field restriction: payload verbatim
    assert.equal(adaptSkillPayload(source, undefined), source)
    // every other host gets name+description only
    const adapted = adaptSkillPayload(source, ['name', 'description'])
    assert.ok(adapted.includes('name: paidan'))
    assert.ok(adapted.includes('description: long single-line description here'))
    assert.ok(!adapted.includes('whenToUse'))
    assert.ok(adapted.endsWith('# Body\nkept verbatim\n'))
    // multiline field values stay with their field block
    const folded = '---\nname: x\ndescription: >-\n  folded line one\n  folded line two\nextra: drop me\n---\nbody\n'
    const kept = adaptSkillPayload(folded, ['name', 'description'])
    assert.ok(kept.includes('folded line two'))
    assert.ok(!kept.includes('drop me'))
    // no frontmatter at all -> passthrough
    assert.equal(adaptSkillPayload('# just a body\n', ['name']), '# just a body\n')
})

// Per-host native variants (skills/paidan/variants/<host>.SKILL.md): each host's
// frontmatter is natively designed for its spec; bodies must stay byte-identical
// so the variants never drift apart. The guards below lock: registry filename
// convention, per-host required fields,
// structural validity the host would reject (empty/over-length/scalar-metadata/
// unclosed flow sequence), frontmatter-body blank line, and shared-body identity.
const VARIANT_REQUIRED = {
    'kimi-code': { fields: ['name', 'description', 'whenToUse'] },
    codex: { fields: ['name', 'description'], absent: ['whenToUse', 'when_to_use'] },
    'claude-code': { fields: ['name', 'description', 'when_to_use'], absent: ['whenToUse'] },
    zcode: { fields: ['name', 'description'], absent: ['whenToUse', 'when_to_use'], maxDescription: 1024 },
    dsh: { fields: ['name', 'description', 'whenToUse'] },
    opencode: { fields: ['name', 'description', 'license'], metadataMap: true },
    agy: { fields: ['name', 'description'] },
    omp: { fields: ['name', 'description'], absent: ['when_to_use'] },
}

function splitVariant(text) {
    const m = /^---\s*\n([\s\S]*?)\n---\s*\n/.exec(text)
    return m ? { fm: m[1], after: text.slice(m[0].length) } : { fm: null, after: text }
}

function descriptionOf(fm) {
    const single = /^description:\s*(.+)$/m.exec(fm)
    if (single) return single[1].trim()
    const block = /^description:\s*[|>]-?\s*\n([\s\S]*?)(?=^[A-Za-z_][A-Za-z0-9_-]*:|\s*$)/m.exec(fm)
    return block ? block[1].replace(/\s+/g, ' ').trim() : ''
}

test('per-host variants: registry mapping, native fields, host-rejected shapes, shared body', async () => {
    const registry = await loadHostRegistry(repoRoot)
    const bodies = new Map()
    for (const host of registry.hosts) {
        // registry mapping: per-host source must follow the <host>.SKILL.md convention
        assert.ok(host.source, `${host.name}: hosts.json must declare a per-host variant source`)
        assert.ok(host.source.endsWith(`/${host.name}.SKILL.md`), `${host.name}: source must point at its own variant file, got ${host.source}`)
        const text = await fs.readFile(nodePath.join(repoRoot, host.source), 'utf8')
        const { fm, after } = splitVariant(text)
        assert.ok(fm, `${host.name}: variant must carry a frontmatter block`)
        assert.ok(after.startsWith('\n# ') || after.startsWith('# '), `${host.name}: frontmatter must be followed by a blank line then the body title`)
        const rule = VARIANT_REQUIRED[host.name] ?? { fields: ['name', 'description'] }
        for (const key of rule.fields) {
            assert.ok(new RegExp(`^${key}:`, 'm').test(fm), `${host.name}: variant frontmatter must contain ${key}`)
        }
        for (const banned of rule.absent ?? []) {
            assert.ok(!new RegExp(`^${banned}:`, 'm').test(fm), `${host.name}: must NOT contain ${banned} (not in its spec)`)
        }
        const description = descriptionOf(fm)
        assert.ok(description.length > 0, `${host.name}: description must be non-empty`)
        assert.ok(!(description.startsWith('[') && !description.endsWith(']')), `${host.name}: description has an unclosed flow sequence`)
        if (rule.maxDescription) assert.ok(description.length <= rule.maxDescription, `${host.name}: description exceeds its host hard limit`)
        if (rule.metadataMap) {
            const mm = /^metadata:\s*\n((?:\s{2,}\S.*\n?)+)/m.exec(fm)
            assert.ok(mm, `${host.name}: metadata must be a string map (indented keys), not a scalar`)
        }
        bodies.set(host.name, after.replace(/^[\r\n]+/, ''))
    }
    const [reference, ...rest] = [...bodies.values()]
    for (const other of rest) assert.equal(other, reference, 'variant bodies must stay byte-identical')
})


test('installSkill refuses linked skill directories and preserves the linked user file', async () => {
    const root = await tmpDir()
    try {
        const source = nodePath.join(root, 'source.md')
        const skills = nodePath.join(root, 'skills')
        const other = nodePath.join(root, 'other')
        await fs.mkdir(skills)
        await fs.mkdir(other)
        await fs.writeFile(source, 'new packaged skill')
        await fs.writeFile(nodePath.join(other, 'SKILL.md'), 'user-owned linked file')
        await fs.symlink(other, nodePath.join(skills, 'paidan'), process.platform === 'win32' ? 'junction' : 'dir')
        const host = { name: 'fixture', skills_dir: skills, target: nodePath.join(skills, 'paidan', 'SKILL.md') }
        await assert.rejects(installSkill(host, source), /traverses a link/)
        assert.equal(await fs.readFile(nodePath.join(other, 'SKILL.md'), 'utf8'), 'user-owned linked file')
    } finally {
        assert.equal(nodePath.dirname(nodePath.resolve(root)), nodePath.resolve(os.tmpdir()))
        await fs.rm(root, { recursive: true, force: true })
    }
})
