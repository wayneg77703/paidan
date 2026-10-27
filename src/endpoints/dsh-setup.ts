// Append a literal whole-config override to the selected headless profile only.
// Never rewrite legacy settings.yaml, home/global patches, or credential fields.
import { PaidanError } from '../engine/errors.js'
import { inspectDshPatch, type DshModelFields } from './dsh-patch.js'
export function updateDshSettings(raw: string, choice: { provider: string; model: string; effort?: string | null }, homePatch: string | null = null, current?: DshModelFields): string {
    const reject = (): never => { throw new PaidanError('SETUP_NATIVE_UNSUPPORTED', 'DSH cordis.patch.yml 不是支持的普通块式 patch，或更高优先级 home patch 影响默认模型；未改写。请用 DSH 原生设置调整。') }
    const profile = inspectDshPatch(raw), home = inspectDshPatch(homePatch ?? '')
    if (!profile.safe || !home.safe || home.mentioned || ![choice.provider, choice.model, choice.effort ?? 'unset'].every(v => /^[A-Za-z0-9_.:/-]+$/.test(v))) return reject()
    if (profile.disabled) return reject()
    const effective = current ?? (profile.config?.provider && profile.config?.model ? profile.config : undefined)
    if (choice.effort == null && effective === undefined)
        throw new PaidanError('SETUP_NATIVE_UNSUPPORTED', 'DSH 当前强度无法确定，不能证明省略 effort 会保持原值；请提供完整原生层或明确选择强度。')
    const effort = choice.effort ?? effective?.reasoningEffort
    if (effective?.provider === choice.provider && effective.model === choice.model && effective.reasoningEffort === effort) return raw
    // Existing selected fields may be replaced; no unrelated config is copied.
    const eol = raw.includes('\r\n') ? '\r\n' : '\n'
    const existing = raw.replace(/^\[\]\s*$/m, '')
    const prefix = existing + (existing && !existing.endsWith('\n') ? eol : '')
    return prefix + eol + '- id: agent-default-model' + eol + '  config:' + eol
        + '    provider: ' + JSON.stringify(choice.provider) + eol
        + '    model: ' + JSON.stringify(choice.model) + eol
        + (effort != null ? '    reasoningEffort: ' + JSON.stringify(effort) + eol : '')
}

export type DshSourceProfile = 'web' | 'acp'

function splitDshBlocks(raw: string): { header: string[]; blocks: string[][] } {
    const groups: string[][] = []
    let current: string[] = []
    for (const line of raw.split(/\r?\n/)) {
        if (/^- (?:id:|insert:)/.test(line)) {
            if (current.length) groups.push(current)
            current = [line]
        } else current.push(line)
    }
    if (current.length) groups.push(current)
    const [first = [], ...rest] = groups
    const startsWithRow = first.length > 0 && /^- (?:id:|insert:)/.test(first[0])
    return { header: startsWithRow ? [] : first, blocks: startsWithRow ? groups : rest }
}

function hasSelectedDshModel(source: string[], choice: { provider: string; model: string }): boolean {
    const providers = source.findIndex(line => /^\s+providers:\s*(?:#.*)?$/.test(line))
    if (providers < 0) return false
    const rootIndent = source[providers].length - source[providers].trimStart().length
    const providerIndent = rootIndent + 2
    let start = -1
    for (let i = providers + 1; i < source.length; i++) {
        const row = source[i], depth = row.length - row.trimStart().length
        if (!row.trim() || row.trimStart().startsWith('#')) continue
        if (depth <= rootIndent) break
        if (depth === providerIndent && row.trim() === choice.provider + ':') { start = i; break }
    }
    if (start < 0) return false
    let modelsIndent: number | null = null
    for (let i = start + 1; i < source.length; i++) {
        const row = source[i], depth = row.length - row.trimStart().length
        if (!row.trim() || row.trimStart().startsWith('#')) continue
        if (depth <= providerIndent) break
        if (depth === providerIndent + 2 && row.trim() === 'models:') { modelsIndent = depth; continue }
        if (modelsIndent === null) continue
        if (depth <= modelsIndent) { modelsIndent = null; continue }
        if (depth !== modelsIndent + 2) continue
        const id = /^- id:\s*([A-Za-z0-9_.:/@-]+|"[^"]+"|'[^']+')\s*(?:#.*)?$/.exec(row.trim())
        const value = id?.[1]
        if (value && (value === choice.model || value === `"${choice.model}"` || value === `'${choice.model}'`)) return true
    }
    return false
}

export function syncDshProviderSettings(raw: string, sourceRaw: string, sourceProfile: DshSourceProfile, choice: { provider: string; model: string }): string {
    const reject = (): never => { throw new PaidanError('SETUP_NATIVE_UNSUPPORTED', `DSH ${sourceProfile} 的 llm-pi-ai 配置缺少目标模型，或包含直接凭据/不支持的语法；未复制。`) }
    if (![choice.provider, choice.model].every(value => /^[A-Za-z0-9_.:/-]+$/.test(value))) return reject()
    const source = splitDshBlocks(sourceRaw).blocks.find(block => /^- id:\s*llm-pi-ai\s*$/.test(block[0] ?? ''))
    if (!source || !inspectDshPatch(source.join('\n')).safe) return reject()
    const meaningful = source.filter(line => !line.trimStart().startsWith('#'))
    const directCredential = meaningful.some(line => /^\s*["']?(?:apiKey|token|secret|password)["']?\s*:/.test(line)
        || /["']?Authorization["']?\s*:/.test(line) && !line.includes('${'))
    const dynamic = meaningful.some(line => /!![A-Za-z]|<<:|---|^\s*[*&][A-Za-z_]/.test(line))
    if (directCredential || dynamic || !hasSelectedDshModel(source, choice)) return reject()
    const eol = raw.includes('\r\n') ? '\r\n' : '\n'
    const target = splitDshBlocks(raw.replace(/^\[\]\s*$/m, ''))
    const chunks = [target.header, source, ...target.blocks.filter(block => !/^- id:\s*llm-pi-ai\s*$/.test(block[0] ?? ''))]
    return chunks.map(block => block.join(eol).replace(/\s+$/, '')).filter(Boolean).join(eol) + eol
}
