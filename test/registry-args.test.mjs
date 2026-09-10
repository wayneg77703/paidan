// buildArgs resume_argv rendering + pickProbePreset selection (registry.ts).

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
    assertSafeSubstitutionValue,
    buildArgs,
    filterSafeAliases,
    pickProbePreset,
    withPromptCwdHint,
} from '../dist/endpoints/registry.js'

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

test('cwd_arg splices AFTER mode_args with {cwd} replaced (opencode run --dir)', () => {
    const opencodeLike = {
        schema_version: '1.0.0',
        name: 'opencode',
        detect: { bin: 'opencode' },
        command: {
            argv: ['{bin}', '--format', 'json'],
            prompt_delivery: 'stdin',
            mode_args: {
                'read-only': ['run', '--agent', 'plan'],
                'workspace-write': ['run', '--agent', 'build'],
                unattended: ['run', '--agent', 'build', '--auto'],
            },
            cwd_arg: ['--dir', '{cwd}'],
        },
        permission: { presets: { 'workspace-write': 'supported' } },
        parser: 'opencode-run',
    }
    const args = buildArgs(opencodeLike, request({ cwd: 'D:/run/root' }))
    // the security order: subcommand (run) and --agent left of --dir; argv tail last
    assert.deepEqual(args, ['run', '--agent', 'build', '--dir', 'D:/run/root', '--format', 'json'])
})

test('cwd_arg omitted from resume_argv rendering (resume restores the session cwd)', () => {
    const args = buildArgs(
        { ...codexLike(), command: { ...codexLike().command, cwd_arg: ['--dir', '{cwd}'] } },
        request({ resume_session: 'thread-123' }),
    )
    assert.ok(!args.includes('--dir'))
})

function kimiLike(hint) {
    return {
        schema_version: '1.0.0',
        name: 'kimi-code',
        detect: { bin: 'kimi' },
        command: {
            argv: ['{bin}', '-p', '{prompt}', '--output-format', 'stream-json'],
            prompt_delivery: 'argv',
            ...(hint === undefined ? {} : { prompt_cwd_hint: hint }),
        },
        permission: { presets: { 'workspace-write': 'supported' } },
        resume: { kind: 'flag', args: ['-S', '{session}'] },
        parser: 'kimi-print',
    }
}

test('prompt_cwd_hint appends the fixed cwd line; default is off', () => {
    const on = withPromptCwdHint(kimiLike(true), 'do the thing', 'D:/w')
    assert.equal(on.appended, true)
    assert.equal(
        on.text,
        'do the thing\n\nThe current working directory is D:/w. Use absolute paths for all file operations.',
    )
    assert.deepEqual(withPromptCwdHint(kimiLike(undefined), 'do the thing', 'D:/w'), { text: 'do the thing', appended: false })
    assert.deepEqual(withPromptCwdHint(kimiLike(false), 'do the thing', 'D:/w'), { text: 'do the thing', appended: false })
})

test('prompt_cwd_hint text flows into argv on fresh and resume deliveries alike', () => {
    const manifest = kimiLike(true)
    const hint = withPromptCwdHint(manifest, request().task_text, 'D:/w')
    const delivery = { ...request(), task_text: hint.text }
    const fresh = buildArgs(manifest, delivery)
    assert.ok(fresh.includes(hint.text), 'fresh argv carries the hinted text')
    const resumed = buildArgs(manifest, { ...delivery, resume_session: 'session_abc' })
    assert.deepEqual(resumed, ['-S', 'session_abc', '-p', hint.text, '--output-format', 'stream-json'])
})

test('buildArgs rejects unsafe {model} substitution values before splicing', () => {
    const m = codexLike()
    // whitespace/quotes/metacharacters and a leading '-' (flag smuggling) are barred
    for (const model of ['-m evil', 'bad model', 'x;rm -rf', 'x"quoted', '-leading-dash', '']) {
        assert.throws(() => buildArgs(m, request({ model })), /unsafe model value/, JSON.stringify(model))
    }
})

