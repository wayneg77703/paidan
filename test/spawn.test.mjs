// Spawn resolution layers (src/endpoints/spawn.ts + engine/supervisor resolveBin):
// .EXE-over-.CMD priority, npm_exe/npm_entry layouts, config override,
// cmd.exe shim fallback with caret-escaped argv. All fixtures are tmp dirs;
// nothing on the real PATH or machine config is touched.

import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import { test } from 'node:test'
import { resolveBin } from '../dist/engine/supervisor.js'
import {
    buildCmdLine,
    finalSpawnArgs,
    needsVerbatimArgs,
    planEndpointSpawn,
    quoteCmdArg,
} from '../dist/endpoints/spawn.js'

async function tmpDir() {
    return fs.mkdtemp(nodePath.join(os.tmpdir(), 'paidan-spawn-'))
}

function manifest(detectExtra = {}) {
    return {
        schema_version: '1.0.0',
        name: 'fake',
        detect: { bin: 'fakebin', ...detectExtra },
        command: { argv: ['{bin}', '-p', '{prompt}'], prompt_delivery: 'argv' },
        permission: { presets: {} },
        parser: 'kimi-print',
    }
}

test('resolveBin prefers .EXE over .CMD in the same directory', async () => {
    const dir = await tmpDir()
    try {
        await fs.writeFile(nodePath.join(dir, 'fakebin.CMD'), '@echo off\r\n')
        await fs.writeFile(nodePath.join(dir, 'fakebin.EXE'), 'MZ')
        const hit = await resolveBin('fakebin', { PATH: dir, PATHEXT: '.CMD;.BAT;.EXE' })
        assert.ok(hit && hit.toLowerCase().endsWith('.exe'), `expected .EXE, got ${hit}`)
    } finally {
        await fs.rm(dir, { recursive: true, force: true })
    }
})

test('PATH .cmd shim with npm_exe layout resolves to the native binary (npm-exe)', async () => {
    const dir = await tmpDir()
    try {
        await fs.writeFile(nodePath.join(dir, 'fakebin.CMD'), '@echo off\r\n')
        const exe = nodePath.join(dir, 'node_modules', '@vendor', 'pkg', 'bin', 'real.exe')
        await fs.mkdir(nodePath.dirname(exe), { recursive: true })
        await fs.writeFile(exe, 'MZ')
        const res = await planEndpointSpawn(
            manifest({ npm_exe: '@vendor/pkg/bin/real.exe' }),
            { env: { PATH: dir, PATHEXT: '.CMD', APPDATA: nodePath.join(dir, 'no-such-appdata') } },
        )
        assert.equal(res.plan?.resolved_from, 'npm-exe')
        assert.equal(res.plan?.command, exe)
        assert.equal(res.plan?.endpoint_bin, exe)
    } finally {
        await fs.rm(dir, { recursive: true, force: true })
    }
})

test('npm_entry falls back to process.execPath + entry (npm-entry)', async () => {
    const dir = await tmpDir()
    try {
        await fs.writeFile(nodePath.join(dir, 'fakebin.CMD'), '@echo off\r\n')
        const entry = nodePath.join(dir, 'node_modules', '@vendor', 'pkg', 'cli.js')
        await fs.mkdir(nodePath.dirname(entry), { recursive: true })
        await fs.writeFile(entry, '// entry')
        const res = await planEndpointSpawn(
            manifest({ npm_entry: '@vendor/pkg/cli.js' }),
            { env: { PATH: dir, PATHEXT: '.CMD' } },
        )
        assert.equal(res.plan?.resolved_from, 'npm-entry')
        assert.equal(res.plan?.command, process.execPath)
        assert.deepEqual(res.plan?.prefixArgs, [entry])
    } finally {
        await fs.rm(dir, { recursive: true, force: true })
    }
})

test('npm global roots resolve without any PATH shim (shim removed)', async () => {
    const dir = await tmpDir()
    try {
        const exe = nodePath.join(dir, 'npm', 'node_modules', '@vendor', 'pkg', 'bin', 'real.exe')
        await fs.mkdir(nodePath.dirname(exe), { recursive: true })
        await fs.writeFile(exe, 'MZ')
        const res = await planEndpointSpawn(
            manifest({ npm_exe: '@vendor/pkg/bin/real.exe' }),
            { env: { PATH: '', APPDATA: dir } },
        )
        assert.equal(res.plan?.resolved_from, 'npm-exe')
        assert.equal(res.plan?.command, exe)
    } finally {
        await fs.rm(dir, { recursive: true, force: true })
    }
})

test('config override to a .cjs bundle spawns via node; unresolvable override fails closed', async () => {
    const dir = await tmpDir()
    try {
        const bundle = nodePath.join(dir, 'zcode.cjs')
        await fs.writeFile(bundle, '// bundle')
        const ok = await planEndpointSpawn(manifest(), { configBin: bundle, env: { PATH: '' } })
        assert.equal(ok.plan?.resolved_from, 'config-override')
        assert.equal(ok.plan?.command, process.execPath)
        assert.deepEqual(ok.plan?.prefixArgs, [bundle])
        const bad = await planEndpointSpawn(manifest(), { configBin: nodePath.join(dir, 'nope.exe'), env: { PATH: '' } })
        assert.equal(bad.plan, null)
        assert.ok(bad.notes.some((n) => n.includes('does not resolve')))
    } finally {
        await fs.rm(dir, { recursive: true, force: true })
    }
})

