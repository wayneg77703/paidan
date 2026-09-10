// File run store: <dataDir>/runs/<run_id>/{request.json,state.json,events.jsonl,result.json}
// Atomic JSON writes (tmp + rename, Windows rename retry), idempotent submit by
// request fingerprint, TTL cleanup piggy-backed on list().

import { createHash, randomBytes } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as nodePath from 'node:path'
import type {
    DeliverableSpec,
    ModeSelection,
    RunEvent,
    RunRequest,
    RunResult,
    RunState,
    RunStateRecord,
} from './types.js'
import { canonicalMode } from './types.js'
import { isTerminal } from './state-machine.js'
import { DEFAULT_TTL_DAYS } from './config.js'

const RUN_ID_RE = /^run_\d{8}_[0-9a-f]{8}$/

// create() critical-section mutex (<dataDir>/locks/<fingerprint hex>): a lock
// older than this means its creator crashed mid-create
const CREATE_LOCK_STALE_MS = 60_000
// while a live competitor holds the lock, poll for its run for at most this long
const CREATE_LOCK_WAIT_MS = 5_000
const CREATE_LOCK_POLL_MS = 100

export class StoreCorruptError extends Error {
    override name = 'StoreCorruptError'
}

export interface CreateRunInput {
    endpoint: string
    cwd: string
    add_dirs: string[]
    task_file: string | null
    task_text: string
    mode: ModeSelection
    model: string | null
    effort: string | null
    resume_session: string | null
    run_timeout_sec: number
    deliverables: DeliverableSpec[]
    warnings: string[]
}

export interface CreateRunOutcome {
    request: RunRequest
    state: RunStateRecord
    created: boolean
}

interface FingerprintHit {
    request: RunRequest
    state: RunStateRecord
}

export function sha256Hex(text: string | Buffer): string {
    return createHash('sha256').update(text).digest('hex')
}

/** contracts.md §1: sha256(endpoint + cwd + task text + mode); capability sets hash by canonical form */
export function requestFingerprint(endpoint: string, cwd: string, taskText: string, mode: ModeSelection): string {
    return `sha256:${sha256Hex(`paidan/1\0${endpoint}\0${nodePath.resolve(cwd)}\0${taskText}\0${canonicalMode(mode)}`)}`
}

export function newRunId(now: Date = new Date()): string {
    const y = now.getFullYear()
    const m = String(now.getMonth() + 1).padStart(2, '0')
    const d = String(now.getDate()).padStart(2, '0')
    return `run_${y}${m}${d}_${randomBytes(4).toString('hex')}`
}

function assertSafeRunId(runId: string): void {
    if (!RUN_ID_RE.test(runId)) throw new Error(`unsafe run_id: ${runId}`)
}

/** Atomic JSON write: same-dir tmp file -> sync -> close -> rename (Windows retries). */
export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
    const dir = nodePath.dirname(filePath)
    await fs.mkdir(dir, { recursive: true })
    const tmp = nodePath.join(dir, `.${nodePath.basename(filePath)}.tmp-${randomBytes(6).toString('hex')}`)
    const json = JSON.stringify(value, null, 2) + '\n'
    let fh: fs.FileHandle | null = null
    try {
        fh = await fs.open(tmp, 'w')
        await fh.writeFile(json, 'utf8')
        await fh.sync()
        await fh.close()
        fh = null
        await renameWithRetry(tmp, filePath)
    } catch (err) {
        if (fh) await fh.close().catch(() => {})
        await fs.rm(tmp, { force: true }).catch(() => {})
        throw err
    }
}

async function renameWithRetry(from: string, to: string): Promise<void> {
    let lastErr: unknown
    for (let i = 0; i < 4; i++) {
        try {
            await fs.rename(from, to)
            return
        } catch (err) {
            const code = (err as NodeJS.ErrnoException).code
            if (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY') {
                lastErr = err
                await sleep(50 * (i + 1))
                continue
            }
            throw err
        }
    }
    throw lastErr
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
    let raw: string
    try {
        raw = await fs.readFile(filePath, 'utf8')
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw err
    }
    try {
        return JSON.parse(raw) as T
    } catch {
        throw new StoreCorruptError(`corrupt JSON: ${filePath}`)
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms))
}

