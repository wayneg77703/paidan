// Spawn resolution layers (src/endpoints/spawn.ts + engine/supervisor resolveBin):
// .EXE-over-.CMD priority, npm_exe/npm_entry layouts, config override,
// cmd.exe shim fallback with caret-escaped argv. All fixtures are tmp dirs;
// nothing on the real PATH or machine config is touched.

import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import { test } from 'node:test'
import { syncBuiltinESMExports } from 'node:module'
import { resolveBin } from '../dist/endpoints/spawn.js'
import {
    buildCmdLine,
    finalSpawnArgs,
    needsVerbatimArgs,
    planEndpointSpawn,
    enumerateEndpointSpawns,
    quoteCmdArg,
} from '../dist/endpoints/spawn.js'

const windowsOnly = { skip: process.platform !== 'win32' && 'requires Windows PATHEXT lookup' }

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

test('resolveBin prefers .EXE over .CMD in the same directory', windowsOnly, async () => {
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

test('POSIX PATH lookup ignores PATHEXT and finds extensionless binaries', {
    skip: process.platform === 'win32' && 'requires POSIX PATH lookup',
}, async () => {
    const dir = await tmpDir()
    try {
        await fs.writeFile(nodePath.join(dir, 'fakebin.CMD'), '@echo off\r\n')
        await fs.writeFile(nodePath.join(dir, 'fakebin.EXE'), 'MZ')
        const nextDir = nodePath.join(dir, 'next')
        await fs.mkdir(nextDir)
        const env = { PATH: [dir, nextDir].join(nodePath.delimiter), PATHEXT: '.CMD;.EXE' }
        assert.equal(await resolveBin('fakebin', env), null)
        const bin = nodePath.join(nextDir, 'fakebin')
        await fs.writeFile(bin, '#!/bin/sh\n', { mode: 0o755 })
        assert.equal(await resolveBin('fakebin', env), bin)
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
            // This only plans a spawn; an explicit shim path exercises the
            // same npm-layout fallback on POSIX without pretending PATHEXT works.
            manifest({ bin: process.platform === 'win32' ? 'fakebin' : nodePath.join(dir, 'fakebin.CMD'), npm_exe: '@vendor/pkg/bin/real.exe' }),
            { env: { PATH: dir, PATHEXT: '.CMD', APPDATA: nodePath.join(dir, 'no-such-appdata') } },
        )
        assert.equal(res.plan?.resolved_from, 'npm-exe')
        assert.equal(res.plan?.command, exe)
        assert.equal(res.plan?.endpoint_bin, exe)
    } finally {
        await fs.rm(dir, { recursive: true, force: true })
    }
})

test('npm_entry falls back to process.execPath + entry (npm-entry)', async t => {
    const dir = await tmpDir()
    try {
        await fs.writeFile(nodePath.join(dir, 'fakebin.CMD'), '@echo off\r\n')
        const entry = nodePath.join(dir, 'node_modules', '@vendor', 'pkg', 'cli.js')
        await fs.mkdir(nodePath.dirname(entry), { recursive: true })
        await fs.writeFile(entry, '// entry')
        const res = await planEndpointSpawn(
            manifest({ bin: process.platform === 'win32' ? 'fakebin' : nodePath.join(dir, 'fakebin.CMD'), npm_entry: '@vendor/pkg/cli.js' }),
            { env: { PATH: dir, PATHEXT: '.CMD' } },
        )
        assert.equal(res.plan?.resolved_from, 'npm-entry')
        assert.equal(res.plan?.command, process.execPath)
        assert.deepEqual(res.plan?.prefixArgs, [entry])
        // A standalone executable must not hide a different npm installation in the same PATH directory.
        const standalone = nodePath.join(dir, process.platform === 'win32' ? 'fakebin.exe' : 'fakebin')
        await fs.writeFile(standalone, '// standalone')
        const all = await enumerateEndpointSpawns(manifest({ npm_entry: '@vendor/pkg/cli.js' }), { env: { PATH: dir, PATHEXT: '.EXE;.CMD' } })
        assert.deepEqual(new Set(all.map(p => p.endpoint_bin)), new Set(await Promise.all([standalone, entry].map(p => fs.realpath(p)))))
        const realpath = fs.realpath
        const transient = t.mock.method(fs.default, 'realpath', async p => {
            if (p === standalone) throw Object.assign(new Error('candidate disappeared after stat'), { code: 'ENOENT' })
            return realpath(p)
        })
        syncBuiltinESMExports()
        try {
            const remaining = await enumerateEndpointSpawns(manifest({ npm_entry: '@vendor/pkg/cli.js' }), { env: { PATH: dir, PATHEXT: '.EXE;.CMD' } })
            assert.deepEqual(remaining.map(p => p.endpoint_bin), [await realpath(entry)])
        } finally { transient.mock.restore(); syncBuiltinESMExports() }
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
        // An installation directory must not be reported as a launchable bin.
        const directory = await planEndpointSpawn(manifest(), { configBin: dir, env: { PATH: '' } })
        assert.equal(directory.plan, null)
    } finally {
        await fs.rm(dir, { recursive: true, force: true })
    }
})

test('pinning a selected installation wins over an older PATH entry and fails closed if removed', async () => {
    const dir = await tmpDir()
    try {
        const old = nodePath.join(dir, 'old.cjs')
        const chosen = nodePath.join(dir, 'chosen.cjs')
        await fs.writeFile(old, '// old installation')
        await fs.writeFile(chosen, '// user-selected installation')
        const m = manifest({ bin: old })
        const automatic = await planEndpointSpawn(m, { env: { PATH: '' } })
        assert.equal(automatic.plan?.endpoint_bin, old)
        const pinned = await planEndpointSpawn(m, { configBin: chosen, env: { PATH: '' } })
        assert.equal(pinned.plan?.endpoint_bin, chosen)
        assert.equal(pinned.plan?.resolved_from, 'config-override')
        await fs.unlink(chosen)
        const moved = await planEndpointSpawn(m, { configBin: chosen, env: { PATH: '' } })
        assert.equal(moved.plan, null, 'never silently return to the old installation')
    } finally {
        await fs.rm(dir, { recursive: true, force: true })
    }
})

test('bare .cmd shim without npm layout falls back to cmd-shim with verbatim args', windowsOnly, async () => {
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
