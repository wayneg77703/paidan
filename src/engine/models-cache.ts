// Models cache: <dataDir>/models-cache/<endpoint>.json
// Historical discovery snapshot, not a source of current connection access.
// The CLI always discovers afresh; failures keep this snapshot for diagnostics
// but never return it as fallback candidates. Successful empty lists replace it.

import * as fs from 'node:fs/promises'
import * as nodePath from 'node:path'
import { writeJsonAtomic } from './run-store.js'
import type { ModelEntry, ConnectionEntry, NativeDefaults } from '../endpoints/parser-api.js'

export interface CachedModels {
    schema_version: '1.0.0'
    endpoint: string
    fetched_at: string
    /** endpoint binary version at fetch time, when detectable */
    version: string | null
    source: string
    models: ModelEntry[]
    connections?: ConnectionEntry[]
    native_defaults?: NativeDefaults
    selection_context?: string
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
