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