test('bare .cmd shim without npm layout falls back to cmd-shim with verbatim args', async () => {
    const dir = await tmpDir()
    try {
        await fs.writeFile(nodePath.join(dir, 'fakebin.CMD'), '@echo off\r\n')
        const comspec = nodePath.join('C:\\Windows', 'System32', 'cmd.exe')
        const res = await planEndpointSpawn(manifest(), {
            env: { PATH: dir, PATHEXT: '.CMD', ComSpec: comspec, APPDATA: nodePath.join(dir, 'none') },
        })
        assert.equal(res.plan?.resolved_from, 'cmd-shim')
        assert.equal(res.plan?.command, comspec)
        assert.equal(needsVerbatimArgs(res.plan), true)
        const args = finalSpawnArgs(res.plan, ['-p', 'hello world'])
        assert.deepEqual(args.slice(0, 3), ['/d', '/s', '/c'])
        assert.ok(args[3].includes('hello^ world'))
    } finally {
        await fs.rm(dir, { recursive: true, force: true })
    }
})

test('quoteCmdArg caret-escapes metachars without quote mode', () => {
    assert.equal(quoteCmdArg('plain-arg_1.2'), 'plain-arg_1.2')
    assert.equal(quoteCmdArg('a&b|c'), 'a^&b^|c')
    assert.equal(quoteCmdArg('100% sure'), '100^%^ sure')
    assert.equal(quoteCmdArg('say "hi"'), 'say^ ^"hi^"')
    assert.equal(quoteCmdArg('(paren)'), '^(paren^)')
    assert.equal(quoteCmdArg('a^b'), 'a^^b')
    assert.equal(
        buildCmdLine('C:\\tools\\my agent\\bin.cmd', ['-p', 'x&y']),
        'C:\\tools\\my^ agent\\bin.cmd -p x^&y',
    )
})

test('quoteCmdArg rejects CR/LF and empty arguments (command-splitting risk)', () => {
    assert.throws(() => quoteCmdArg('line1\nline2'), /CR\/LF/)
    assert.throws(() => quoteCmdArg('line1\r\nline2'), /CR\/LF/)
    assert.throws(() => quoteCmdArg(''), /empty/)
})

test('unresolvable endpoint yields a repair hint naming the config override path', async () => {
    const res = await planEndpointSpawn(manifest(), { env: { PATH: '', APPDATA: '' } })
    assert.equal(res.plan, null)
    assert.ok(res.notes.some((n) => n.includes('endpoints.overrides.fake.bin')))
})

test('known_paths resolves a well-known install location via {env:} token (known-path)', async () => {
    const dir = await tmpDir()
    try {
        await fs.mkdir(nodePath.join(dir, 'ZCode', 'resources', 'glm'), { recursive: true })
        const bundle = nodePath.join(dir, 'ZCode', 'resources', 'glm', 'zcode.cjs')
        await fs.writeFile(bundle, '// bundle\n')
        const res = await planEndpointSpawn(
            manifest({ known_paths: ['{env:PAIDAN_FAKE_PROGRAM_FILES}/ZCode/resources/glm/zcode.cjs'] }),
            { env: { PATH: '', APPDATA: '', PAIDAN_FAKE_PROGRAM_FILES: dir } },
        )
        assert.ok(res.plan, 'expected a plan')
        assert.equal(res.plan.resolved_from, 'known-path')
        // a .cjs bundle is spawned through the current Node
        assert.equal(res.plan.command, process.execPath)
        assert.deepEqual(res.plan.prefixArgs, [bundle])
    } finally {
        await fs.rm(dir, { recursive: true, force: true })
    }
})

test('known_paths candidates are skipped when their env token is unset', async () => {
    const res = await planEndpointSpawn(
        manifest({ known_paths: ['{env:PAIDAN_DEFINITELY_UNSET}/ZCode/resources/glm/zcode.cjs'] }),
        { env: { PATH: '', APPDATA: '' } },
    )
    assert.equal(res.plan, null)
    assert.ok(res.notes.some((n) => n.includes('known install location')))
})

test('expandKnownPath handles {home}, {env:NAME}, parens in names, and normalization', async () => {
    const { expandKnownPath } = await import('../dist/endpoints/spawn.js')
    assert.equal(expandKnownPath('{home}/.dsh/bin.js', {}, '/home/u'), nodePath.normalize('/home/u/.dsh/bin.js'))
    assert.equal(expandKnownPath('{env:ProgramFiles(x86)}/Z/x.cjs', { 'ProgramFiles(x86)': 'C:\PF86' }, '/h'), nodePath.normalize('C:\PF86/Z/x.cjs'))
    assert.equal(expandKnownPath('{env:MISSING_VAR}/x', {}, '/h'), null)
})
