// zcode print-mode output parser ("zcode-print"). Parser only.
// Verified against ZCode CLI 0.16.5 live output (2026-09-10) and the suite
// adapter (the retired external-agent-suite zcode adapter, archived 2026-09-12):
//  - with --json, stdout is exactly ONE pretty-printed JSON envelope:
//    {sessionId ("sess_..."), traceId, turnId, response, usage, projection}
//    (required-field list per extractFacts, zcode.mjs:432); usage is camelCase.
//  - projection.status must be "idle" with turnCount a positive safe integer
//    (the suite's authoritative terminal signal; MAX_TURNS = 12).
// Empty stdout (startup/auth failure) is NOT degraded — the exit code governs.
// Unknown output degrades (degraded=true), it never crashes.

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import type { UsageSummary } from '../engine/types.js'
import type { DiscoverModelsResult, EndpointParseResult, EndpointStreamParser, NativeDefaults, ModelEntry, ConnectionEntry } from './parser-api.js'
import { providerConfigPath, readProviderConfig, zcodeHome } from './zcode-config.js'
import { discoverZcodeApiCandidates } from './zcode-models.js'
import { prepareZcodeRuntime } from './zcode-runtime.js'
export { readExecutionSelection } from './zcode-ledger.js'

const REQUIRED_ENVELOPE_FIELDS = ['sessionId', 'traceId', 'turnId', 'usage', 'projection', 'response'] as const
const MAX_TURNS = 12

export interface ZcodeParseResult extends EndpointParseResult {
/** envelope usage mapped to provider-source tokens; null when absent/invalid */
    /** no in-band refusal shape observed for zcode 0.16.5; always empty */
}

export interface ZcodePrintParser extends EndpointStreamParser {

    finish(tailStdout: string, tailStderr: string): ZcodeParseResult
}

function nonnegativeInteger(value: unknown): number | null {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}
export function usageFromEnvelope(value: unknown): UsageSummary | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const o = value as Record<string, unknown>
    const input = nonnegativeInteger(o.inputTokens)
    const output = nonnegativeInteger(o.outputTokens)
    if (input === null || output === null) return null
    return {
        input_tokens: input,
        output_tokens: output,
        cached_input_tokens: nonnegativeInteger(o.cacheReadTokens),
        cost: null,
        source: 'provider',
    }
}

export function createZcodePrintParser(): ZcodePrintParser {
    const stdoutLines: string[] = []
    let degraded = false
    const warnings: string[] = []

    function parseEnvelope(text: string): {
        finalText: string
        sessionId: string | null
        usage: UsageSummary | null
        traceId?: string | null
        turnId?: string | null
    } {
        let obj: unknown
        try {
            obj = JSON.parse(text)
        } catch {
            degraded = true
            warnings.push('stdout was not exactly one JSON envelope; parser degraded')
            return { finalText: '', sessionId: null, usage: null }
        }
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
            degraded = true
            warnings.push('stdout envelope was not a JSON object; parser degraded')
            return { finalText: '', sessionId: null, usage: null }
        }
        const o = obj as Record<string, unknown>
        const missing = REQUIRED_ENVELOPE_FIELDS.filter((f) => !Object.hasOwn(o, f))
        if (missing.length > 0) {
            degraded = true
            warnings.push(`required envelope fields missing: ${missing.join(', ')}`)
        }
        const projection = o.projection
        if (!projection || typeof projection !== 'object' || Array.isArray(projection)) {
            degraded = true
            warnings.push('projection was missing or invalid')
        } else {
            const p = projection as Record<string, unknown>
            const turnCount = nonnegativeInteger(p.turnCount)
            if (p.status !== 'idle') {
                degraded = true
                warnings.push(`projection.status is ${JSON.stringify(p.status)}, expected "idle"; run may have ended abnormally`)
            }
            if (turnCount === null || turnCount < 1) {
                degraded = true
                warnings.push('projection.turnCount must be a positive safe integer')
            } else if (turnCount > MAX_TURNS) {
                degraded = true
                warnings.push(`projection.turnCount ${turnCount} exceeded ${MAX_TURNS}`)
            }
        }
        const finalText = typeof o.response === 'string' ? o.response.trim() : ''
        if (typeof o.response !== 'string' || finalText.length === 0) {
            warnings.push('envelope response was empty or not a string')
        }
        const sessionId = typeof o.sessionId === 'string' && o.sessionId.length > 0 ? o.sessionId : null
        return { finalText, sessionId, usage: usageFromEnvelope(o.usage),
            traceId: typeof o.traceId === 'string' ? o.traceId : null,
            turnId: typeof o.turnId === 'string' ? o.turnId : null }
    }

    return {
        acceptStdoutLine(line: string): void {
            stdoutLines.push(line)
        },
        acceptStderrLine(_line: string): void {
            // no stderr-carried signals observed for zcode 0.16.5 headless
        },
        finish(tailStdout: string, _tailStderr: string): ZcodeParseResult {
            const full = (stdoutLines.join('\n') + (tailStdout ? `\n${tailStdout}` : '')).replace(/^\uFEFF/, '').trim()
            if (full.length === 0) {
                // startup/auth failures print nothing to stdout; the exit code decides
                return { finalText: '', sessionId: null, usage: null, refusals: [], degraded, warnings }
            }
            const parsed = parseEnvelope(full)
            return {
                finalText: parsed.finalText,
                sessionId: parsed.sessionId,
                traceId: parsed.traceId,
                turnId: parsed.turnId,
                usage: parsed.usage,
                refusals: [],
                degraded,
                warnings,
            }
        },
    }
}

