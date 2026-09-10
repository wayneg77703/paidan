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

export interface NativeDefaults {
    /** the native config's current default model; null = unset (built-in default) */
    model?: string | null
    /** the native config's current effort/thinking level; null = unset */
    effort?: string | null
    notes?: string[]
}

export interface EndpointParserModule {
    createParser(): EndpointStreamParser
    detectRefusals(stderrText: string, exitCode: number | null): string[]
    discoverModels?(): Promise<DiscoverModelsResult>
    /**
     * Optional read-only probe of the endpoint's native home: what model/effort
     * the agent's own configuration currently carries. Displayed by init/doctor
     * as the "native default" reality (invariant 4: read-only, never written).
     * Absent = this endpoint has no probed native surface.
     */
    readNativeDefaults?(): Promise<NativeDefaults>
    /**
     * Optional post-terminal ledger observation (e.g. kimi's native session
     * wire.jsonl). Called only when the stream parser produced no usage.
     * `resume` marks resume runs whose ledger contains earlier turns; `cursor`
     * is the opaque pre-spawn capture from captureLedgerCursor (undefined when
     * none was taken). Must return null usage rather than fabricate numbers.
     */
    readLedgerUsage?(sessionHandle: string, opts: { resume: boolean; cursor?: unknown }): Promise<LedgerReadResult>
    /**
     * Optional pre-spawn ledger cursor capture (resume runs only). The worker
     * stores the returned value in memory and hands it back to readLedgerUsage;
     * null means "ledger absent pre-spawn" (fresh semantics), a throw means
     * "cursor unavailable".
     */
    captureLedgerCursor?(sessionHandle: string): Promise<unknown>
}

export interface LedgerReadResult {
    usage: UsageSummary | null
    warnings: string[]
}
