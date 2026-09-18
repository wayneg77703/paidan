// Shared run-record types. Normative schemas live in docs/contracts.md.

export const RUN_STATES = [
    'pending',
    'running',
    'completed',
    'failed',
    'cancelled',
    'unknown',
    'attention',
] as const
export type RunState = (typeof RUN_STATES)[number]

export const TERMINAL_STATES = ['completed', 'failed', 'cancelled', 'unknown'] as const
export type TerminalState = (typeof TERMINAL_STATES)[number]

export const PERMISSION_PRESETS = ['read-only', 'workspace-write', 'unattended'] as const
export type PermissionPreset = (typeof PERMISSION_PRESETS)[number]

/**
 * Explicit capability set (contracts §2): keys are capability names; a truthy
 * value (true or an options object like {"roots": [...]}) marks the capability
 * as required. Runs with a set splice no preset tier flags (mode_args/mode_env).
 */
export type CapabilitySet = Record<string, boolean | Record<string, unknown>>
export type ModeSelection = PermissionPreset | CapabilitySet

/** Stable canonical form for fingerprints: presets as-is; sets key-sorted deep. */
export function canonicalMode(mode: ModeSelection): string {
    if (typeof mode === 'string') return mode
    const sortDeep = (v: unknown): unknown => {
        if (Array.isArray(v)) return v.map(sortDeep)
        if (v !== null && typeof v === 'object') {
            return Object.fromEntries(
                Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, val]) => [k, sortDeep(val)]),
            )
        }
        return v
    }
    return JSON.stringify(sortDeep(mode))
}

export interface DeliverableSpec {
    path: string
    expected: string | null
}

export interface RunRequest {
    schema_version: '1.0.0'
    run_id: string
    fingerprint: string
    endpoint: string
    cwd: string
    add_dirs: string[]
    task_file: string | null
    task_text: string
    mode: ModeSelection
    model: string | null
    effort: string | null
    /** Configuration at submission; checked again before spawning a bound selection. */
    selection_context?: string
    native_selection?: { connection: string | null; model: string | null; effort: string | null; profile: string | null }
    resume_session: string | null
    /** ZCode native provider file selected at submission. null explicitly follows the original native path. */
    provider_config?: string | null
    /** effective engine wall-clock cap in seconds (0 = disabled); resolved at submit */
    run_timeout_sec: number
    deliverables: DeliverableSpec[]
    created_at: string
    warnings: string[]
}

export interface RunWorkerRef {
    pid: number
    started_at: string
    /** platform process-start token (process-identity.ts); absent on old records or query failure */
    pid_start?: string | null
    endpoint_pid: number | null
    /** start token of the endpoint process; cancel verifies before killing */
    endpoint_pid_start?: string | null
}

export interface RunStateRecord {
    schema_version: '1.0.0'
    run_id: string
    state: RunState
    worker: RunWorkerRef | null
    session: { handle: string | null; resumable: boolean }
    created_at: string
    updated_at: string
    terminal_at: string | null
}

export interface DeliverableEvidence {
    path: string
    expected: string | null
    found: boolean
}

export interface ParserEvidence {
    type: string
    degraded: boolean
}

export type UsageSource = 'provider' | 'endpoint-ledger' | 'unavailable'

export interface UsageSummary {
    input_tokens: number | null
    output_tokens: number | null
    cached_input_tokens: number | null
    /** provider-reported cost (claude total_cost_usd); null when the endpoint has no cost concept */
    cost: number | null
    source: UsageSource
}

export interface RunResult {
    schema_version: '1.0.0'
    run_id: string
    state: TerminalState
    exit_code: number | null
    final_text: string
    evidence: {
        deliverables: DeliverableEvidence[]
        refusals: string[]
        parser: ParserEvidence
        notes: string[]
        selection?: ExecutionSelection
    }
    usage: UsageSummary
    session_handle: string | null
    terminal_at: string
}

export interface ModelSelection {
    provider: string
    provider_name?: string
    model: string
    effort: string | null
}

export interface ExecutionSelection {
    expected: ModelSelection | null
    actual: ModelSelection[]
    source: 'native-ledger' | 'unavailable'
    matches_expected: boolean | null
    notes: string[]
}

export interface RunEvent {
    ts: string
    type: string
    [key: string]: unknown
}
