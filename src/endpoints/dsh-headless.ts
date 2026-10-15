// DSH 0.2.0-rc.2 --json projection: one root session, current invocation only.
// Missing usage (including unreported retries) remains unknown; no child ledger is implied.
import type { EndpointParseResult, EndpointStreamParser } from './parser-api.js'
export { discoverModels, readNativeDefaults } from './dsh-models.js'
export type DshParseResult = EndpointParseResult
export type DshHeadlessParser = EndpointStreamParser

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
    let sessionId: string | null = null, finalText = '', finalSeen = false, degraded = false
    let incomplete = false, input = 0, output = 0, cached: number | null = 0
    const steps = new Map<string, string>(), openSteps = new Set<string>()
    const warnings = new Set<string>(), refusals = new Set<string>()
    const bad = (why: string) => { degraded = true; incomplete = true; warnings.add(why) }
    const number = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
    const stepKey = (e: Record<string, unknown>): string | null =>
        [e.turn, e.step].every(v => typeof v === 'string' && v.length > 0 || number(v)) ? JSON.stringify([e.turn, e.step]) : null
    const accept = (line: string) => {
        if (!line.trim()) return
        let e: Record<string, unknown>
        try { const v: unknown = JSON.parse(line); if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(); e = v as Record<string, unknown> }
        catch { bad('dsh-json: invalid event; stream content suppressed'); return }
        if (finalSeen) { bad('dsh-json: event after final'); return }
        if (e.type === 'session') {
            if (sessionId !== null || typeof e.sessionId !== 'string' || !e.sessionId || e.truncated === true) bad('dsh-json: invalid or repeated session')
            else sessionId = e.sessionId
        } else if (e.type === 'final') {
            finalSeen = true
            if (typeof e.text !== 'string' || e.truncated === true) bad('dsh-json: invalid final')
            else { finalText = e.text.trim(); for (const signal of refusalSignals(finalText)) refusals.add(signal) }
        } else if (e.type === 'status' && (e.phase === 'step_start' || e.phase === 'step_end')) {
            const key = stepKey(e)
            if (key === null || e.truncated === true) { bad('dsh-json: invalid step identity'); return }
            if (e.phase === 'step_start') { openSteps.add(key); return }
            openSteps.delete(key)
            const fingerprint = JSON.stringify(e.usage ?? null)
            if (steps.has(key)) { if (steps.get(key) !== fingerprint) bad('dsh-json: conflicting duplicate step usage'); return }
            steps.set(key, fingerprint)
            const u = e.usage as Record<string, unknown> | undefined
            if (!u || !number(u.inputTokens) || !number(u.outputTokens)) { incomplete = true; warnings.add('dsh-json: step usage missing or invalid; total unknown'); return }
            input += u.inputTokens; output += u.outputTokens
            cached = cached !== null && number(u.cacheReadTokens) ? cached + u.cacheReadTokens : null
            if (!number(input) || !number(output) || cached !== null && !number(cached)) bad('dsh-json: usage overflow')
        } else if (e.type === 'tool_result') {
            if (typeof e.result === 'string') for (const signal of refusalSignals(e.result)) refusals.add(signal)
        } else if (!['status', 'text', 'thinking', 'tool_call'].includes(String(e.type))) bad('dsh-json: unknown event type')
    }
    return {
        acceptStdoutLine: accept,
        acceptStderrLine() {},
        finish(tailStdout, _tailStderr) {
            if (tailStdout) accept(tailStdout)
            if (!finalSeen || !sessionId || openSteps.size) bad('dsh-json: incomplete root-session stream')
            const usage = steps.size && !incomplete ? { input_tokens: input, output_tokens: output, cached_input_tokens: cached, cost: null, source: 'provider' as const } : null
            if (usage) warnings.add('dsh usage covers only root-session steps in this invocation; child sessions are not included')
            return { finalText, sessionId, usage, refusals: [...refusals], degraded, warnings: [...warnings] }
        },
    }
}

export function detectDshRefusals(stderrText: string, _exitCode: number | null): string[] {
    return refusalSignals(stderrText)
}
export const createParser = createDshHeadlessParser
export const detectRefusals = detectDshRefusals
