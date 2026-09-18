// tty-select key reducers (pure): checkbox toggle/all/invert/digit/confirm/
// abort with wrap-around cursor, and menu move/digit-jump/confirm/abort. The
// rendering shell needs a real TTY and is covered by manual init validation.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { reduceCheckbox, reduceMenu } from '../dist/tty-select.js'

const key = (name, ctrl = false) => ({ name, ctrl })

test('reduceCheckbox: arrows move with wrap-around, space toggles at cursor', () => {
    let s = { cursor: 0, checked: [true, true, true] }
    assert.equal(reduceCheckbox(s, key('up')).state.cursor, 2) // wraps to the bottom
    s = reduceCheckbox(s, key('down')).state
    assert.equal(s.cursor, 1)
    s = reduceCheckbox(s, key('space')).state
    assert.deepEqual(s.checked, [true, false, true])
    s = reduceCheckbox(s, key('space')).state
    assert.deepEqual(s.checked, [true, true, true])
    s = reduceCheckbox(s, key('down')).state
    s = reduceCheckbox(s, key('down')).state
    assert.equal(s.cursor, 0) // wrapped to the top
    s = reduceCheckbox(s, key('k')).state
    assert.equal(s.cursor, 2) // k wraps the same way
    s = reduceCheckbox(s, key('j')).state
    assert.equal(s.cursor, 0)
    s = reduceCheckbox(s, key('j')).state
    assert.equal(s.cursor, 1)
})

test('reduceCheckbox: a toggles all, i inverts, digits toggle the nth item', () => {
    let s = { cursor: 0, checked: [false, true, false] }
    s = reduceCheckbox(s, key('a')).state
    assert.deepEqual(s.checked, [true, true, true]) // not all checked -> select all
    s = reduceCheckbox(s, key('a')).state
    assert.deepEqual(s.checked, [false, false, false]) // all checked -> clear
    s = { cursor: 0, checked: [false, true, false] }
    s = reduceCheckbox(s, key('i')).state
    assert.deepEqual(s.checked, [true, false, true])
    const r = reduceCheckbox(s, key('2'))
    assert.deepEqual(r.state.checked, [true, true, true])
    assert.equal(r.state.cursor, 1) // digit also moves the cursor
    // out-of-range digit is a no-op
    assert.deepEqual(reduceCheckbox(s, key('9')).state, s)
})

test('reduceCheckbox: enter confirms, Ctrl+C and Esc abort, other keys continue', () => {
    const s = { cursor: 0, checked: [true] }
    assert.equal(reduceCheckbox(s, key('return')).action, 'confirm')
    assert.equal(reduceCheckbox(s, key('c', true)).action, 'abort')
    assert.equal(reduceCheckbox(s, key('escape')).action, 'abort')
    assert.equal(reduceCheckbox(s, key('x')).action, 'continue')
    assert.equal(reduceCheckbox(s, key('c')).action, 'continue') // no ctrl = no abort
})

test('reduceMenu: arrows wrap, digit jumps straight to confirm, enter selects', () => {
    assert.equal(reduceMenu(0, key('up'), 3).cursor, 2) // wraps
    assert.equal(reduceMenu(0, key('down'), 3).cursor, 1)
    assert.equal(reduceMenu(2, key('down'), 3).cursor, 0) // wraps
    assert.equal(reduceMenu(1, key('k'), 3).cursor, 0)
    assert.equal(reduceMenu(1, key('j'), 3).cursor, 2)
    const jump = reduceMenu(0, key('3'), 3)
    assert.equal(jump.cursor, 2)
    assert.equal(jump.action, 'confirm')
    assert.equal(reduceMenu(0, key('9'), 3).action, 'continue')
    assert.equal(reduceMenu(1, key('return'), 3).action, 'confirm')
    assert.equal(reduceMenu(1, key('c', true), 3).action, 'abort')
    assert.equal(reduceMenu(1, key('escape'), 3).action, 'abort')
})

// ---- rendering shell: driven through injected fake streams (no real TTY) ----

