import * as fs from 'node:fs'
import * as path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { zcodeHome, providerConfigPath, readProviderConfig } from './zcode-config.js'
import type { EndpointParseResult } from './parser-api.js'
import type { ExecutionSelection, ModelSelection } from '../engine/types.js'

export async function readExecutionSelection(parsed: EndpointParseResult, opts: { env: NodeJS.ProcessEnv; expected: ModelSelection | null }): Promise<ExecutionSelection> {
    const result: ExecutionSelection = { expected: opts.expected, actual: [], source: 'unavailable', matches_expected: null, notes: [] }
    if (!parsed.sessionId || !parsed.traceId || !parsed.turnId || parsed.degraded) {
        result.notes.push('缺少可靠的本轮会话/trace/turn 标识，实际 provider、模型和强度未知。')
        return result
    }
    const dbPath = path.join(zcodeHome(opts.env), 'cli', 'db', 'db.sqlite')
    if (!fs.existsSync(dbPath)) { result.notes.push('ZCode 原生请求账本不存在，实际选择未知。'); return result }
    let db: DatabaseSync | undefined
    try {
        db = new DatabaseSync(dbPath, { readOnly: true })
        const rows = db.prepare('SELECT provider_id, model_id, variant FROM model_usage WHERE session_id = ? AND trace_id = ? AND turn_id = ? ORDER BY started_at, id LIMIT 501')
            .all(parsed.sessionId, parsed.traceId, parsed.turnId)
        if (!rows.length || rows.length > 500) throw new Error('no bounded current-turn rows')
        const names = new Map<string, string>()
        // Labels are configuration metadata, not proof of an account identity or billing source.
        for (const file of new Set([providerConfigPath(opts.env), providerConfigPath(opts.env, null)])) {
            try {
                const config = await readProviderConfig(file)
                for (const p of config.config.providerConfigRules.providerRules) if (typeof p.providerId === 'string' && typeof p.providerName === 'string' && !names.has(p.providerId)) names.set(p.providerId, p.providerName)
            } catch { /* IDs still suffice when the label source is unavailable. */ }
        }
        for (const row of rows) {
            if (typeof row.provider_id !== 'string' || typeof row.model_id !== 'string' || row.variant !== null && typeof row.variant !== 'string') throw new Error('unknown row shape')
            const actual: ModelSelection = { provider: row.provider_id, model: row.model_id, effort: row.variant,
                ...(names.has(row.provider_id) ? { provider_name: names.get(row.provider_id) } : {}) }
            if (!result.actual.some(v => v.provider === actual.provider && v.model === actual.model && v.effort === actual.effort)) result.actual.push(actual)
        }
        result.source = 'native-ledger'
        if (opts.expected) {
            const wanted = opts.expected
            result.matches_expected = result.actual.every(v => v.provider === wanted.provider && v.model === wanted.model && (wanted.effort === null || v.effort === wanted.effort))
            if (!result.matches_expected) result.notes.push('ZCode 实际选择与期望配置不一致，不能声称固定成功；未自动重试或切换连接。请告知用户。')
        }
    } catch {
        result.actual = []; result.source = 'unavailable'; result.matches_expected = null
        result.notes.push('无法从原生账本可靠核对本轮选择；不使用历史会话或配置默认值冒充实际调用。')
    } finally { db?.close() }
    return result
}
