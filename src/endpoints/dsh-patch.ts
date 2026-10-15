// A metadata projection, not a YAML evaluator. Only literal row IDs and the
// three agent-default-model scalar fields are recognized; no expressions run.
export interface DshModelFields { provider?: string; model?: string; reasoningEffort?: string }
export interface DshPatchModel { safe: boolean; mentioned: boolean; config?: DshModelFields; disabled?: boolean }
const scalar = (value: string): string | null => /^(?:"([A-Za-z0-9_.:/@-]+)"|'([A-Za-z0-9_.:/@-]+)'|([A-Za-z0-9_.:/@-]+))\s*(?:#.*)?$/.exec(value.trim())?.slice(1).find(v => v !== undefined) ?? null

export function inspectDshPatch(raw: string): DshPatchModel {
    const result: DshPatchModel = { safe: true, mentioned: false }
    const lines = raw.split(/\r?\n/)
    // Aliases, merge keys, documents and tab indentation can change row identity.
    const meaningful = lines.filter(l => l.trim() && !l.trimStart().startsWith('#'))
    if (meaningful.some(l => l.trim() === '[]') && meaningful.length !== 1) return { safe: false, mentioned: false }
    if (lines.some(l => /^\s*[^#].*(?:[&*][A-Za-z_]|<<:)/.test(l) || /^ *\t|^---|^\.\.\./.test(l))) return { safe: false, mentioned: false }
    let literalIndent: number | null = null
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i], indent = line.length - line.trimStart().length
        if (!line.trim() || line.trimStart().startsWith('#')) continue
        if (literalIndent !== null) { if (indent > literalIndent) continue; literalIndent = null }
        if (/:[ \t]*[|>][-+]?\s*(?:#.*)?$/.test(line)) { literalIndent = indent; continue }
        if (indent === 0 && line !== '[]' && !/^- (?:id:|insert:\s*(?:#.*)?$)/.test(line)) return { safe: false, mentioned: false }
        const id = /^( *)(?:- )id:\s*(.*)$/.exec(line)
        if (!id) {
            if (line.includes('agent-default-model')) return { safe: false, mentioned: true }
            continue
        }
        const name = scalar(id[2])
        if (!name || ![0, 4].includes(indent)) return { safe: false, mentioned: false }
        if (name !== 'agent-default-model') continue
        result.mentioned = true
        let configSeen = false
        for (++i; i < lines.length; i++) {
            const row = lines[i], depth = row.length - row.trimStart().length
            if (!row.trim() || row.trimStart().startsWith('#')) continue
            if (depth <= indent) { i--; break }
            const property = /^( *)([A-Za-z][A-Za-z0-9]*):\s*(.*)$/.exec(row)
            if (!property) return { safe: false, mentioned: true }
            if (depth === indent + 2 && property[2] === 'config' && /^(?:#.*)?$/.test(property[3])) {
                if (configSeen) return { safe: false, mentioned: true }
                configSeen = true; result.config = {}; continue
            }
            if (depth === indent + 2 && property[2] === 'disabled' && /^(true|false)\s*(?:#.*)?$/.test(property[3])) {
                result.disabled = property[3].startsWith('true'); continue
            }
            if (depth === indent + 2 && property[2] === 'name' && scalar(property[3]) === '@deepseek-ai/dsh-agent-default-model') continue
            if (configSeen && depth === indent + 4 && ['provider', 'model', 'reasoningEffort'].includes(property[2])) {
                const key = property[2] as keyof DshModelFields, value = scalar(property[3])
                if (value === null || Object.hasOwn(result.config!, key)) return { safe: false, mentioned: true }
                result.config![key] = value; continue
            }
            return { safe: false, mentioned: true }
        }
    }
    return result
}
