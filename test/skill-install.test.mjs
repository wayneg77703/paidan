// Host skill install (engine/skill-install.ts): detection against fixture home
// dirs, selection validation, and created/updated/unchanged atomic copies.
// Nothing touches a real agent home; all fixtures are tmp dirs.

import assert from 'node:assert/strict'
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
        const third = await installSkill(host, source)
        assert.equal(third.status, 'updated')
        assert.equal(await fs.readFile(host.target, 'utf8'), '# skill v2\n')
    } finally {
        await fs.rm(dir, { recursive: true, force: true })
    }
})

test('installSkill rethrows a failed rename and removes the staged tmp file', async () => {
    const dir = await tmpDir()
    try {
        const source = nodePath.join(dir, 'SKILL.md.src')
        const targetDir = nodePath.join(dir, 'home', '.fake', 'skills', 'paidan')
        // a directory at the target path stands in for a readonly/locked target:
        // renaming the staged file onto it must fail on any platform
        await fs.mkdir(nodePath.join(targetDir, 'SKILL.md'), { recursive: true })
        const host = {
            name: 'fake-host',
            skills_dir: nodePath.join(dir, 'home', '.fake', 'skills'),
            detected: true,
            target: nodePath.join(targetDir, 'SKILL.md'),
        }
        await fs.writeFile(source, '# skill\n')
        await assert.rejects(installSkill(host, source))
        const leftovers = (await fs.readdir(targetDir)).filter((f) => f.endsWith('.tmp'))
        assert.deepEqual(leftovers, [], 'staged tmp file must be cleaned up')
    } finally {
        await fs.rm(dir, { recursive: true, force: true })
    }
})

test('init --yes reports a failing host as status error and still installs the rest', async () => {
    const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'paidan-skill-init-'))
    try {
        const hostHome = nodePath.join(root, 'hosts')
        // kimi-code: skills dir exists, but the SKILL.md target is a DIRECTORY -> install fails
        const kimiTargetDir = nodePath.join(hostHome, '.kimi-code', 'skills', 'paidan')
        await fs.mkdir(nodePath.join(kimiTargetDir, 'SKILL.md'), { recursive: true })
        // claude-code: plain skills dir -> install succeeds
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
        assert.equal(res.ok, true, JSON.stringify(res))
        assert.equal(res.written, true)
        const byHost = new Map(res.skills.map((s) => [s.host, s]))
        assert.equal(byHost.get('kimi-code')?.status, 'error')
        assert.ok((byHost.get('kimi-code')?.error ?? '').length > 0, 'error entry carries the failure message')
        assert.equal(byHost.get('kimi-code')?.path, nodePath.join(kimiTargetDir, 'SKILL.md'))
        assert.equal(byHost.get('claude-code')?.status, 'created')
        // the failing host left no staged tmp file behind
        const leftovers = (await fs.readdir(kimiTargetDir)).filter((f) => f.endsWith('.tmp'))
        assert.deepEqual(leftovers, [])
        // and the successful host really holds its natively-authored variant, verbatim
        const installed = nodePath.join(hostHome, '.claude', 'skills', 'paidan', 'SKILL.md')
        const variant = await fs.readFile(nodePath.join(repoRoot, 'skills', 'paidan', 'variants', 'claude-code.SKILL.md'), 'utf8')
        assert.equal(await fs.readFile(installed, 'utf8'), variant)
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

test('installSkill writes the per-host adapted payload (kimi keeps whenToUse, codex drops it)', async () => {
    const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'paidan-skill-'))
    try {
        const kimi = { name: 'kimi-code', skills_dir: nodePath.join(root, '.kimi-code', 'skills'), detected: true, target: nodePath.join(root, '.kimi-code', 'skills', 'paidan', 'SKILL.md'), installed: false }
        const codex = { name: 'codex', skills_dir: nodePath.join(root, '.codex', 'skills'), detected: true, target: nodePath.join(root, '.codex', 'skills', 'paidan', 'SKILL.md'), installed: false }
        await installSkill(kimi, nodePath.join(repoRoot, 'skills', 'paidan', 'variants', 'kimi-code.SKILL.md'))
        await installSkill(codex, nodePath.join(repoRoot, 'skills', 'paidan', 'variants', 'codex.SKILL.md'))
        const kimiText = await fs.readFile(kimi.target, 'utf8')
        const codexText = await fs.readFile(codex.target, 'utf8')
        assert.ok(kimiText.includes('whenToUse:'))
        assert.ok(!codexText.includes('whenToUse:'))
        assert.ok(codexText.includes('name: paidan'))
        assert.ok(codexText.includes('description:'))
        // body identical between the two installs
        assert.equal(codexText.split('---\n').slice(2).join('---\n'), kimiText.split('---\n').slice(2).join('---\n'))
    } finally {
        await fs.rm(root, { recursive: true, force: true })
    }
})

// Per-host native variants (skills/paidan/variants/<host>.SKILL.md): each host's
// frontmatter is natively designed for its spec; bodies must stay byte-identical
// so the variants never drift apart. The guards below lock: registry filename
// convention, per-host required fields AND distinctive description markers,
// structural validity the host would reject (empty/over-length/scalar-metadata/
// unclosed flow sequence), frontmatter-body blank line, and shared-body identity.
const VARIANT_REQUIRED = {
    'kimi-code': { fields: ['name', 'description', 'whenToUse'], marker: '新委派默认走本通道' },
    codex: { fields: ['name', 'description'], marker: '委派任务给本机 AI CLI agent 执行', absent: ['whenToUse', 'when_to_use'] },
    'claude-code': { fields: ['name', 'description', 'when_to_use'], marker: '持久 run', absent: ['whenToUse'] },
    zcode: { fields: ['name', 'description'], marker: '触发场景：', absent: ['whenToUse', 'when_to_use'], maxDescription: 1024 },
    dsh: { fields: ['name', 'description', 'whenToUse'], marker: '新委派默认走本通道' },
    opencode: { fields: ['name', 'description', 'license'], marker: 'license: MIT', metadataMap: true },
    agy: { fields: ['name', 'description'], marker: '当需要把任务委派给本机' },
    omp: { fields: ['name', 'description'], marker: '需要把任务委派给本机 AI CLI agent 时使用本通道', absent: ['when_to_use'] },
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
        assert.ok(fm.includes(rule.marker) || description.includes(rule.marker), `${host.name}: description must carry its distinctive marker ${JSON.stringify(rule.marker)}`)
        if (rule.metadataMap) {
            const mm = /^metadata:\s*\n((?:\s{2,}\S.*\n?)+)/m.exec(fm)
            assert.ok(mm, `${host.name}: metadata must be a string map (indented keys), not a scalar`)
        }
        bodies.set(host.name, after.replace(/^[\r\n]+/, ''))
    }
    const [reference, ...rest] = [...bodies.values()]
    for (const other of rest) assert.equal(other, reference, 'variant bodies must stay byte-identical')
})
