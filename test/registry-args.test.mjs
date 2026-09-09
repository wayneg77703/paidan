// buildArgs resume_argv rendering + pickProbePreset selection (registry.ts).

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildArgs, pickProbePreset } from '../dist/endpoints/registry.js'

function codexLike() {
    return {
        schema_version: '1.0.0',
        name: 'codex',
        detect: { bin: 'codex' },
        command: {
            argv: ['{bin}', '--json', '-c', 'approval_policy="never"', '--skip-git-repo-check', '-'],
            prompt_delivery: 'stdin',
            mode_args: {
                'read-only': ['exec', '-s', 'read-only'],
                'workspace-write': ['exec', '-s', 'workspace-write'],
                unattended: ['exec', '-s', 'danger-full-access'],
            },
            model_arg: ['-m', '{model}'],
            add_dir_arg: ['--add-dir', '{dir}'],
            resume_argv: ['{bin}', 'exec', 'resume', '{session}', '--json', '-c', 'approval_policy="never"', '--skip-git-repo-check', '-'],
        },
        permission: { presets: { 'read-only': 'supported', 'workspace-write': 'supported', unattended: 'supported' } },
        resume: { kind: 'flag', cross_process: true },
        parser: 'codex-exec',
    }
}

function request(overrides = {}) {
    return {
        schema_version: '1.0.0',
        run_id: 'run_20260910_00000000',
        fingerprint: 'sha256:x',
        endpoint: 'codex',
        cwd: 'D:/w',
        add_dirs: [],
        task_file: null,
        task_text: 'do the thing',
        mode: 'workspace-write',
        model: null,
        effort: null,
        resume_session: null,
        deliverables: [],
        created_at: '2026-09-10T00:00:00.000Z',
        warnings: [],
        ...overrides,
    }
}

test('fresh run renders mode_args (exec + sandbox) in front of the argv tail', () => {
    const args = buildArgs(codexLike(), request())
    assert.deepEqual(args, ['exec', '-s', 'workspace-write', '--json', '-c', 'approval_policy="never"', '--skip-git-repo-check', '-'])
})

test('resume renders resume_argv instead of argv; mode_args/add_dir are NOT spliced; -m still is', () => {
    const args = buildArgs(codexLike(), request({ resume_session: 'thread-123', model: 'gpt-5' }))
    assert.deepEqual(args, [
        '-m', 'gpt-5',
        'exec', 'resume', 'thread-123', '--json', '-c', 'approval_policy="never"', '--skip-git-repo-check', '-',
    ])
    assert.ok(!args.includes('-s'), 'sandbox flag must not appear on resume')
})

test('resume with add_dirs is rejected when resume_argv is in play', () => {
    assert.throws(
        () => buildArgs(codexLike(), request({ resume_session: 'thread-123', add_dirs: ['D:/other'] })),
        /add_dirs on resume/,
    )
})

test('endpoints without resume_argv keep the legacy resume.args + mode_args behavior', () => {
    const kimiLike = {
        schema_version: '1.0.0',
        name: 'kimi-code',
        detect: { bin: 'kimi' },
        command: { argv: ['{bin}', '-p', '{prompt}', '--output-format', 'stream-json'], prompt_delivery: 'argv' },
        permission: { presets: { 'workspace-write': 'supported' } },
        resume: { kind: 'flag', args: ['-S', '{session}'] },
        parser: 'kimi-print',
    }
    const args = buildArgs(kimiLike, request({ resume_session: 'session_abc' }))
    assert.deepEqual(args, ['-S', 'session_abc', '-p', 'do the thing', '--output-format', 'stream-json'])
})

test('pickProbePreset: workspace-write > unattended > read-only; null when none supported', () => {
    const m = codexLike()
    assert.equal(pickProbePreset(m), 'workspace-write')
    assert.equal(pickProbePreset({ ...m, permission: { presets: { 'read-only': 'unsupported', 'workspace-write': 'unsupported', unattended: 'supported' } } }), 'unattended')
    assert.equal(pickProbePreset({ ...m, permission: { presets: { 'read-only': 'supported', 'workspace-write': 'unsupported', unattended: 'unsupported' } } }), 'read-only')
    assert.equal(pickProbePreset({ ...m, permission: { presets: { 'read-only': 'unsupported' } } }), null)
    assert.equal(pickProbePreset({ ...m, permission: { presets: { 'workspace-write': 'soft' } } }), null)
})
