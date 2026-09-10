// Raw-mode interactive select widgets (zero deps, Node stdlib only) for the
// init wizard, modeled on the @clack/prompts visual grammar that the
// `npx skills` installer uses: ◆/◇ step symbols with a guide bar, ◻/◼
// checkboxes (cyan cursor / green selected), ●/○ radios, dim instruction
// footer, wrap-around cursor, scrolling with "…" overflow markers, and a
// collapsed one-line summary after confirm. The key reducers are pure and
// exported for tests; the rendering shell is the only part that touches the
// TTY. Output goes to stderr (invariant: stdout stays JSON). Unicode symbols
// are used only where the terminal supports them (same detection as clack);
// legacy consoles get ASCII equivalents.

import * as readline from 'node:readline'
import { styleText } from 'node:util'

export interface Key {
    name: string
    ctrl?: boolean
}

export class PromptAbort extends Error {
    constructor() {
        super('prompt aborted by user (Ctrl+C)')
        this.name = 'PromptAbort'
    }
}

export interface CheckboxState {
    cursor: number
    checked: boolean[]
}

export type CheckboxResult = { state: CheckboxState; action: 'continue' | 'confirm' | 'abort' }

/** Checkbox keys: up/k down/j move (wrap-around), space or a digit toggles, a=toggle all, i=invert, enter confirms, Ctrl+C/Esc aborts. */
export function reduceCheckbox(state: CheckboxState, key: Key): CheckboxResult {
    const count = state.checked.length
    if ((key.ctrl && key.name === 'c') || key.name === 'escape') return { state, action: 'abort' }
    if (key.name === 'return') return { state, action: 'confirm' }
    if (key.name === 'up' || key.name === 'k') {
        return { state: { ...state, cursor: (state.cursor - 1 + count) % count }, action: 'continue' }
    }
    if (key.name === 'down' || key.name === 'j') {
        return { state: { ...state, cursor: (state.cursor + 1) % count }, action: 'continue' }
    }
    if (key.name === 'space') {
        const checked = state.checked.slice()
        checked[state.cursor] = !checked[state.cursor]
        return { state: { ...state, checked }, action: 'continue' }
    }
    if (key.name === 'a') {
        const allChecked = state.checked.every(Boolean)
        return { state: { ...state, checked: state.checked.map(() => !allChecked) }, action: 'continue' }
    }
    if (key.name === 'i') {
        return { state: { ...state, checked: state.checked.map((c) => !c) }, action: 'continue' }
    }
    if (/^[1-9]$/.test(key.name)) {
        const idx = Number(key.name) - 1
        if (idx < count) {
            const checked = state.checked.slice()
            checked[idx] = !checked[idx]
            return { state: { cursor: idx, checked }, action: 'continue' }
        }
    }
    return { state, action: 'continue' }
}

export type MenuResult = { cursor: number; action: 'continue' | 'confirm' | 'abort' }

/** Menu keys: up/k down/j move (wrap-around), a digit jumps straight to that choice, enter selects, Ctrl+C/Esc aborts. */
export function reduceMenu(cursor: number, key: Key, count: number): MenuResult {
    if ((key.ctrl && key.name === 'c') || key.name === 'escape') return { cursor, action: 'abort' }
    if (key.name === 'return') return { cursor, action: 'confirm' }
    if (key.name === 'up' || key.name === 'k') return { cursor: (cursor - 1 + count) % count, action: 'continue' }
    if (key.name === 'down' || key.name === 'j') return { cursor: (cursor + 1) % count, action: 'continue' }
    if (/^[1-9]$/.test(key.name)) {
        const idx = Number(key.name) - 1
        if (idx < count) return { cursor: idx, action: 'confirm' }
    }
    return { cursor, action: 'continue' }
}

export interface SelectItem {
    label: string
    hint?: string
}

/** True when the interactive raw-mode UI can run (both streams are TTYs). */
export function rawSelectSupported(): boolean {
    return Boolean(process.stdin.isTTY && process.stderr.isTTY && typeof process.stdin.setRawMode === 'function')
}

// ---- visual grammar (clack-compatible) ----

