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
        // and the successful host really holds the payload
        const installed = nodePath.join(hostHome, '.claude', 'skills', 'paidan', 'SKILL.md')
        const source = await fs.readFile(nodePath.join(repoRoot, 'skills', 'paidan', 'SKILL.md'), 'utf8')
        assert.equal(await fs.readFile(installed, 'utf8'), source)
    } finally {
        await fs.rm(root, { recursive: true, force: true })
    }
})
