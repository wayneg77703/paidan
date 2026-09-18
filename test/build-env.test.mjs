// buildEnv semantics (src/endpoints/registry.ts): {native_default} never sets,
// {unset} deletes an inherited var, "_" keys are documentation (never exported),
// mode_env splices per-preset fragments on top.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildEnv } from '../dist/endpoints/invocation.js'
import { validateManifest } from '../dist/endpoints/registry.js'

function dshLike() {
    return {
        schema_version: '1.0.0',
        name: 'dsh',
        detect: { bin: 'dsh' },
        command: {
            argv: ['{bin}', '--profile', 'headless', '{prompt}'],
            prompt_delivery: 'argv',
            env: {
                DSH_HOME: '{native_default}',
                DSH_PERMISSION_MODE: '{native_default}',
                DSH_TELEMETRY_DISABLED: '1',
                _env_notes: 'documentation, must never be exported',
            },
            mode_env: { 'read-only': { DSH_PERMISSION_MODE: 'read-only' } },
        },
        permission: { presets: { 'read-only': 'supported', 'workspace-write': 'supported' } },
        parser: 'dsh-headless',
    }
}

test('{native_default} never sets, static pins apply, "_"-prefixed keys are not exported', () => {
    const env = buildEnv(dshLike(), { DSH_HOME: 'C:\\real\\dsh-home', PATH: 'x' }, 'workspace-write')
    assert.equal(env.DSH_HOME, 'C:\\real\\dsh-home') // inherited value passes through
    assert.equal(env.DSH_TELEMETRY_DISABLED, '1')
    assert.equal(env._env_notes, undefined)
    assert.equal(env.PATH, 'x')
})

test('mode_env applies only on its preset and overrides the inherited value', () => {
    const ro = buildEnv(dshLike(), { DSH_PERMISSION_MODE: 'workspace-write' }, 'read-only')
    assert.equal(ro.DSH_PERMISSION_MODE, 'read-only') // mode_env wins over inherited
    const ww = buildEnv(dshLike(), { DSH_PERMISSION_MODE: 'read-only' }, 'workspace-write')
    assert.equal(ww.DSH_PERMISSION_MODE, 'read-only') // caller env passes through verbatim (documented hazard)
    const none = buildEnv(dshLike(), {}, 'workspace-write')
    assert.equal(none.DSH_PERMISSION_MODE, undefined) // {native_default} = not set
})

test('mode_env declared but missing the run preset is a no-op (partial coverage is normal)', () => {
    const env = buildEnv(dshLike(), { PATH: 'x' }, 'unattended')
    assert.equal(env.DSH_PERMISSION_MODE, undefined)
    assert.equal(env.DSH_TELEMETRY_DISABLED, '1')
})

test('{unset} deletes an inherited variable (opencode PWD scenario)', () => {
    const opencodeLike = {
        schema_version: '1.0.0',
        name: 'opencode',
        detect: { bin: 'opencode' },
        command: {
            argv: ['{bin}', '--format', 'json'],
            prompt_delivery: 'stdin',
            env: { PWD: '{unset}', NO_COLOR: '1' },
        },
        permission: { presets: { 'workspace-write': 'supported' } },
        parser: 'opencode-run',
    }
    const env = buildEnv(opencodeLike, { PWD: '/poisoned/shell/dir', HOME: '/home/x' }, 'workspace-write')
    assert.equal('PWD' in env, false)
    assert.equal(env.HOME, '/home/x')
    assert.equal(env.NO_COLOR, '1')
})

test('validateManifest rejects malformed cwd_arg / mode_env', () => {
    const base = dshLike()
    assert.throws(
        () => validateManifest({ ...base, command: { ...base.command, cwd_arg: '--dir' } }, 'dsh.json'),
        /cwd_arg must be a string array or null/,
    )
    assert.throws(
        () => validateManifest({ ...base, command: { ...base.command, mode_env: { bogus: { X: '1' } } } }, 'dsh.json'),
        /mode_env\["bogus"\]/,
    )
    assert.throws(
        () => validateManifest({ ...base, command: { ...base.command, mode_env: { 'read-only': { X: 1 } } } }, 'dsh.json'),
        /mode_env\["read-only"\]/,
    )
    // and the valid shape passes
    assert.equal(validateManifest(base, 'dsh.json').name, 'dsh')
})