import { PassThrough } from 'node:stream'
import { checkboxSelect, menuSelect, PromptAbort } from '../dist/tty-select.js'

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')

function fakeIO() {
    const input = new PassThrough()
    const output = new PassThrough()
    let captured = ''
    output.on('data', (chunk) => (captured += chunk.toString('utf8')))
    const type = async (bytes) => {
        input.write(bytes)
        await new Promise((r) => setImmediate(r))
    }
    return { input, output, type, text: () => stripAnsi(captured), raw: () => captured }
}

test('checkboxSelect shell: frame, toggle, submit collapse, selected indexes', async () => {
    const io = fakeIO()
    const promise = checkboxSelect('Enable endpoints', [
        { label: 'agy', hint: '14 models', checked: true },
        { label: 'codex', checked: true },
        { label: 'kimi-code', checked: false },
    ], io)
    await new Promise((r) => setImmediate(r))
    // initial frame: title, guide bar, checkbox glyphs (√/×, ASCII [x]/[ ]), instruction footer, cursor hidden
    assert.match(io.text(), /Enable endpoints/)
    assert.match(io.text(), /(√|×|\[x\]|\[ \])/)
    assert.match(io.text(), /to navigate • space: select • a: all • i: invert • enter: confirm/)
    assert.match(io.raw(), /\x1b\[\?25l/)
    // move to kimi-code, check it, then uncheck agy via digit, confirm
    await io.type('\u001b[B')
    await io.type('\u001b[B')
    await io.type(' ')
    await io.type('1') // digit toggles agy off and moves the cursor there
    await io.type('\r')
    const picked = await promise
    assert.deepEqual(picked, [1, 2])
    // submit frame collapses to a dim summary line with the picked labels
    assert.match(io.text(), /Enable endpoints[\s\S]*codex, kimi-code/)
    assert.match(io.raw(), /\x1b\[\?25h$/)
})

test('checkboxSelect shell: rapid keys fired in one chunk are queued, not dropped', async () => {
    const io = fakeIO()
    const promise = checkboxSelect('Enable endpoints', [
        { label: 'agy', checked: false },
        { label: 'codex', checked: false },
        { label: 'kimi-code', checked: false },
    ], io)
    await new Promise((r) => setImmediate(r))
    // down, down, space, enter — all at once; the persistent listener queues them
    await io.type('\u001b[B\u001b[B \r')
    assert.deepEqual(await promise, [2])
})

test('checkboxSelect shell: empty selection renders "none" in the summary', async () => {
    const io = fakeIO()
    const promise = checkboxSelect('Enable endpoints', [{ label: 'agy', checked: false }], io)
    await new Promise((r) => setImmediate(r))
    await io.type('\r')
    assert.deepEqual(await promise, [])
    assert.match(io.text(), /Enable endpoints[\s\S]*none/)
})

test('menuSelect shell: frame, move, submit collapse, selected index', async () => {
    const io = fakeIO()
    const promise = menuSelect('Default endpoint', [{ label: 'agy' }, { label: 'codex' }, { label: 'kimi-code' }], 0, io)
    await new Promise((r) => setImmediate(r))
    assert.match(io.text(), /Default endpoint/)
    assert.match(io.text(), /(●|>)/)
    assert.match(io.text(), /to navigate • enter: select/)
    await io.type('\u001b[B')
    await io.type('\r')
    assert.equal(await promise, 1)
    assert.match(io.text(), /Default endpoint[\s\S]*codex/)
})

test('checkboxSelect shell: Ctrl+C aborts with PromptAbort and a cancel frame', async () => {
    const io = fakeIO()
    const promise = checkboxSelect('Enable endpoints', [{ label: 'agy', checked: true }], io)
    const assertion = assert.rejects(promise, (err) => err instanceof PromptAbort)
    await new Promise((r) => setImmediate(r))
    await io.type('\u0003')
    await assertion
    assert.match(io.raw(), /\x1b\[\?25h$/)
})
