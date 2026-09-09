// Terminal judgment. Evidence-first, in this exact order (contracts.md §4):
//   1. deliverable evidence
//   2. endpoint refusal signals
//   3. parser-degraded flag
//   4. process exit code (last)
// exit 0 alone is never success; `unknown` is a legal terminal state.

import type { DeliverableEvidence, ParserEvidence, TerminalState } from './types.js'

export interface JudgeInput {
    exit_code: number | null
    signal: string | null
    final_text: string
    /** deliverable specs declared in the request (pre-resolution) */
    deliverables_declared: boolean
    /** resolved evidence: found flags already checked against the filesystem */
    deliverables: DeliverableEvidence[]
    /** endpoint refusal signals (e.g. provider safety block, empty reply signal) */
    refusals: string[]
    parser: ParserEvidence
    /** endpoint manifest capabilities relevant to judgment */
    capabilities: { completed_nonzero_exit?: boolean }
}

export interface Judgment {
    state: TerminalState
    notes: string[]
}

export function judgeTerminal(input: JudgeInput): Judgment {
    const notes: string[] = []
    const exitOk = input.exit_code === 0 && input.signal === null

    // 1. deliverable evidence
    if (input.deliverables_declared) {
        const missing = input.deliverables.filter((d) => !d.found)
        if (missing.length === 0 && input.deliverables.length > 0) {
            if (exitOk) {
                return { state: 'completed', notes: ['all deliverables found'] }
            }
            if (input.capabilities.completed_nonzero_exit === true) {
                notes.push(
                    `all deliverables found with exit_code=${input.exit_code ?? 'null'};` +
                    ' endpoint manifest declares completed_nonzero_exit',
                )
                return { state: 'completed', notes }
            }
            notes.push(
                `deliverables complete but exit_code=${input.exit_code ?? 'null'}` +
                ' and manifest does not declare completed_nonzero_exit',
            )
            return { state: 'unknown', notes }
        }
        if (missing.length > 0) {
            notes.push(`deliverables missing: ${missing.map((d) => d.path).join(', ')}`)
        }
    }

    // 2. endpoint refusal signals — evidence, not automatic failure
    if (input.refusals.length > 0) {
        notes.push(`endpoint refusal signals: ${input.refusals.join('; ')}`)
        return { state: 'unknown', notes }
    }

    // 3. parser degraded — output no longer trustworthy
    if (input.parser.degraded) {
        notes.push(`parser ${input.parser.type} degraded; cannot trust extracted evidence`)
        return { state: 'unknown', notes }
    }

    // 4. exit code, last
    if (!exitOk) {
        notes.push(
            input.signal
                ? `process terminated by signal ${input.signal}`
                : `process exited with code ${input.exit_code ?? 'null'}`,
        )
        return { state: 'failed', notes }
    }
    if (input.deliverables_declared) {
        // exit 0 but declared deliverables are missing (notes already list them)
        return { state: 'failed', notes }
    }
    if (input.final_text.trim().length === 0) {
        notes.push('exit 0 but no final text and no deliverables declared; evidence insufficient')
        return { state: 'unknown', notes }
    }
    return { state: 'completed', notes: ['exit 0 with final text'] }
}