export class RunStore {
    readonly ttlDays: number

    constructor(
        readonly dataDir: string,
        opts: { ttlDays?: number } = {},
    ) {
        this.ttlDays = opts.ttlDays ?? DEFAULT_TTL_DAYS
    }

    get runsDir(): string {
        return nodePath.join(this.dataDir, 'runs')
    }

    /**
     * create() mutex dir, one entry per request fingerprint. Deliberately
     * outside runsDir so list/cleanExpired/reconcile never scan it.
     */
    get locksDir(): string {
        return nodePath.join(this.dataDir, 'locks')
    }

    runDir(runId: string): string {
        assertSafeRunId(runId)
        return nodePath.join(this.runsDir, runId)
    }

    // ---------- create / idempotent submit ----------

    async create(input: CreateRunInput, now: string = new Date().toISOString()): Promise<CreateRunOutcome> {
        const fingerprint = requestFingerprint(input.endpoint, input.cwd, input.task_text, input.mode)
        // idempotency: identical fingerprint on a non-terminal run returns that run
        const existing = await this.findByFingerprint(fingerprint)
        if (existing) return { ...existing, created: false }

        // two submitters can pass the scan above concurrently; serialize the
        // run-dir creation on a per-fingerprint lock dir so exactly one wins
        const lockPath = this.createLockPath(fingerprint)
        const lockStamp = `${now}\n${process.pid}-${randomBytes(4).toString('hex')}`
        await fs.mkdir(this.locksDir, { recursive: true })
        // crashed holders leave locks behind; sweep the provably-abandoned ones
        await this.sweepCreateLocks()
        const contested = await this.acquireCreateLock(lockPath, fingerprint, lockStamp)
        if (contested) return contested

        try {
            // re-scan under the lock: the previous holder may have created the
            // run while we were acquiring
            const recheck = await this.findByFingerprint(fingerprint)
            if (recheck) return { ...recheck, created: false }

            await fs.mkdir(this.runsDir, { recursive: true })
            let runId = newRunId()
            for (let attempt = 0; attempt < 5; attempt++) {
                try {
                    await fs.mkdir(this.runDir(runId), { recursive: false })
                    break
                } catch (err) {
                    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
                    runId = newRunId()
                    if (attempt === 4) throw new Error('could not allocate a unique run_id')
                }
            }

            const request: RunRequest = {
                schema_version: '1.0.0',
                run_id: runId,
                fingerprint,
                endpoint: input.endpoint,
                cwd: input.cwd,
                add_dirs: input.add_dirs,
                task_file: input.task_file,
                task_text: input.task_text,
                mode: input.mode,
                model: input.model,
                effort: input.effort,
                resume_session: input.resume_session,
                run_timeout_sec: input.run_timeout_sec,
                deliverables: input.deliverables,
                created_at: now,
                warnings: input.warnings,
            }
            const state: RunStateRecord = {
                schema_version: '1.0.0',
                run_id: runId,
                state: 'pending',
                worker: null,
                session: { handle: null, resumable: false },
                created_at: now,
                updated_at: now,
                terminal_at: null,
            }
            await writeJsonAtomic(this.requestPath(runId), request)
            await writeJsonAtomic(this.statePath(runId), state)
            return { request, state, created: true }
        } finally {
            // the lock is released once state.json is on disk (or the create
            // failed) — only if it is still OUR lock: a competitor may have
            // broken it as stale and re-acquired it in the meantime
            await this.rmCreateLockIfMatches(lockPath, lockStamp)
        }
    }