/**
 * No endpoint refusal signal has been observed for zcode 0.16.5 headless yolo
 * (startup errors like "Model config is missing" are exit-code failures, not
 * refusals). Honest no-op until a real refusal shape is evidenced.
 */
export function detectZcodeRefusals(_stderrText: string, _exitCode: number | null): string[] {
    return []
}

/**
 * v0 model discovery: read-only heuristic scan of the desktop's native
 * .zcode/v2/config.json provider registry. Extracts provider/model aliases
 * only; credentials in the same file are never read into output.
 */
export function discoverZcodeModels(configJson: string | null, source: 'native-config' | 'desktop-config' = 'desktop-config'): DiscoverModelsResult {
    const notes: string[] = []
    if (configJson === null) {
        notes.push('ZCode provider registry not found; inspect the selected native layout')
        return { models: [], notes }
    }
    let parsed: unknown
    try {
        parsed = JSON.parse(configJson)
    } catch {
        notes.push('ZCode provider registry is not valid JSON')
        return { models: [], notes }
    }
    const providers = (parsed as Record<string, unknown>)?.provider
    const models: ModelEntry[] = []
    const connections: ConnectionEntry[] = []
    if (providers && typeof providers === 'object' && !Array.isArray(providers)) {
        for (const [providerId, entry] of Object.entries(providers as Record<string, unknown>)) {
            const e = entry as Record<string, unknown>
            if (e?.enabled === false) continue
            if (!e || typeof e !== 'object' || Array.isArray(e)) continue
            connections.push({ id: providerId, label: typeof e.name === 'string' ? e.name : providerId, source, auth_type: 'unknown' })
            const modelsObj = e?.models
            if (!modelsObj || typeof modelsObj !== 'object' || Array.isArray(modelsObj)) continue
            for (const [modelId, modelCfg] of Object.entries(modelsObj as Record<string, unknown>)) {
                if ((modelCfg as Record<string, unknown>)?.enabled === false) continue
                const reasoning = (modelCfg as { reasoning?: { variants?: unknown; defaultVariant?: unknown } } | null)?.reasoning
                models.push({
                    alias: `${providerId}/${modelId}`, connection: providerId, source,
                    effort_options: Array.isArray(reasoning?.variants) && reasoning.variants.every((v) => typeof v === 'string') ? reasoning.variants : null,
                    default_effort: typeof reasoning?.defaultVariant === 'string' ? reasoning.defaultVariant : null,
                })
            }
        }
    }
    if (models.length === 0) {
        notes.push('no enabled provider/model entries found in this provider registry')
    } else {
        notes.push('provider/model identifiers from this registry; native selection and runtime/account layers may differ; no cross-connection fallback')
    }
    notes.push(`${source}: stored provider entries do not prove the current account, billing route or CLI access. apiKey presence does not distinguish subscriptions from API billing.`)
    return { models, connections, notes }
}

