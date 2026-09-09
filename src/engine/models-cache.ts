// Models cache: <dataDir>/models-cache/<endpoint>.json
// Discipline (from the suite): a failed refresh keeps the last successful
// cache; a successful EMPTY model list is written as-is and never borrows the
// previous cache.

import * as fs from 'node:fs/promises'
import * as nodePath from 'node:path'
import { writeJsonAtomic } from './run-store.js'

export interface CachedModels {
    schema_version: '1.0.0'
    endpoint: string
    fetched_at: string
    /** endpoint binary version at fetch time, when detectable */
    version: string | null
    source: string
    models: Array<{ alias: string; connection: string | null }>
    notes: string[]
}

const ENDPOINT_NAME_RE = /^[a-z0-9][a-z0-9-]*$/

export class ModelsCache {
    constructor(readonly dataDir: string) {}

    private path(endpoint: string): string {
        if (!ENDPOINT_NAME_RE.test(endpoint)) throw new Error(`unsafe endpoint name for cache: ${endpoint}`)
        return nodePath.join(this.dataDir, 'models-cache', `${endpoint}.json`)
    }

    async read(endpoint: string): Promise<CachedModels | null> {
        let raw: string
        try {
            raw = await fs.readFile(this.path(endpoint), 'utf8')
        } catch {
            return null
        }
        try {
            const parsed = JSON.parse(raw) as CachedModels
            if (parsed.schema_version !== '1.0.0' || parsed.endpoint !== endpoint || !Array.isArray(parsed.models)) {
                return null
            }
            return parsed
        } catch {
            return null // corrupt cache is treated as absent
        }
    }

    async write(entry: CachedModels): Promise<void> {
        await writeJsonAtomic(this.path(entry.endpoint), entry)
    }

    /** Age in hours (fractional), null when no cache. */
    ageHours(entry: CachedModels, now: Date = new Date()): number {
        const ms = now.getTime() - Date.parse(entry.fetched_at)
        return Number.isFinite(ms) ? Math.max(0, ms / 3_600_000) : Number.NaN
    }
}
