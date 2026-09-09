// Parser module contract. An endpoint manifest's `parser` field names a
// module src/endpoints/<parser>.ts that exports createParser + detectRefusals
// (+ optional discoverModels). Convention-based: adding an endpoint never
// touches engine code.

import type { UsageSummary } from '../engine/types.js'

export interface EndpointParseResult {
    finalText: string
    sessionId: string | null
    resumeHint: string | null
    /** null = the endpoint's stream carries no usage; never fabricate zeros */
    usage: UsageSummary | null
    /** in-band refusal evidence (permission denials, soft error items); merged
     *  with stderr-based detectRefusals by the caller, never auto-failure */
    refusals: string[]
    degraded: boolean
    warnings: string[]
}

export interface EndpointStreamParser {
    acceptStdoutLine(line: string): void
    acceptStderrLine(line: string): void
    /** call once at stream end; a non-empty tail means the stream ended mid-line */
    finish(tailStdout: string, tailStderr: string): EndpointParseResult
}

export interface ModelEntry {
    alias: string
    connection: string | null
}

export interface DiscoverModelsResult {
    models: ModelEntry[]
    notes: string[]
}

export interface EndpointParserModule {
    createParser(): EndpointStreamParser
    detectRefusals(stderrText: string, exitCode: number | null): string[]
    discoverModels?(): Promise<DiscoverModelsResult>
    /**
     * Optional post-terminal ledger observation (e.g. kimi's native session
     * wire.jsonl). Called only when the stream parser produced no usage.
     * `resume` marks resume runs whose ledger contains earlier turns.
     * Must return null usage rather than fabricate numbers.
     */
    readLedgerUsage?(sessionHandle: string, opts: { resume: boolean }): Promise<LedgerReadResult>
}

export interface LedgerReadResult {
    usage: UsageSummary | null
    warnings: string[]
}