/** New desktop rules are patches over bundled/account resources, not a complete CLI catalog. */
export function discoverZcodeRules(raw: string): DiscoverModelsResult {
    let o: any
    try { o = JSON.parse(raw) } catch { throw new Error('ZCode provider_config.json is invalid JSON; raw output withheld') }
    const providers = o?.config?.providerConfigRules?.providerRules
    const modelRules = o?.config?.modelConfigRules?.providerModelRules
    if (!Array.isArray(providers) || !Array.isArray(modelRules)) throw new Error('ZCode provider rules schema is unknown; inspect native setup without applying legacy merge instructions')
    const connections: ConnectionEntry[] = []
    for (const p of providers) {
        if (!p || typeof p.providerId !== 'string' || p.enabled === false) continue
        const access = p.config?.access?.type
        connections.push({
            id: p.providerId, label: typeof p.providerName === 'string' ? p.providerName : p.providerId,
            source: 'desktop-provider-rules', auth_type: access === 'oauth' ? 'oauth' : access === 'api-key' || access === 'zhipu-coding-plan-api-key' ? 'api-key' : 'unknown',
            ...(typeof access === 'string' ? { access_type: access } : {}),
        })
    }
    const enabled = new Set(connections.map((p) => p.id))
    const models: ModelEntry[] = []
    for (const m of modelRules) {
        if (!m || !enabled.has(m.providerId) || typeof m.modelId !== 'string' || m.enabled === false || m.config?.enabled === false) continue
        models.push({ alias: `${m.providerId}/${m.modelId}`, connection: m.providerId, source: 'desktop-config' })
    }
    return { models, connections, notes: ['Desktop provider rules only: bundled templates, account state and manual rules can add/override entries. This is an incomplete desktop configuration inventory, NOT the effective CLI catalog. Do not copy legacy v2/config.json over this layout.'] }
}

export function discoverZcodeConfiguration(cli: string | null, legacy: string | null, rules: string | null): DiscoverModelsResult {
    const native = rules !== null
        ? { models: [], connections: [], notes: ['Provider rules are present; legacy CLI entries are not advertised as current candidates. The selected bundle may ignore cli/config.json even with an unchanged CLI version.'] }
        : cli === null ? { models: [], connections: [], notes: ['Native CLI config missing; desktop login does not prove CLI readiness.'] } : discoverZcodeModels(cli, 'native-config')
    const desktop = rules === null ? discoverZcodeModels(legacy) : discoverZcodeRules(rules)
    return {
        models: [...native.models, ...desktop.models],
        connections: [...(native.connections ?? []), ...(desktop.connections ?? [])],
        notes: [...native.notes, ...desktop.notes, 'Choose the connection first in the selected ZCode version. Stored candidates are diagnostic only; use the live API catalog before pinning provider/model and effort.'],
    }
}

// ---- Convention exports (parser-api.ts): adapters.ts loads these by name ----

export function createParser(): ZcodePrintParser {
    return createZcodePrintParser()
}

export const detectRefusals = detectZcodeRefusals

export async function discoverModels(opts?: { configBin?: string | null; providerConfig?: string | null }): Promise<DiscoverModelsResult> {
    const { EndpointRegistry } = await import('./registry.js')
    const { planEndpointSpawn } = await import('./spawn.js')
    const manifest = (await EndpointRegistry.load()).get('zcode')
    const { plan } = await planEndpointSpawn(manifest, { configBin: opts?.configBin ?? null })
    if (!plan) throw new Error('ZCode CLI 不可用，无法查询当前 API 模型。')
    const runtime = await prepareZcodeRuntime(plan, process.env, process.cwd(), opts?.providerConfig)
    const personalFile = providerConfigPath(runtime.env)
    const exists = await fs.stat(personalFile).then(() => true, () => false)
    if (!exists && opts?.providerConfig === undefined && !Object.hasOwn(process.env, 'ZCODE_PERSONAL_PROVIDER_CONFIG_FILE')) return discoverStoredConfiguration()
    const personal = await readProviderConfig(personalFile)
    let builtin: any = null
    if (runtime.check.file) {
        try { builtin = JSON.parse(await fs.readFile(runtime.check.file, 'utf8')) }
        catch { throw new Error('ZCode 内置模板无法读取；不能可靠列出模型候选。') }
    }
    return discoverZcodeApiCandidates(personal, builtin)
}

