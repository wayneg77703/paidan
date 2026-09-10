// Host skill install (engine/skill-install.ts): detection against fixture home
// dirs, selection validation, and created/updated/unchanged atomic copies.
// Nothing touches a real agent home; all fixtures are tmp dirs.

import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import {
    detectHosts,
    installSkill,
    loadHostRegistry,
    selectSkillHosts,
} from '../dist/engine/skill-install.js'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

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
