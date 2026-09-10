// dsh headless plain-text parser ("dsh-headless"). Parser only.
// Verified against dsh 0.1.2-rc.1 (2026-09-10) and the suite's dsh knowledge
// (operations/governance/harnesses/runtime/adapters/dsh.mjs extractFacts,
// contracts/dsh-headless.json, suite probe runs 23476842/466b67d9 2026-09-09):
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

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import type { DiscoverModelsResult, EndpointStreamParser } from './parser-api.js'

export interface DshParseResult {
    finalText: string
    sessionId: string | null
    resumeHint: string | null
    /** dsh never reports usage on the headless stream; always null */
    usage: null
    /** in-band refusal evidence from the final text (denial signatures) */
    refusals: string[]
    degraded: boolean
    warnings: string[]
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
                resumeHint: null,
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

/**
 * v0 model discovery: heuristic read of the native settings.yaml
 * `agent-default-model` block (provider/model/reasoningEffort). dsh is
 * profile-only — no CLI model-list surface, no headless model flag. Honest
 * and read-only; credentials stay behind their apiKeyEnv references.
 */
export function discoverDshModels(settingsYaml: string | null): DiscoverModelsResult {
    const notes: string[] = []
    if (settingsYaml === null) {
        notes.push('native dsh settings.yaml not found; install/login dsh first')
        return { models: [], notes }
    }
    const block = /^agent-default-model:\s*\r?\n((?:[ \t]+\S[^\r\n]*\r?\n?)+)/m.exec(settingsYaml)
    const pick = (key: string): string | null => {
        if (!block) return null
        const m = new RegExp(`^[ \\t]+${key}:\\s*["']?([^"'\r\n]+?)["']?\\s*$`, 'm').exec(block[1] ?? '')
        return m?.[1] ?? null
    }
    const provider = pick('provider')
    const model = pick('model')
    const effort = pick('reasoningEffort')
    if (!provider || !model) {
        notes.push('no agent-default-model provider/model in native settings.yaml; dsh profile default applies')
        return { models: [], notes }
    }
    notes.push(
        'default model from native settings.yaml agent-default-model (profile-only; no CLI model-list surface)' +
        (effort ? `; reasoningEffort=${effort}` : ''),
    )
    return { models: [{ alias: `${provider}/${model}`, connection: provider }], notes }
}

// ---- Convention exports (parser-api.ts): the registry loads these by name ----

export function createParser(): DshHeadlessParser {
    return createDshHeadlessParser()
}

export const detectRefusals = detectDshRefusals

export async function discoverModels(): Promise<DiscoverModelsResult> {
    const dshHome = process.env.DSH_HOME ?? nodePath.join(os.homedir(), '.dsh')
    let yaml: string | null = null
    try {
        yaml = await fs.readFile(nodePath.join(dshHome, 'settings.yaml'), 'utf8')
    } catch {
        yaml = null
    }
    return discoverDshModels(yaml)
}
