// Table-driven terminal judgment (src/engine/terminal.ts).
// Invariants under test: evidence-first order; exit 0 alone is never success;
// unknown is a legal terminal state; refusals are evidence, not auto-failure.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { judgeTerminal } from '../dist/engine/terminal.js'

const PARSER_OK = { type: 'kimi-print', degraded: false }
const NO_CAPS = {}

const CASES = [
    {
        name: 'exit 0 with final text and no deliverables -> completed',
        input: { exit_code: 0, signal: null, final_text: 'done', deliverables_declared: false, deliverables: [], refusals: [], parser: PARSER_OK, capabilities: NO_CAPS },
        state: 'completed',
    },
    {
        name: 'exit 0 but no evidence at all -> unknown (exit 0 is never success by itself)',
        input: { exit_code: 0, signal: null, final_text: '', deliverables_declared: false, deliverables: [], refusals: [], parser: PARSER_OK, capabilities: NO_CAPS },
        state: 'unknown',
    },
    {
        name: 'exit 0 with all declared deliverables found -> completed',
        input: {
            exit_code: 0, signal: null, final_text: '', deliverables_declared: true,
            deliverables: [{ path: 'probe-write.txt', expected: 'tok', found: true }],
            refusals: [], parser: PARSER_OK, capabilities: NO_CAPS,
        },
        state: 'completed',
    },
    {
        name: 'exit 0 with a declared deliverable missing -> failed',
        input: {
            exit_code: 0, signal: null, final_text: 'done', deliverables_declared: true,
            deliverables: [{ path: 'probe-write.txt', expected: null, found: false }],
            refusals: [], parser: PARSER_OK, capabilities: NO_CAPS,
        },
        state: 'failed',
    },
    {
        name: 'non-zero exit with complete deliverables + manifest declares the shape -> completed',
        input: {
            exit_code: 1, signal: null, final_text: '', deliverables_declared: true,
            deliverables: [{ path: 'out.txt', expected: null, found: true }],
            refusals: [], parser: PARSER_OK, capabilities: { completed_nonzero_exit: true },
        },
        state: 'completed',
    },
    {
        name: 'non-zero exit with complete deliverables but manifest silent -> unknown (default per evidence)',
        input: {
            exit_code: 1, signal: null, final_text: '', deliverables_declared: true,
            deliverables: [{ path: 'out.txt', expected: null, found: true }],
            refusals: [], parser: PARSER_OK, capabilities: NO_CAPS,
        },
        state: 'unknown',
    },
    {
        name: 'non-zero exit, no deliverables, no refusal -> failed',
        input: { exit_code: 2, signal: null, final_text: '', deliverables_declared: false, deliverables: [], refusals: [], parser: PARSER_OK, capabilities: NO_CAPS },
        state: 'failed',
    },
    {
        name: 'killed by a signal outside cancel -> failed',
        input: { exit_code: null, signal: 'SIGTERM', final_text: '', deliverables_declared: false, deliverables: [], refusals: [], parser: PARSER_OK, capabilities: NO_CAPS },
        state: 'failed',
    },
    {
        name: 'endpoint refusal signal with exit 0 -> unknown, not automatic failure',
        input: { exit_code: 0, signal: null, final_text: '', deliverables_declared: false, deliverables: [], refusals: ['provider-safety-blocked'], parser: PARSER_OK, capabilities: NO_CAPS },
        state: 'unknown',
    },
    {
        name: 'refusal outranks exit code: refusal + exit 1 -> unknown',
        input: { exit_code: 1, signal: null, final_text: '', deliverables_declared: false, deliverables: [], refusals: ['provider-safety-blocked'], parser: PARSER_OK, capabilities: NO_CAPS },
        state: 'unknown',
    },
    {
        name: 'parser degraded with exit 0 and text -> unknown (cannot trust extraction)',
        input: { exit_code: 0, signal: null, final_text: 'done', deliverables_declared: false, deliverables: [], refusals: [], parser: { type: 'kimi-print', degraded: true }, capabilities: NO_CAPS },
        state: 'unknown',
    },
    {
        name: 'deliverable evidence outranks parser degradation when all found',
        input: {
            exit_code: 0, signal: null, final_text: '', deliverables_declared: true,
            deliverables: [{ path: 'out.txt', expected: null, found: true }],
            refusals: [], parser: { type: 'kimi-print', degraded: true }, capabilities: NO_CAPS,
        },
        state: 'completed',
    },
]

for (const c of CASES) {
    test(c.name, () => {
        const judgment = judgeTerminal(c.input)
        assert.equal(judgment.state, c.state, `notes: ${judgment.notes.join('; ')}`)
        assert.ok(Array.isArray(judgment.notes))
    })
}
