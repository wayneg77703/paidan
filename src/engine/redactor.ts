// Redaction before anything lands in events.jsonl / result.json.
// Covers: Bearer tokens, sk- style keys, GitHub/GitLab/Slack/AWS/Google
// tokens, JWTs, URL userinfo credentials, KEY/TOKEN/SECRET/PASSWORD
// assignments, the actual values of env vars whose names end in those words,
// and the user's home directory path (machine paths stay out of shared output).

import * as os from 'node:os'

export interface Redactor {
    redactText(text: string): string
    redactJson(value: unknown): unknown
}

const SECRET_ENV_NAME_RE = /(?:KEY|TOKEN|SECRET|PASSWORD)$/i

const PATTERNS: Array<[RegExp, (m: RegExpExecArray) => string]> = [
    [/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, () => 'Bearer [REDACTED]'],
    [/sk-[A-Za-z0-9_-]{8,}/g, () => 'sk-[REDACTED]'],
    [/\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{8,}/g, () => '[REDACTED]'],
    [/\bAKIA[0-9A-Z]{16}\b/g, () => '[REDACTED]'],
    [/\bAIza[0-9A-Za-z_-]{35}\b/g, () => '[REDACTED]'],
    [/\bxox[baprs]-[A-Za-z0-9-]{8,}/g, () => '[REDACTED]'],
    [/\bglpat-[A-Za-z0-9_-]{20,}/g, () => '[REDACTED]'],
    // JWT: three base64url segments; the header always starts with eyJ
    [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, () => '[REDACTED]'],
    // URL userinfo: keep scheme and host, erase the user:pass segment
    [/:\/\/[^\s/:@]+:[^\s/@]+@/g, () => '://[REDACTED]@'],
    // assignment form: keep the variable name, erase the value (>=4 chars, to
    // avoid mangling ordinary prose)
    [/([A-Za-z_][A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Za-z0-9_]*)\s*[:=]\s*["']?[^"'\s,;]{4,}/gi, (m) => `${m[1]}=[REDACTED]`],
]

export function createRedactor(
    env: NodeJS.ProcessEnv = process.env,
    homeDir: string = os.homedir(),
): Redactor {
    // longest first so a short secret cannot shred a longer one containing it
    const envSecrets = Object.entries(env)
        .filter(([name, v]) => SECRET_ENV_NAME_RE.test(name) && typeof v === 'string' && v.length >= 4)
        .map(([, v]) => v as string)
        .sort((a, b) => b.length - a.length)

    const homeVariants = [homeDir, homeDir.replace(/\\/g, '/')]
        .filter((v) => v.length > 3)
        .sort((a, b) => b.length - a.length)

    function redactText(text: string): string {
        let out = text
        for (const [re, replacer] of PATTERNS) {
            out = out.replace(re, (...args) => replacer(args as unknown as RegExpExecArray))
        }
        for (const secret of envSecrets) {
            if (out.includes(secret)) {
                out = out.split(secret).join('[REDACTED]')
            }
        }
        for (const home of homeVariants) {
            if (out.includes(home)) {
                out = out.split(home).join('~')
            }
        }
        return out
    }

    function redactJson(value: unknown): unknown {
        if (typeof value === 'string') return redactText(value)
        if (Array.isArray(value)) return value.map(redactJson)
        if (value && typeof value === 'object') {
            const out: Record<string, unknown> = {}
            for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
                out[k] = redactJson(v)
            }
            return out
        }
        return value
    }

    return { redactText, redactJson }
}
