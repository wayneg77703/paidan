// dsh headless plain-text parser ("dsh-headless"). Parser only.
// Verified against dsh 0.1.2-rc.1 (2026-09-10) and the suite's dsh knowledge
// (the retired external-agent-suite dsh adapter + contracts, archived 2026-09-12;
// extractFacts semantics; suite probe runs 23476842/466b67d9 2026-09-09):
//  - stdout is PLAIN TEXT: the final assistant message and nothing else
//    (adapter rule: final = stdout.trim()); reasoning streams to stderr as
//    `dsh: reasoning:` blocks and carries no parser state.
//  - the headless surface returns no session handle (fresh Agent per run by
//    design) and no usage rows (provider_reports_no_usage) — usage stays null,
//    never fabricate zeros.
//  - sandbox/approval refusals EXIT 0 and surface in the final text with
//    tool-emitted signatures (`[sandbox: file access denied under read-only
//    mode]`, `requires approval, but no approval channel is available`), so
//    refusal detection never gates on the exit code.
// A plain-text stream has no structure to violate: this parser never sets
// degraded. An empty final text is terminal judgment's business, not ours.

import type { EndpointParseResult, EndpointStreamParser } from './parser-api.js'
export { discoverModels, readNativeDefaults } from './dsh-models.js'

export interface DshParseResult extends EndpointParseResult {
/** dsh never reports usage on the headless stream; always null */
    usage: null
    /** in-band refusal evidence from the final text (denial signatures) */
}

export interface DshHeadlessParser extends EndpointStreamParser {

    finish(tailStdout: string, tailStderr: string): DshParseResult
}

// Refusal signatures observed in dsh 0.1.2-rc.1 final text (suite P2 run
// 466b67d9: `[sandbox: file access denied under read-only mode]`; raw paidan
// re-verification 2026-09-10: `file access denied under read-only mode`
// without the bracket prefix). Both are tool-emitted strings the model quotes
// verbatim; they can also leak into the stderr reasoning stream.
const SANDBOX_DENIED_RE = /file access denied under [\w-]+ mode/i
const NO_APPROVAL_CHANNEL_RE = /requires approval, but no approval channel is available/i
// Model-paraphrased variants of the same tool denials (live: paidan run
// run_20260910_e092fee4, 2026-09-10: "the sandbox is in read-only mode, so the
// write was denied ... requires an approval channel that isn't available").
const SANDBOX_MODE_PARAPHRASE_RE = /sandbox is in [\w-]+ mode/i
const APPROVAL_PARAPHRASE_RE = /requires an approval channel that (?:isn't|is not) available/i

function refusalSignals(text: string): string[] {
    const signals = new Set<string>()
    if (SANDBOX_DENIED_RE.test(text) || SANDBOX_MODE_PARAPHRASE_RE.test(text)) signals.add('sandbox-file-access-denied')
    if (NO_APPROVAL_CHANNEL_RE.test(text) || APPROVAL_PARAPHRASE_RE.test(text)) signals.add('approval-channel-unavailable')
    return [...signals]
}

export function createDshHeadlessParser(): DshHeadlessParser {
    const chunks: string[] = []
    const warnings: string[] = []

    return {
        acceptStdoutLine(line: string): void {
            chunks.push(line)
        },
        acceptStderrLine(): void {
            // stderr is the reasoning stream; refusal detection over the full
            // capture is detectRefusals' job, not streaming parser state
        },
        finish(tailStdout: string, _tailStderr: string): DshParseResult {
            // plain text: a mid-line tail is just more of the final message
            if (tailStdout) chunks.push(tailStdout)
            const finalText = chunks.join('\n').trim()
            return {
                finalText,
                sessionId: null,
                usage: null,
                refusals: refusalSignals(finalText),
                degraded: false,
                warnings,
            }
        },
    }
}

/** Endpoint refusal signals from the full stderr capture. No exit-code gating: dsh exits 0 on refusals. */
export function detectDshRefusals(stderrText: string, _exitCode: number | null): string[] {
    return refusalSignals(stderrText)
}

export const createParser = createDshHeadlessParser
export const detectRefusals = detectDshRefusals
