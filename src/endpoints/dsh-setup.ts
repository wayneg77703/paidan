// Deliberately limited native edit: three scalar keys in one ordinary YAML block.
// Keep unrelated bytes/comments; refuse YAML forms we cannot safely understand.
import { PaidanError } from '../engine/errors.js'

export function updateDshSettings(raw: string, choice: { provider: string; model: string; effort?: string | null }): string {
    const reject = () => { throw new PaidanError('SETUP_NATIVE_UNSUPPORTED', 'DSH settings.yaml 不是支持的普通块式配置；未改写。请用 DSH 原生设置功能调整后重新查询。') }
    if (!choice.provider || !choice.model || /[\t]|^---|^\.\.\.|^\s*<<:|[&*!][A-Za-z_]/m.test(raw)) return reject()
    const lines = raw.split(/(?<=\n)/)
    const starts = lines.flatMap((line, i) => /^(?:agent-default-model|"agent-default-model"|'agent-default-model')\s*:/.test(line) ? [i] : [])
    if (starts.length !== 1 || !/^agent-default-model:\s*(?:#.*)?\r?\n$/.test(lines[starts[0]])) return reject()
    const start = starts[0] + 1
    let end = start
    while (end < lines.length && /^(?:\s|#|$)/.test(lines[end])) end++
    if (lines.slice(start, end).some(line => line.trim() && !line.trimStart().startsWith('#')
        && !/^  [A-Za-z0-9_-]+:[ \t]*(?:"[^"\r\n]*"|'[^'\r\n]*'|[A-Za-z0-9_.:/-]+)[ \t]*(?:#.*)?\r?\n?$/.test(line))) return reject()
    const changes: Record<string, string> = { provider: choice.provider, model: choice.model }
    if (choice.effort != null) changes.reasoningEffort = choice.effort
    const eol = raw.includes('\r\n') ? '\r\n' : '\n'
    for (const [key, value] of Object.entries(changes)) {
        const matches = []
        for (let i = start; i < end; i++) if (new RegExp(`^  ${key}:`).test(lines[i])) matches.push(i)
        if (matches.length > 1 || lines.slice(start, end).some(l => new RegExp(`^\\s+${key}:`).test(l) && !new RegExp(`^  ${key}:`).test(l))) return reject()
        const rendered = `  ${key}: ${JSON.stringify(value)}`
        if (matches.length) {
            const i = matches[0], original = lines[i]
            const comment = /\s+(#.*?)(?:\r?\n)?$/.exec(original)?.[1]
            lines[i] = rendered + (comment ? ` ${comment}` : '') + eol
        } else {
            if (end > 0 && !lines[end - 1].endsWith('\n')) lines[end - 1] += eol
            lines.splice(end++, 0, rendered + eol)
        }
    }
    return lines.join('')
}
