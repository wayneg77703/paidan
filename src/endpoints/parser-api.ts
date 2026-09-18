// Parser module contract. An endpoint manifest's `parser` field names a
// module src/endpoints/<parser>.ts that exports createParser + detectRefusals
// (+ optional discoverModels). Convention-based: adding an endpoint never
// touches engine code.

import type { UsageSummary, ExecutionSelection, ModelSelection } from '../engine/types.js'

export interface EndpointParseResult {
    finalText: string
    sessionId: string | null
    /** null = the endpoint's stream carries no usage; never fabricate zeros */
    usage: UsageSummary | null
    /** in-band refusal evidence (permission denials, soft error items); merged
     *  with stderr-based detectRefusals by the caller, never auto-failure */
    refusals: string[]
    degraded: boolean
    warnings: string[]
    traceId?: string | null
    turnId?: string | null
}

export interface EndpointStreamParser {
    acceptStdoutLine(line: string): void
    acceptStderrLine(line: string): void
    /** call once at stream end; a non-empty tail means the stream ended mid-line */
    finish(tailStdout: string, tailStderr: string): EndpointParseResult
}

export interface ModelEntry {
    label?: string
    alias: string
    connection: string | null
    /** Discovery scope, never a claim that an account can call this model. */
    source?: 'native-config' | 'desktop-config' | 'native-catalog' | 'static-alias'
    /** Omitted/null = unknown; [] = explicitly no selectable reasoning levels. */
    effort_options?: string[] | null
    default_effort?: string | null
    resolved_model?: string | null
    /** Whether this adapter can explicitly set effort on this model/connection. */
    effort_selectable?: boolean
    thinking_required?: boolean
}

export interface ConnectionEntry {
    /** Native record enabled state, not proof of authentication or access. */
    enabled?: boolean
    id: string
    label?: string
    source: string
    /** Configuration evidence only, not authentication or quota verification. */
    auth_type: 'oauth' | 'api-key' | 'unknown'
    access_type?: string
    protocol?: string
}

export interface DiscoverModelsResult {
    models: ModelEntry[]
    notes: string[]
    connections?: ConnectionEntry[]
    native_defaults?: NativeDefaults
    /** Opaque configuration binding for a user-approved fixed selection. */
    selection_context?: string
}

export interface NativeDefaults {
    selection_context?: string
    auth_type?: 'oauth' | 'api-key' | 'unknown'
    profile?: string | null
    /** Configured provider id, where readable; not proof of login or model access. */
    connection?: string | null
    /** the native config's current default model; null = unset (built-in default) */
    model?: string | null
    /** the native config's current effort/thinking level; null = unset */
    effort?: string | null
    thinking_enabled?: boolean | null
    /**
     * Authentication precheck, where implemented. null = unverified; a model
     * name or the presence of config/environment variables does not prove
     * authentication. undefined = the endpoint has no such surface.
     */
    credential_ready?: boolean | null
    notes?: string[]
}

export interface EndpointParserModule {
    createParser(): EndpointStreamParser
    detectRefusals(stderrText: string, exitCode: number | null): string[]
    discoverModels?(opts?: { configBin?: string | null; providerConfig?: string | null; cwd?: string }): Promise<DiscoverModelsResult>
    /**
     * Optional read-only probe of the endpoint's native home: what model/effort
     * the agent's own configuration currently carries. Displayed by init/doctor
     * as the "native default" reality (invariant 4: read-only, never written).
     * Absent = this endpoint has no probed native surface.
     */
    readNativeDefaults?(opts?: { configBin?: string | null; providerConfig?: string | null; cwd?: string }): Promise<NativeDefaults>
    /** Validate explicit overrides and return the inspected native snapshot; no task execution or configuration writes. */
    validateSelection?(selection: { model: string | null; effort: string | null }, opts: { configBin: string | null; cwd?: string }): Promise<NativeDefaults>
    /** Per-turn native evidence; never use historical session rows as current routing evidence. */
    readExecutionSelection?(parsed: EndpointParseResult, opts: { env: NodeJS.ProcessEnv; expected: ModelSelection | null }): Promise<ExecutionSelection>
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