function isUnicodeSupported(): boolean {
    if (process.platform !== 'win32') return process.env.TERM !== 'linux'
    const env = process.env
    return Boolean(
        env.CI ||
            env.WT_SESSION ||
            env.TERMINUS_SUBLIME ||
            env.ConEmuTask === '{cmd::Cmder}' ||
            env.TERM_PROGRAM === 'Terminus-Sublime' ||
            env.TERM_PROGRAM === 'vscode' ||
            env.TERM === 'xterm-256color' ||
            env.TERM === 'alacritty' ||
            env.TERMINAL_EMULATOR === 'JetBrains-JediTerm',
    )
}

const unicode = isUnicodeSupported()
const unicodeOr = <T>(u: T, a: T): T => (unicode ? u : a)

const S = {
    stepActive: unicodeOr('◆', '*'),
    stepSubmit: unicodeOr('◇', 'o'),
    stepCancel: unicodeOr('■', 'x'),
    bar: unicodeOr('│', '|'),
    barEnd: unicodeOr('└', '—'),
    checkboxActive: unicodeOr('◻', '[•]'),
    checkboxSelected: unicodeOr('◼', '[+]'),
    checkboxInactive: unicodeOr('◻', '[ ]'),
    radioActive: unicodeOr('●', '>'),
    radioInactive: unicodeOr('○', ' '),
    overflow: '...',
} as const

const NAV = unicodeOr('↑/↓', 'up/down')
const dim = (s: string): string => styleText('dim', s)

type StepState = 'active' | 'submit' | 'cancel'

function stepSymbol(state: StepState): string {
    switch (state) {
        case 'active':
            return styleText('cyan', S.stepActive)
        case 'submit':
            return styleText('green', S.stepSubmit)
        case 'cancel':
            return styleText('red', S.stepCancel)
    }
}

/** Frame: lone gray bar, then `<symbol>  message`, then bar-prefixed body lines, optional barEnd line. */
function frame(state: StepState, message: string, body: string[], barEnd: boolean): string[] {
    const barColor = state === 'active' ? 'cyan' : state === 'submit' ? 'green' : 'red'
    const bar = styleText(barColor, S.bar)
    const lines = [styleText('gray', S.bar), `${stepSymbol(state)}  ${message}`]
    for (const line of body) lines.push(`${bar}  ${line}`)
    if (barEnd) lines.push(bar)
    return lines
}

function checkboxOption(item: SelectItem, state: 'active' | 'active-selected' | 'selected' | 'inactive'): string {
    const hint = item.hint ? ` ${dim(`(${item.hint})`)}` : ''
    switch (state) {
        case 'active':
            return `${styleText('cyan', S.checkboxActive)} ${item.label}${hint}`
        case 'active-selected':
            return `${styleText('green', S.checkboxSelected)} ${item.label}${hint}`
        case 'selected':
            return `${styleText('green', S.checkboxSelected)} ${dim(item.label)}${hint}`
        case 'inactive':
            return `${dim(S.checkboxInactive)} ${dim(item.label)}`
    }
}

function radioOption(item: SelectItem, active: boolean): string {
    if (active) return `${styleText('green', S.radioActive)} ${item.label}${item.hint ? ` ${dim(`(${item.hint})`)}` : ''}`
    return `${dim(S.radioInactive)} ${dim(item.label)}`
}

/** Visible window over a long list: keeps the cursor inside, marks overflow with dim "...". */
function visibleWindow(cursor: number, count: number, rows: number): { start: number; end: number; above: boolean; below: boolean } {
    const budget = Math.max(Math.min(count, rows - 7), Math.min(5, count))
    let start = 0
    if (cursor >= budget - 3) start = Math.max(Math.min(cursor - budget + 3, count - budget), 0)
    const end = Math.min(start + budget, count)
    return { start, end, above: start > 0, below: end < count }
}

/** Stream injection point for tests; production callers leave it unset (process.stdin/stderr). */
export interface SelectIO {
    input?: NodeJS.ReadStream & { setRawMode?: (mode: boolean) => void }
    output?: NodeJS.WriteStream
}

/**
 * Run a raw-mode key loop until the reducer confirms or aborts, repainting
 * the frame in place after each key. On confirm the frame collapses into its
 * submitted form (green ◇ + dim summary); on abort it collapses into the
 * cancelled form (red ■). The terminal mode and cursor are restored either way.
 */