    private async readCreateLockStamp(lockPath: string): Promise<string | null> {
        try {
            return await fs.readFile(nodePath.join(lockPath, 'created_at'), 'utf8')
        } catch {
            return null
        }
    }

    /** Remove lock dirs past the stale age — no legitimate holder can occupy the critical section that long. */
    private async sweepCreateLocks(): Promise<void> {
        let entries: string[]
        try {
            entries = await fs.readdir(this.locksDir)
        } catch {
            return
        }
        for (const entry of entries) {
            if (!/^[0-9a-f]{64}$/.test(entry)) continue
            const candidate = nodePath.join(this.locksDir, entry)
            if (await this.createLockIsStale(candidate)) {
                await fs.rm(candidate, { recursive: true, force: true }).catch(() => {})
            }
        }
    }

    private async lockDirMtimeMs(lockPath: string): Promise<number | null> {
        try {
            return (await fs.stat(lockPath)).mtimeMs
        } catch {
            return null
        }
    }

    private async rmCreateLockIfMatches(lockPath: string, stamp: string): Promise<void> {
        if ((await this.readCreateLockStamp(lockPath)) === stamp) {
            await fs.rm(lockPath, { recursive: true, force: true }).catch(() => {})
        }
    }

    /**
     * Per-fingerprint mutex as a lock directory (mkdir is atomic everywhere).
     * Returns a CreateRunOutcome when a competitor's run appeared while we
     * waited; null means this caller now holds the lock. A lock older than
     * CREATE_LOCK_STALE_MS is stale (its creator crashed) and broken; a fresh
     * lock whose holder never produces a run within CREATE_LOCK_WAIT_MS is
     * treated the same way. Only after the retry also fails is an error raised.
     */
    private async acquireCreateLock(lockPath: string, fingerprint: string, lockStamp: string): Promise<CreateRunOutcome | null> {
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                await fs.mkdir(lockPath, { recursive: false })
            } catch (err) {
                if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
                // remember whose lock this is: stale-break / stuck-break below
                // only ever remove the SAME holder we contended with
                const seen = await this.readCreateLockStamp(lockPath)
                if (await this.createLockIsStale(lockPath)) {
                    if (seen !== null) {
                        await this.rmCreateLockIfMatches(lockPath, seen)
                    } else {
                        // stamp-less lock (holder died between mkdir and stamp — it
                        // can never be matched by stamp): break it only when the dir
                        // mtime is STILL past the stale age and it is STILL stamp-less
                        // (mtime as the token, same ownership discipline)
                        const before = await this.lockDirMtimeMs(lockPath)
                        if (
                            before !== null &&
                            Date.now() - before > CREATE_LOCK_STALE_MS &&
                            (await this.readCreateLockStamp(lockPath)) === null &&
                            (await this.lockDirMtimeMs(lockPath)) === before
                        ) {
                            await fs.rm(lockPath, { recursive: true, force: true }).catch(() => {})
                        }
                    }
                    continue
                }
                const appeared = await this.waitForFingerprint(fingerprint, CREATE_LOCK_WAIT_MS)
                if (appeared) return { ...appeared, created: false }
                // no run appeared: the holder is presumed stuck — break the
                // lock only if it is unchanged (a fresh holder gets its own wait)
                if (seen !== null) await this.rmCreateLockIfMatches(lockPath, seen)
                continue
            }
            try {
                await fs.writeFile(nodePath.join(lockPath, 'created_at'), lockStamp, 'utf8')
                return null
            } catch (err) {
                await this.rmCreateLockIfMatches(lockPath, lockStamp)
                throw err
            }
        }
        throw new Error(`could not acquire the create lock for fingerprint ${fingerprint}`)
    }

    /** sha256:<hex> -> <dataDir>/locks/<hex>; only the hex part becomes a dir name. */
    private createLockPath(fingerprint: string): string {
        const hex = fingerprint.replace(/^sha256:/, '')
        if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error(`unsafe fingerprint for create lock: ${fingerprint}`)
        return nodePath.join(this.locksDir, hex)
    }

    /** Lock age from the created_at stamp the acquirer writes into the lock dir. */
    private async createLockIsStale(lockPath: string): Promise<boolean> {
        const raw = await this.readCreateLockStamp(lockPath)
        if (raw !== null) {
            const createdMs = Date.parse(raw.split('\n', 1)[0] as string)
            if (Number.isFinite(createdMs)) return Date.now() - createdMs > CREATE_LOCK_STALE_MS
        }
        // no readable stamp (holder crashed mid-acquire): fall back to the dir mtime
        try {
            return Date.now() - (await fs.stat(lockPath)).mtimeMs > CREATE_LOCK_STALE_MS
        } catch {
            return false
        }
    }

    /** While a competitor holds the lock, poll for its run to become visible. */
    private async waitForFingerprint(fingerprint: string, timeoutMs: number): Promise<FingerprintHit | null> {
        const deadline = Date.now() + timeoutMs
        do {
            const found = await this.findByFingerprint(fingerprint)
            if (found) return found
            await sleep(CREATE_LOCK_POLL_MS)
        } while (Date.now() < deadline)
        return this.findByFingerprint(fingerprint)
    }

    /** The non-terminal run carrying this fingerprint, or null. */
    private async findByFingerprint(fingerprint: string): Promise<FingerprintHit | null> {
        const existing = await this.list({ skipCleanup: true })
        for (const state of existing) {
            if (isTerminal(state.state)) continue
            const req = await this.readRequest(state.run_id).catch(() => null)
            if (req && req.fingerprint === fingerprint) return { request: req, state }
        }
        return null
    }

    // ---------- read ----------

    async readRequest(runId: string): Promise<RunRequest> {
        const req = await readJsonFile<RunRequest>(this.requestPath(runId))
        if (!req) throw new StoreCorruptError(`request.json missing for ${runId}`)
        if (req.schema_version !== '1.0.0' || req.run_id !== runId || typeof req.task_text !== 'string') {
            throw new StoreCorruptError(`invalid request.json for ${runId}`)
        }
        return req
    }

    /** null when state.json does not exist; throws on corruption. */
    async readState(runId: string): Promise<RunStateRecord | null> {
        const state = await readJsonFile<RunStateRecord>(this.statePath(runId))
        if (!state) return null
        if (state.schema_version !== '1.0.0' || state.run_id !== runId) {
            throw new StoreCorruptError(`invalid state.json for ${runId}`)
        }
        return state
    }

    async readResult(runId: string): Promise<RunResult | null> {
        const result = await readJsonFile<RunResult>(this.resultPath(runId))
        if (!result) return null
        if (result.schema_version !== '1.0.0' || result.run_id !== runId) {
            throw new StoreCorruptError(`invalid result.json for ${runId}`)
        }
        return result
    }

    // ---------- write ----------

    async writeState(state: RunStateRecord): Promise<void> {
        await writeJsonAtomic(this.statePath(state.run_id), state)
    }

    /** Same-state field patch (worker registers endpoint_pid / session). Not a transition. */
    async patchState(
        runId: string,
        now: string,
        patch: Partial<Omit<RunStateRecord, 'schema_version' | 'run_id' | 'state' | 'created_at'>>,
    ): Promise<RunStateRecord | null> {
        const current = await this.readState(runId)
        if (!current) return null
        const next: RunStateRecord = { ...current, ...patch, updated_at: now }
        await this.writeState(next)
        return next
    }

    /** result.json is written once; a conflicting second write is corruption, an identical one is a no-op. */
    async writeResult(result: RunResult): Promise<void> {
        const existing = await readJsonFile<RunResult>(this.resultPath(result.run_id))
        if (existing) {
            if (JSON.stringify(existing) === JSON.stringify(result)) return
            throw new StoreCorruptError(`result.json already exists for ${result.run_id}`)
        }
        await writeJsonAtomic(this.resultPath(result.run_id), result)
    }

    /** Callers redact before appending; the store treats events as opaque. */
    async appendEvent(runId: string, event: RunEvent): Promise<void> {
        const line = JSON.stringify(event) + '\n'
        await fs.mkdir(this.runDir(runId), { recursive: true })
        await fs.appendFile(this.eventsPath(runId), line, 'utf8')
    }

    async readEvents(runId: string): Promise<RunEvent[]> {
        let raw: string
        try {
            raw = await fs.readFile(this.eventsPath(runId), 'utf8')
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
            throw err
        }
        const events: RunEvent[] = []
        for (const line of raw.split(/\r?\n/)) {
            if (!line.trim()) continue
            try {
                events.push(JSON.parse(line) as RunEvent)
            } catch {
                events.push({ ts: '', type: 'corrupt-line', raw: line.slice(0, 200) })
            }
        }
        return events
    }

    // ---------- list + TTL cleanup ----------

    async list(query: { states?: RunState[]; limit?: number; skipCleanup?: boolean } = {}): Promise<RunStateRecord[]> {
        if (!query.skipCleanup) {
            await this.cleanExpired(new Date().toISOString(), 50).catch(() => {})
        }
        let entries: string[]
        try {
            entries = await fs.readdir(this.runsDir)
        } catch {
            return []
        }
        const states: RunStateRecord[] = []
        for (const name of entries) {
            if (!RUN_ID_RE.test(name)) continue
            try {
                const state = await this.readState(name)
                if (!state) continue
                if (query.states && !query.states.includes(state.state)) continue
                states.push(state)
            } catch {
                // one corrupt run must not break list
            }
        }
        states.sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
        return query.limit && query.limit > 0 ? states.slice(0, query.limit) : states
    }

    /** Remove terminal runs older than ttlDays (by terminal_at, falling back to updated_at). */
    async cleanExpired(nowIso: string, limit: number): Promise<{ cleaned: string[]; errors: string[] }> {
        const report = { cleaned: [] as string[], errors: [] as string[] }
        let entries: string[]
        try {
            entries = await fs.readdir(this.runsDir)
        } catch {
            return report
        }
        const cutoff = Date.parse(nowIso) - this.ttlDays * 24 * 60 * 60 * 1000
        for (const name of entries) {
            if (report.cleaned.length >= limit) break
            if (!RUN_ID_RE.test(name)) continue
            try {
                const state = await this.readState(name)
                if (!state || !isTerminal(state.state)) continue
                const basis = Date.parse(state.terminal_at ?? state.updated_at)
                if (!Number.isFinite(basis) || basis >= cutoff) continue
                await this.removeRunDirSafe(name)
                report.cleaned.push(name)
            } catch (err) {
                report.errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`)
            }
        }
        return report
    }

    private async removeRunDirSafe(runId: string): Promise<void> {
        const dir = this.runDir(runId)
        const realRoot = await fs.realpath(this.runsDir)
        const realDir = await fs.realpath(dir)
        const expected = nodePath.join(realRoot, runId)
        if (nodePath.normalize(realDir).toLowerCase() !== nodePath.normalize(expected).toLowerCase()) {
            throw new Error(`refusing to delete outside runs dir: ${realDir}`)
        }
        await fs.rm(dir, { recursive: true, force: true })
    }

    // ---------- paths ----------

    requestPath(runId: string): string {
        return nodePath.join(this.runDir(runId), 'request.json')
    }

    statePath(runId: string): string {
        return nodePath.join(this.runDir(runId), 'state.json')
    }

    eventsPath(runId: string): string {
        return nodePath.join(this.runDir(runId), 'events.jsonl')
    }

    resultPath(runId: string): string {
        return nodePath.join(this.runDir(runId), 'result.json')
    }

    cancelMarkerPath(runId: string): string {
        return nodePath.join(this.runDir(runId), 'cancel.request')
    }
}
