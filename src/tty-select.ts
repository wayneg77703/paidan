// Raw-mode interactive select widgets (zero deps, Node stdlib only) for the
// init wizard: checkbox multi-select (space toggles, enter confirms) and
// single-select menu. The key reducers are pure and exported for tests; the
// rendering shell is the only part that touches the TTY. Output goes to
// stderr (invariant: stdout stays JSON), ASCII-only markers so legacy
// console codepages cannot garble the UI.

import * as readline from 'node:readline'

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

/** Checkbox keys: up/k down/j move, space or a digit toggles, a=all, n=none, enter confirms, Ctrl+C aborts. */
export function reduceCheckbox(state: CheckboxState, key: Key): CheckboxResult {
    const count = state.checked.length
    if (key.ctrl && key.name === 'c') return { state, action: 'abort' }
    if (key.name === 'return') return { state, action: 'confirm' }
    if (key.name === 'up' || key.name === 'k') {
        return { state: { ...state, cursor: Math.max(0, state.cursor - 1) }, action: 'continue' }
    }
    if (key.name === 'down' || key.name === 'j') {
        return { state: { ...state, cursor: Math.min(count - 1, state.cursor + 1) }, action: 'continue' }
    }
    if (key.name === 'space') {
        const checked = state.checked.slice()
        checked[state.cursor] = !checked[state.cursor]
        return { state: { ...state, checked }, action: 'continue' }
    }
    if (key.name === 'a') {
        return { state: { ...state, checked: state.checked.map(() => true) }, action: 'continue' }
    }
    if (key.name === 'n') {
        return { state: { ...state, checked: state.checked.map(() => false) }, action: 'continue' }
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

/** Menu keys: up/k down/j move, a digit jumps straight to that choice, enter selects, Ctrl+C aborts. */
export function reduceMenu(cursor: number, key: Key, count: number): MenuResult {
    if (key.ctrl && key.name === 'c') return { cursor, action: 'abort' }
    if (key.name === 'return') return { cursor, action: 'confirm' }
    if (key.name === 'up' || key.name === 'k') return { cursor: Math.max(0, cursor - 1), action: 'continue' }
    if (key.name === 'down' || key.name === 'j') return { cursor: Math.min(count - 1, cursor + 1), action: 'continue' }
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

const CURSOR = ' \x1b[36m>\x1b[0m '
const NO_CURSOR = '   '

/**
 * Run a raw-mode key loop until the reducer confirms or aborts, repainting
 * the block in place after each key. On confirm the block collapses into the
 * summary lines; on abort it collapses to nothing. The terminal mode is
 * restored either way.
 */
async function runSelect<TState>(
    initial: TState,
    step: (state: TState, key: Key) => { state: TState; action: 'continue' | 'confirm' | 'abort' },
    render: (state: TState) => string[],
    summarize: (state: TState) => string,
): Promise<TState> {
    const stdin = process.stdin
    readline.emitKeypressEvents(stdin)
    const wasRaw = (stdin as NodeJS.ReadStream & { isRaw?: boolean }).isRaw ?? false
    let drawn = 0
    const paint = (lines: string[]): void => {
        if (drawn > 0) process.stderr.write(`\x1b[${drawn}A\x1b[0J`)
        process.stderr.write(lines.map((l) => l + '\n').join(''))
        drawn = lines.length
    }
    stdin.setRawMode(true)
    stdin.resume()
    try {
        let state = initial
        paint(render(state))
        for (;;) {
            const key = await new Promise<Key>((resolve) => {
                stdin.once('keypress', (_ch: string, k: Key) => resolve({ name: k?.name ?? '', ctrl: k?.ctrl }))
            })
            const next = step(state, key)
            state = next.state
            if (next.action === 'abort') {
                if (drawn > 0) process.stderr.write(`\x1b[${drawn}A\x1b[0J`)
                throw new PromptAbort()
            }
            if (next.action === 'confirm') {
                if (drawn > 0) process.stderr.write(`\x1b[${drawn}A\x1b[0J`)
                process.stderr.write(summarize(state) + '\n')
                return state
            }
            paint(render(state))
        }
    } finally {
        stdin.setRawMode(wasRaw)
        stdin.pause()
    }
}

/**
 * Checkbox multi-select: space (or the item's number) toggles, a=all,
 * n=none, enter confirms. Returns the selected 0-based indexes.
 */
export async function checkboxSelect(title: string, items: Array<SelectItem & { checked: boolean }>): Promise<number[]> {
    if (items.length === 0) return []
    const initial: CheckboxState = { cursor: 0, checked: items.map((i) => i.checked) }
    const final = await runSelect(
        initial,
        (s, k) => reduceCheckbox(s, k),
        (s) => [
            `${title}  (space: toggle · a: all · n: none · enter: confirm)`,
            ...items.map((item, i) => `${i === s.cursor ? CURSOR : NO_CURSOR}[${s.checked[i] ? 'x' : ' '}] ${item.label}${item.hint ? `  — ${item.hint}` : ''}`),
        ],
        (s) => {
            const names = items.filter((_, i) => s.checked[i]).map((i) => i.label)
            return `${title}: ${names.length > 0 ? names.join(', ') : '(none)'}`
        },
    )
    return items.map((_, i) => i).filter((i) => final.checked[i])
}

/**
 * Single-select menu: arrows move, a digit jumps straight to a choice, enter
 * selects. Returns the selected 0-based index.
 */
export async function menuSelect(title: string, items: SelectItem[], initialIndex = 0): Promise<number> {
    if (items.length === 0) throw new Error('menuSelect requires at least one item')
    const cursor = await runSelect(
        Math.max(0, Math.min(initialIndex, items.length - 1)),
        (c, k) => {
            const r = reduceMenu(c, k, items.length)
            return { state: r.cursor, action: r.action }
        },
        (c) => [
            `${title}  (arrows: move · enter: select)`,
            ...items.map((item, i) => `${i === c ? CURSOR : NO_CURSOR}${item.label}${item.hint ? `  — ${item.hint}` : ''}`),
        ],
        (c) => `${title}: ${(items[c] as SelectItem).label}`,
    )
    return cursor
}
