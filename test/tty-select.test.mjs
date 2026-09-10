// tty-select key reducers (pure): checkbox toggle/all/none/digit/confirm/abort
// and menu move/digit-jump/confirm/abort. The rendering shell needs a real TTY
// and is covered by manual init validation instead.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { reduceCheckbox, reduceMenu } from '../dist/tty-select.js'

const key = (name, ctrl = false) => ({ name, ctrl })

test('reduceCheckbox: arrows move with clamping, space toggles at cursor', () => {
    let s = { cursor: 0, checked: [true, true, true] }
    assert.deepEqual(reduceCheckbox(s, key('up')).state.cursor, 0) // clamped at top
    s = reduceCheckbox(s, key('down')).state
    assert.equal(s.cursor, 1)
    s = reduceCheckbox(s, key('space')).state
    assert.deepEqual(s.checked, [true, false, true])
    s = reduceCheckbox(s, key('space')).state
    assert.deepEqual(s.checked, [true, true, true])
    s = reduceCheckbox(s, key('down')).state
    s = reduceCheckbox(s, key('down')).state
    assert.equal(s.cursor, 2) // clamped at bottom
    s = reduceCheckbox(s, key('k')).state
    assert.equal(s.cursor, 1)
    s = reduceCheckbox(s, key('j')).state
    assert.equal(s.cursor, 2)
})

test('reduceCheckbox: a=all, n=none, digits toggle the nth item', () => {
    let s = { cursor: 0, checked: [false, false, false] }
    s = reduceCheckbox(s, key('a')).state
    assert.deepEqual(s.checked, [true, true, true])
    s = reduceCheckbox(s, key('n')).state
    assert.deepEqual(s.checked, [false, false, false])
    const r = reduceCheckbox(s, key('2'))
    assert.deepEqual(r.state.checked, [false, true, false])
    assert.equal(r.state.cursor, 1) // digit also moves the cursor
    // out-of-range digit is a no-op
    assert.deepEqual(reduceCheckbox(s, key('9')).state, s)
})

test('reduceCheckbox: enter confirms, Ctrl+C aborts, other keys continue', () => {
    const s = { cursor: 0, checked: [true] }
    assert.equal(reduceCheckbox(s, key('return')).action, 'confirm')
    assert.equal(reduceCheckbox(s, key('c', true)).action, 'abort')
    assert.equal(reduceCheckbox(s, key('x')).action, 'continue')
    assert.equal(reduceCheckbox(s, key('c')).action, 'continue') // no ctrl = no abort
})

test('reduceMenu: arrows clamp, digit jumps straight to confirm, enter selects', () => {
    assert.equal(reduceMenu(0, key('up'), 3).cursor, 0)
    assert.equal(reduceMenu(0, key('down'), 3).cursor, 1)
    assert.equal(reduceMenu(2, key('down'), 3).cursor, 2)
    assert.equal(reduceMenu(1, key('k'), 3).cursor, 0)
    assert.equal(reduceMenu(1, key('j'), 3).cursor, 2)
    const jump = reduceMenu(0, key('3'), 3)
    assert.equal(jump.cursor, 2)
    assert.equal(jump.action, 'confirm')
    assert.equal(reduceMenu(0, key('9'), 3).action, 'continue')
    assert.equal(reduceMenu(1, key('return'), 3).action, 'confirm')
    assert.equal(reduceMenu(1, key('c', true), 3).action, 'abort')
})
