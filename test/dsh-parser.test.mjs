// Golden fixtures for the dsh-headless parser (src/endpoints/dsh-headless.ts).
// Text shapes mirror dsh 0.1.2-rc.1 live streams and the suite probe runs
// 23476842 (P1 write) / 466b67d9 (P2 read-only refusal) captured 2026-09-09;
// no real agent is touched.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDshHeadlessParser, detectDshRefusals } from '../dist/endpoints/dsh-headless.js'
import { discoverDshModels } from '../dist/endpoints/dsh-models.js'

const P2_FINAL = [
    '无法创建文件 `probe-ro.txt`。',
    '',
    '- 本次任务的工作区 DSH 文件策略为 **read-only（只读）**；',
    '- 我使用 write 工具尝试创建文件时，文件沙箱直接拒绝：`[sandbox: file access denied under read-only mode]`；',
    '- 升级重试返回：`sandbox escalation to "workspace-write" requires approval, but no approval channel is available`；',
    '- 文件确认未创建。',
    '',
    'OK',
].join('\n')

test('normal run: whole stdout is the final text, no session, no usage, never degraded', () => {
    // Live P1 shape (suite run 23476842): stdout "DONE", stderr reasoning blocks.
    const p = createDshHeadlessParser()
    p.acceptStdoutLine('DONE')
    p.acceptStderrLine('dsh: reasoning:')
    p.acceptStderrLine('The task is simple: create file probe-write.txt ...')
    const r = p.finish('', '')
    assert.equal(r.finalText, 'DONE')
    assert.equal(r.sessionId, null)
    assert.equal(r.usage, null)
    assert.equal(r.degraded, false)
    assert.deepEqual(r.refusals, [])
})

test('sandbox refusal run: exit-0 denial surfaces in-band from the final text', () => {
    // Live P2 shape (suite run 466b67d9): exit 0, file absent, signatures in final text.
    const p = createDshHeadlessParser()
    for (const line of P2_FINAL.split('\n')) p.acceptStdoutLine(line)
    const r = p.finish('', '')
    assert.equal(r.degraded, false)
    assert.ok(r.finalText.includes('read-only'))
    assert.deepEqual(r.refusals.sort(), ['approval-channel-unavailable', 'sandbox-file-access-denied'])
})

test('multi-line stdout joins with newlines and trims; mid-line tail is appended, not degraded', () => {
    const p = createDshHeadlessParser()
    p.acceptStdoutLine('first line')
    p.acceptStdoutLine('second line')
    const r = p.finish(' tail-without-newline', '')
    assert.equal(r.finalText, 'first line\nsecond line\n tail-without-newline')
    assert.equal(r.degraded, false)
    assert.deepEqual(r.warnings, [])
})

test('empty stdout yields empty finalText (terminal judgment decides, parser stays neutral)', () => {
    const p = createDshHeadlessParser()
    const r = p.finish('', '')
    assert.equal(r.finalText, '')
    assert.equal(r.degraded, false)
    assert.deepEqual(r.refusals, [])
})

test('detectRefusals: signatures on stderr are flagged without exit-code gating; benign reasoning stays silent', () => {
    const leaked = 'dsh: reasoning:\nThe write failed: [sandbox: file access denied under read-only mode]\n'
    assert.deepEqual(detectDshRefusals(leaked, 0), ['sandbox-file-access-denied'])
    assert.deepEqual(detectDshRefusals(leaked, 1), ['sandbox-file-access-denied'])
    // raw 0.1.2-rc.1 re-verification (2026-09-10) quoted the denial WITHOUT the bracket prefix
    const unbracketed = 'the sandbox denied it (`file access denied under read-only mode`)'
    assert.deepEqual(detectDshRefusals(unbracketed, 0), ['sandbox-file-access-denied'])
    const benign = 'dsh: reasoning:\nThe write was denied under read-only mode. Escalation was rejected.\n'
    assert.deepEqual(detectDshRefusals(benign, 0), [])
    assert.deepEqual(detectDshRefusals('', null), [])
})

test('model-paraphrased denial phrasing is also flagged (live run_20260910_e092fee4)', () => {
    const paraphrased =
        'I could not create `should-not-exist.txt`: the sandbox is in read-only mode, so the write was denied, ' +
        "and escalating to workspace-write requires an approval channel that isn't available in this session."
    assert.deepEqual(detectDshRefusals(paraphrased, 0), ['sandbox-file-access-denied', 'approval-channel-unavailable'])
    const p = createDshHeadlessParser()
    for (const line of paraphrased.split('\n')) p.acceptStdoutLine(line)
    assert.deepEqual(p.finish('', '').refusals, ['sandbox-file-access-denied', 'approval-channel-unavailable'])
})

test('model discovery reads the native settings.yaml agent-default-model block honestly', () => {
    const yaml = [
        'ui-onboarding:',
        '  welcomeNoticeVersion: 2026-08-13.1',
        'agent-default-model:',
        '  provider: deepseek-official',
        '  model: deepseek-v4-flash-vision-exp',
        '  reasoningEffort: max',
        'llm-pi-ai:',
        '  providers: {}',
    ].join('\n')
    const { models, notes } = discoverDshModels(yaml)
    assert.deepEqual(models.map(({ alias, connection, source }) => ({ alias, connection, source })), [{ alias: 'deepseek-official/deepseek-v4-flash-vision-exp', connection: 'deepseek-official', source: 'native-config' }])
    assert.equal(models[0].default_effort, 'max')
    assert.equal(models[0].effort_selectable, false)
    assert.ok(notes.some((n) => n.includes('reasoningEffort=max')))
    assert.deepEqual(discoverDshModels(null).models, [])
    assert.deepEqual(discoverDshModels('ui-onboarding:\n  x: 1\n').models, [])
})