test('buildArgs rejects unsafe {session} substitution values before splicing', () => {
    const m = codexLike()
    for (const resume_session of ['sess; rm -rf', '-evil', 'has space', 'line\nbreak']) {
        assert.throws(
            () => buildArgs(m, request({ resume_session })),
            /unsafe session value/,
            JSON.stringify(resume_session),
        )
    }
})

test('provider-scoped models and ordinary session ids within the charset still pass', () => {
    const args = buildArgs(codexLike(), request({ model: 'deepseek/deepseek-v4.flash:thinking', resume_session: 'thread-123' }))
    assert.ok(args.includes('deepseek/deepseek-v4.flash:thinking'))
    assert.ok(args.includes('thread-123'))
})

test('assertSafeSubstitutionValue: boundary length and leading charset', () => {
    assert.equal(assertSafeSubstitutionValue('a'.repeat(128), 'model'), undefined)
    assert.throws(() => assertSafeSubstitutionValue('a'.repeat(129), 'model'), /unsafe model value/)
    assert.throws(() => assertSafeSubstitutionValue('', 'session'), /unsafe session value/)
    assert.equal(assertSafeSubstitutionValue('_ok:1/2.3-x', 'session'), undefined)
})

test('filterSafeAliases drops argv-unsafe aliases and counts them', () => {
    const { models, dropped } = filterSafeAliases([
        { alias: 'gemini-3.8-high', connection: 'google' },
        { alias: 'bad alias', connection: 'google' },
        { alias: '-sneaky', connection: 'google' },
        { alias: 'provider/model:v1', connection: null },
    ])
    assert.deepEqual(models.map((m) => m.alias), ['gemini-3.8-high', 'provider/model:v1'])
    assert.equal(dropped, 2)
    assert.deepEqual(filterSafeAliases([]), { models: [], dropped: 0 })
})

// ---- effort block: splice, membership, no-block rejection ----

function claudeLike() {
    return {
        schema_version: '1.0.0',
        name: 'claude-code',
        detect: { bin: 'claude' },
        command: {
            argv: ['{bin}', '-p', '{prompt}', '--output-format', 'stream-json'],
            prompt_delivery: 'argv',
            model_arg: ['--model', '{model}'],
        },
        effort: { options: ['low', 'medium', 'high', 'xhigh', 'max'], arg: ['--effort', '{effort}'] },
        permission: { presets: { 'workspace-write': 'supported' } },
        resume: { kind: 'flag', args: ['--resume', '{session}'], cross_process: true },
        parser: 'claude-stream-json',
    }
}

test('buildArgs: effort splices after model on fresh runs', () => {
    const argv = buildArgs(claudeLike(), request({ model: 'sonnet', effort: 'high', task_text: 'do it' }))
    const modelIdx = argv.indexOf('--model')
    const effortIdx = argv.indexOf('--effort')
    assert.ok(modelIdx > -1 && effortIdx > modelIdx)
    assert.equal(argv[effortIdx + 1], 'high')
    assert.ok(argv.includes('do it'))
})

test('buildArgs: effort splices on resume too (flag-style resume)', () => {
    const argv = buildArgs(claudeLike(), request({ resume_session: 'sess-1', effort: 'max', task_text: 'again' }))
    assert.ok(argv.includes('--resume'))
    const effortIdx = argv.indexOf('--effort')
    assert.ok(effortIdx > -1)
    assert.equal(argv[effortIdx + 1], 'max')
})

test('buildArgs: effort without a manifest block is rejected; unknown values are rejected', () => {
    const noBlock = codexLike()
    assert.throws(() => buildArgs(noBlock, request({ effort: 'high' })), /has no effort selection/)
    assert.throws(() => buildArgs(claudeLike(), request({ effort: 'ultra' })), /not one of claude-code's options: low, medium, high, xhigh, max/)
})
