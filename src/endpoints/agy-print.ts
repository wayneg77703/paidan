// agy (Antigravity CLI) print-mode output parser ("agy-print"). Parser only.
// Verified against live 1.1.28 stream captures (2026-09-10 native zero-copy
// probe; raw captures distilled, scratch deleted 2026-09-13): stdout NDJSON = init{conversation_id,
// init:{cwd,tools,permission_mode}} -> step_update (agent_response text_delta;
// tool ERROR with tool_info.error TOOL_ERROR for rule-based denials) -> one
// terminal result{conversation_id,status,response,usage:{input_tokens,
// output_tokens,thinking_tokens,cache_read_tokens},denied_actions?[]}.
// Refusals are in-band at exit 0 (soft deny): denied_actions + permission
// TOOL_ERRORs; stderr carries the jetski auto-deny line and the 1.1.28
// print-timeout marker — surfaced via detectRefusals.
// Unknown output degrades (degraded=true), it never crashes.

import type { UsageSummary } from '../engine/types.js'
import type { EndpointParseResult, EndpointStreamParser } from './parser-api.js'
export { discoverModels, readNativeDefaults, validateSelection } from './agy-models.js'

export type AgyParseResult = EndpointParseResult

export type AgyPrintParser = EndpointStreamParser

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Permission-denial TOOL_ERROR message forms observed on 1.1.28. */
const PERMISSION_ERROR_RE = /permission check failed|permission denied|user denied permission|soft[- ]denied|requires approval|approval denied|not permitted/i
const safeInt = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null)

/** result.usage: {input_tokens, output_tokens, thinking_tokens, cache_read_tokens}. */
export function readAgyUsage(value: unknown): UsageSummary | null {
    if (!isRecord(value)) return null
    const input = safeInt(value.input_tokens)
    const output = safeInt(value.output_tokens)
    const cached = safeInt(value.cache_read_tokens)
    if (input === null && output === null && cached === null) return null
    return { input_tokens: input, output_tokens: output, cached_input_tokens: cached, cost: null, source: 'provider' }
}

export function createAgyPrintParser(): AgyPrintParser {
    let resultText: string | null = null
    let fallbackText = ''
    let sawResult = false
    let resultCount = 0
    let initConversationId: string | null = null
    let resultConversationId: string | null = null
    let resultStatus: string | null = null
    let usage: UsageSummary | null = null
    const refusals: string[] = []
    const warnings: string[] = []
    let degraded = false

    function parseStdoutLine(line: string): void {
        const trimmed = line.trim()
        if (!trimmed) return
        let obj: unknown
        try {
            obj = JSON.parse(trimmed)
        } catch {
            degraded = true
            warnings.push('non-JSON stdout line; parser degraded')
            return
        }
        if (!isRecord(obj)) return
        if (obj.event === 'init') {
            if (typeof obj.conversation_id === 'string') initConversationId = obj.conversation_id
            return
        }
        if (obj.event === 'step_update' && isRecord(obj.step_update)) {
            const su = obj.step_update
            if (su.step_type === 'agent_response' && typeof su.text_delta === 'string') {
                fallbackText += su.text_delta
            }
            if (su.state === 'ERROR' && isRecord(su.tool_info) && isRecord(su.tool_info.error)) {
                const tool = typeof su.tool_name === 'string' ? su.tool_name
                    : typeof su.tool_info.name === 'string' ? su.tool_info.name : 'unknown-tool'
                const message = typeof su.tool_info.error.message === 'string' ? su.tool_info.error.message : ''
                if (PERMISSION_ERROR_RE.test(message)) {
                    refusals.push(`permission-error:${tool}`)
                    warnings.push(`endpoint denied ${tool}: ${message.slice(0, 160)}`)
                } else {
                    warnings.push(`tool ${tool} reported error: ${message.slice(0, 160) || 'unknown'}`)
                }
            }
            return
        }
        if (obj.event === 'result' && isRecord(obj.result)) {
            resultCount += 1
            if (sawResult) return // exactly one terminal envelope; extras are drift
            sawResult = true
            const r = obj.result
            if (typeof r.response === 'string') resultText = r.response
            if (typeof r.conversation_id === 'string') resultConversationId = r.conversation_id
            if (typeof r.status === 'string') resultStatus = r.status
            usage = readAgyUsage(r.usage)
            for (const d of Array.isArray(r.denied_actions) ? r.denied_actions : []) {
                const action = isRecord(d) && typeof d.action === 'string' ? d.action : 'unknown-action'
                refusals.push(`denied:${action}`)
                warnings.push(`endpoint denied action: ${action}`)
            }
            return
        }
        // every other event is recorded by the caller's event log, not by the parser
    }

    return {
        acceptStdoutLine: parseStdoutLine,
        acceptStderrLine: () => {},
        finish(tailStdout: string, _tailStderr: string): AgyParseResult {
            if (tailStdout.trim()) {
                degraded = true
                warnings.push('stdout ended mid-line; stream may be incomplete')
            }
            if (resultCount > 1) warnings.push(`expected one result event, got ${resultCount}; kept the first`)
            if (initConversationId && resultConversationId && initConversationId !== resultConversationId) {
                degraded = true
                warnings.push(`conflicting conversation ids (init ${initConversationId}, result ${resultConversationId})`)
            }
            if (!sawResult) warnings.push('no result event; final text fell back to accumulated agent_response deltas')
            if (resultStatus !== null && resultStatus !== 'SUCCESS') {
                refusals.push(`result-status:${resultStatus}`)
                warnings.push(`result status is ${resultStatus}, not SUCCESS`)
            }
            const sessionId = initConversationId ?? resultConversationId
            return {
                finalText: resultText ?? fallbackText,
                sessionId,
                usage, refusals, degraded, warnings,
            }
        },
    }
}

/** Endpoint refusal/incompletion signals from the full stderr capture + exit code. */
export function detectRefusals(stderrText: string, _exitCode: number | null): string[] {
    const out: string[] = []
    if (/required the "[^"]+" permission that headless mode cannot prompt for/i.test(stderrText)) {
        out.push('headless-permission-auto-deny')
    }
    if (/\[agy\] print timeout after/i.test(stderrText)) {
        // 1.1.28: print-timeout = partial output + exit 0 + SUCCESS (probe report §8)
        out.push('print-timeout-partial-output')
    }
    return out
}

export const createParser = createAgyPrintParser
