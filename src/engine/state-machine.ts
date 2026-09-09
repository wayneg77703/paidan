// Legal run-state migrations. All state.json writes go through transitionRecord;
// terminal_at is set exactly once, on first entry into a terminal state.

import type { RunState, RunStateRecord } from './types.js'
import { TERMINAL_STATES } from './types.js'

const TRANSITIONS: Readonly<Record<RunState, readonly RunState[]>> = {
    pending: ['running', 'failed', 'cancelled', 'unknown', 'attention'],
    running: ['completed', 'failed', 'cancelled', 'unknown', 'attention'],
    // attention is reconcile-assigned (worker gone). It resolves to a terminal
    // state either by explicit cancel or by adopting an on-disk result.json.
    attention: ['completed', 'failed', 'cancelled', 'unknown'],
    completed: [],
    failed: [],
    cancelled: [],
    unknown: [],
}

export function canTransition(from: RunState, to: RunState): boolean {
    if (from === to) return false
    return TRANSITIONS[from].includes(to)
}

export function isTerminal(state: RunState): boolean {
    return (TERMINAL_STATES as readonly string[]).includes(state)
}

export function transitionRecord(
    current: RunStateRecord,
    to: RunState,
    now: string,
    patch: Partial<Omit<RunStateRecord, 'schema_version' | 'run_id' | 'state' | 'created_at'>> = {},
): RunStateRecord {
    if (!canTransition(current.state, to)) {
        throw new Error(`illegal transition: ${current.state} -> ${to}`)
    }
    const next: RunStateRecord = { ...current, ...patch, state: to, updated_at: now }
    if (isTerminal(to) && current.terminal_at === null) {
        next.terminal_at = now
    }
    return next
}