async function runSelect<TState>(
    initial: TState,
    step: (state: TState, key: Key) => { state: TState; action: 'continue' | 'confirm' | 'abort' },
    render: (state: TState, phase: 'active' | 'submit' | 'cancel') => string[],
    io: SelectIO = {},
): Promise<TState> {
    const stdin = io.input ?? process.stdin
    const output = io.output ?? process.stderr
    readline.emitKeypressEvents(stdin)
    let drawn = 0
    const repaint = (lines: string[]): void => {
        if (drawn > 0) output.write(`\x1b[${drawn}A\x1b[0J`)
        output.write(lines.map((l) => l + '\n').join(''))
        drawn = lines.length
    }
    const wasRaw = (stdin as { isRaw?: boolean }).isRaw ?? false
    stdin.setRawMode?.(true)
    stdin.resume()
    output.write('\x1b[?25l') // hide the cursor while the widget owns the screen
    try {
        let state = initial
        repaint(render(state, 'active'))
        for (;;) {
            const key = await new Promise<Key>((resolve) => {
                stdin.once('keypress', (_ch: string, k: Key) => resolve({ name: k?.name ?? '', ctrl: k?.ctrl }))
            })
            const next = step(state, key)
            state = next.state
            if (next.action === 'abort') {
                repaint(render(state, 'cancel'))
                throw new PromptAbort()
            }
            if (next.action === 'confirm') {
                repaint(render(state, 'submit'))
                return state
            }
            repaint(render(state, 'active'))
        }
    } finally {
        output.write('\x1b[?25h')
        stdin.setRawMode?.(wasRaw)
        stdin.pause()
    }
}

/**
 * Checkbox multi-select: space (or the item's number) toggles, a=toggle all,
 * i=invert, enter confirms. Returns the selected 0-based indexes.
 */
export async function checkboxSelect(title: string, items: Array<SelectItem & { checked: boolean }>, io: SelectIO = {}): Promise<number[]> {
    if (items.length === 0) return []
    const rows = (io.output ?? process.stderr).rows ?? 24
    const initial: CheckboxState = { cursor: 0, checked: items.map((i) => i.checked) }
    const final = await runSelect(
        initial,
        (s, k) => reduceCheckbox(s, k),
        (s, phase) => {
            if (phase === 'submit') {
                const names = items.filter((_, i) => s.checked[i]).map((i) => i.label)
                return frame('submit', title, [names.length > 0 ? dim(names.join(', ')) : dim('none')], false)
            }
            if (phase === 'cancel') return frame('cancel', title, [], true)
            const win = visibleWindow(s.cursor, items.length, rows)
            const body: string[] = []
            if (win.above) body.push(dim(S.overflow))
            for (let i = win.start; i < win.end; i++) {
                const item = items[i] as SelectItem
                const state = i === s.cursor ? (s.checked[i] ? 'active-selected' : 'active') : s.checked[i] ? 'selected' : 'inactive'
                body.push(checkboxOption(item, state))
            }
            if (win.below) body.push(dim(S.overflow))
            body.push(dim(`${NAV} to navigate • space: select • a: all • i: invert • enter: confirm`))
            return frame('active', title, body, true)
        },
        io,
    )
    return items.map((_, i) => i).filter((i) => final.checked[i])
}

/**
 * Single-select menu: arrows move (wrap-around), a digit jumps straight to a
 * choice, enter selects. Returns the selected 0-based index.
 */
export async function menuSelect(title: string, items: SelectItem[], initialIndex = 0, io: SelectIO = {}): Promise<number> {
    if (items.length === 0) throw new Error('menuSelect requires at least one item')
    const rows = (io.output ?? process.stderr).rows ?? 24
    const cursor = await runSelect(
        Math.max(0, Math.min(initialIndex, items.length - 1)),
        (c, k) => {
            const r = reduceMenu(c, k, items.length)
            return { state: r.cursor, action: r.action }
        },
        (c, phase) => {
            if (phase === 'submit') return frame('submit', title, [dim((items[c] as SelectItem).label)], false)
            if (phase === 'cancel') return frame('cancel', title, [], true)
            const win = visibleWindow(c, items.length, rows)
            const body: string[] = []
            if (win.above) body.push(dim(S.overflow))
            for (let i = win.start; i < win.end; i++) body.push(radioOption(items[i] as SelectItem, i === c))
            if (win.below) body.push(dim(S.overflow))
            body.push(dim(`${NAV} to navigate • enter: select`))
            return frame('active', title, body, true)
        },
        io,
    )
    return cursor
}
