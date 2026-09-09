// usage.db — node:sqlite. Schema per contracts.md §8.
// Three-state source (provider | endpoint-ledger | unavailable); token columns
// stay NULL when unavailable — never fabricate zeros.

import { DatabaseSync } from 'node:sqlite'
import * as fs from 'node:fs'
import * as nodePath from 'node:path'
import type { UsageSource } from './types.js'

export interface UsageRow {
    run_id: string
    endpoint: string
    connection: string | null
    model: string | null
    input_tokens: number | null
    cached_input_tokens: number | null
    output_tokens: number | null
    cost: number | null
    source: UsageSource
    recorded_at: string
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS usage (
    run_id TEXT PRIMARY KEY,
    endpoint TEXT,
    connection TEXT,
    model TEXT,
    input_tokens INTEGER,
    cached_input_tokens INTEGER,
    output_tokens INTEGER,
    cost REAL,
    source TEXT,
    recorded_at TEXT
)
`

const VALID_SOURCES: ReadonlySet<string> = new Set(['provider', 'endpoint-ledger', 'unavailable'])

export class UsageDb {
    private readonly db: DatabaseSync

    constructor(readonly dbPath: string) {
        fs.mkdirSync(nodePath.dirname(dbPath), { recursive: true })
        this.db = new DatabaseSync(dbPath)
        this.db.exec(SCHEMA)
    }

    /** Idempotent per run_id (INSERT OR REPLACE keeps the latest terminal record). */
    record(row: UsageRow): void {
        if (!VALID_SOURCES.has(row.source)) {
            throw new Error(`invalid usage source: ${row.source}`)
        }
        if (row.source === 'unavailable'
            && (row.input_tokens !== null || row.output_tokens !== null || row.cached_input_tokens !== null)) {
            throw new Error('unavailable usage must carry NULL token columns, not fabricated numbers')
        }
        this.db.prepare(`
            INSERT OR REPLACE INTO usage
            (run_id, endpoint, connection, model, input_tokens, cached_input_tokens, output_tokens, cost, source, recorded_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            row.run_id,
            row.endpoint,
            row.connection,
            row.model,
            row.input_tokens,
            row.cached_input_tokens,
            row.output_tokens,
            row.cost,
            row.source,
            row.recorded_at,
        )
    }

    get(runId: string): UsageRow | null {
        const row = this.db.prepare('SELECT * FROM usage WHERE run_id = ?').get(runId)
        return (row as UsageRow | undefined) ?? null
    }

    list(query: { endpoint?: string; limit?: number } = {}): UsageRow[] {
        const limit = query.limit && query.limit > 0 ? query.limit : 100
        if (query.endpoint) {
            return this.db
                .prepare('SELECT * FROM usage WHERE endpoint = ? ORDER BY recorded_at DESC LIMIT ?')
                .all(query.endpoint, limit) as unknown as UsageRow[]
        }
        return this.db
            .prepare('SELECT * FROM usage ORDER BY recorded_at DESC LIMIT ?')
            .all(limit) as unknown as UsageRow[]
    }

    close(): void {
        this.db.close()
    }
}