/** Stored inventory for diagnostics only; live selection uses discoverModels. */
export async function discoverStoredConfiguration(): Promise<DiscoverModelsResult> {
    const nativeRoot = process.env.USERPROFILE ?? os.homedir()
    const read = (file: string) => fs.readFile(nodePath.join(nativeRoot, '.zcode', file), 'utf8').catch(() => null)
    const explicit = Object.hasOwn(process.env, 'ZCODE_PERSONAL_PROVIDER_CONFIG_FILE')
    const readRules = async () => {
        if (!explicit) return read('v2/provider_config.json')
        try { return await fs.readFile(process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE!, 'utf8') }
        catch { throw new Error('Explicit ZCODE_PERSONAL_PROVIDER_CONFIG_FILE is unreadable; refusing to substitute the default or legacy provider file') }
    }
    const [cli, legacy, rules] = await Promise.all([read('cli/config.json'), read('v2/config.json'), readRules()])
    const result = discoverZcodeConfiguration(cli, legacy, rules)
    if (explicit) result.notes.push('Provider rules came from explicit ZCODE_PERSONAL_PROVIDER_CONFIG_FILE; they remain partial runtime inputs, not a merged CLI catalog.')
    return result
}

/** Read the native default, not credentials. Only an actual request can verify headless authentication. */
export async function readNativeDefaults(opts?: { providerConfig?: string | null }): Promise<NativeDefaults> {
    const authNote = 'Headless authentication is unverified; a model/provider configuration alone is not proof. Desktop connection selection may differ. Preserve setup when verification is skipped; actual invocation can be checked with the first real task.'
    const nativeRoot = nodePath.dirname(zcodeHome())
    const explicit = typeof opts?.providerConfig === 'string' || Object.hasOwn(process.env, 'ZCODE_PERSONAL_PROVIDER_CONFIG_FILE')
    const rulesPath = providerConfigPath(process.env, opts?.providerConfig)
    let rules: string | null = null
    try { rules = await fs.readFile(rulesPath, 'utf8') }
    catch (error) {
        if (explicit || (error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw new Error('ZCode personal provider rules are unreadable; refusing to substitute legacy defaults')
        }
    }
    if (rules !== null) {
        const notes = [authNote, 'Configured provider-rules selection only, NOT verified effective routing. Native startup may fall back when this selection is unavailable; account state may remap account providers. Legacy cli/config.json and ZCODE_MODEL are not used as evidence for this layout.']
        let o: any
        try { o = JSON.parse(rules) }
        catch { return { model: null, connection: null, effort: null, credential_ready: null, notes: [...notes, 'Personal provider rules are invalid JSON; no legacy fallback.'] } }
        const selection = o?.config?.defaultModelSelection
        if (typeof selection?.providerId !== 'string' || !selection.providerId || typeof selection?.modelId !== 'string' || !selection.modelId) {
            return { model: null, connection: null, effort: null, credential_ready: null, notes: [...notes, 'No readable defaultModelSelection; effective selection is unknown. Do not infer it from the first configured provider.'] }
        }
        return {
            model: `${selection.providerId}/${selection.modelId}`, connection: selection.providerId,
            effort: typeof selection.options?.reasoningLevel === 'string' ? selection.options.reasoningLevel : null,
            credential_ready: null, notes,
        }
    }
    let raw: string | null = null
    try {
        raw = await fs.readFile(nodePath.join(nativeRoot, '.zcode', 'cli', 'config.json'), 'utf8')
    } catch {
        raw = null
    }
    if (raw === null) {
        return {
            model: null,
            effort: null,
            credential_ready: null,
            notes: ['native zcode cli/config.json not found', authNote],
        }
    }
    try {
        const o = JSON.parse(raw) as Record<string, unknown>
        const model = typeof o.model === 'string' && o.model.length > 0 ? o.model : null
        const connection = model?.includes('/') ? model.slice(0, model.indexOf('/')) : null
        return { model, connection, effort: null, credential_ready: null, notes: [authNote, 'Legacy CLI file snapshot only; the selected bundle may ignore it. ZCODE_MODEL support varies by bundle and is not inferred from its presence. Provider resources/account layers must be checked separately.'] }
    } catch {
        return {
            model: null,
            effort: null,
            credential_ready: null,
            notes: ['native zcode cli/config.json is not valid JSON', authNote],
        }
    }
}
