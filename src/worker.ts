// Detached worker entry: `node dist/worker.js <run_id>`.
// Owns the endpoint process lifecycle and is the only writer of events/state/result
// after submit. Never babysat by the CLI; reconcile cleans up if it dies.

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as nodePath from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { loadConfig, resolveDataDir } from './engine/config.js'
import { createRedactor } from './engine/redactor.js'
import { RunStore, sha256Hex } from './engine/run-store.js'
import { isTerminal, transitionRecord } from './engine/state-machine.js'
import { terminateEndpointTree } from './engine/supervisor.js'
import { judgeTerminal } from './engine/terminal.js'
import type { DeliverableEvidence, RunEvent, RunResult, TerminalState } from './engine/types.js'
import { UsageDb } from './engine/usage-db.js'
import { buildArgs, buildEnv, createEndpointParser, EndpointRegistry, ManifestError } from './endpoints/registry.js'
import { finalSpawnArgs, needsVerbatimArgs, planEndpointSpawn } from './endpoints/spawn.js'

const STDERR_CAPTURE_LIMIT = 256 * 1024
const STDOUT_EVENT_EVERY_LINES = 200
const CANCEL_POLL_MS = 500

const now = () => new Date().toISOString()

async function main(): Promise<number> {
    const runId = process.argv[2] ?? ''
    if (!/^run_\d{8}_[0-9a-f]{8}$/.test(runId)) {
        process.stderr.write(`worker: invalid run_id "${runId}"\n`)
        return 1
    }
    const config = loadConfig()
    const dataDir = process.env.PAIDAN_DATA_DIR ?? resolveDataDir(config)
    const store = new RunStore(dataDir)
    const redactor = createRedactor()

    let request
    try {
        request = await store.readRequest(runId)
    } catch (err) {
        process.stderr.write(`worker: cannot read request for ${runId}: ${String(err)}\n`)
        return 1
    }
    const initial = await store.readState(runId)
    if (!initial || isTerminal(initial.state)) return 0

    // pending -> running, registering worker identity; reconcile uses this pid
    try {
        await store.writeState(
            transitionRecord(initial, 'running', now(), {
                worker: { pid: process.pid, started_at: now(), endpoint_pid: null },
            }),
        )
    } catch {
        return 0 // cancelled/terminal race: nothing to do
    }

    const fail = async (code: string, message: string, exitCode: number | null = null): Promise<number> => {
        await finalize(store, runId, request.endpoint, request.model, {
            state: 'failed',
            exit_code: exitCode,
            final_text: '',
            evidence: {
                deliverables: [],
                refusals: [],
                parser: { type: 'none', degraded: false },
                notes: [`${code}: ${message}`],
            },
            usage: { input_tokens: null, output_tokens: null, cached_input_tokens: null, source: 'unavailable' },
            session_handle: null,
        })
        return 0
    }

    if (existsSync(store.cancelMarkerPath(runId))) {
        return finalizeCancelled(store, runId, request.endpoint, request.model, null, 'cancel requested before endpoint spawn')
    }

    let registry: EndpointRegistry
    try {
        registry = await EndpointRegistry.load()
    } catch (err) {
        return fail('MANIFEST_LOAD_FAILED', err instanceof Error ? err.message : String(err))
    }

    try {
        const manifest = registry.get(request.endpoint)
        const { parser, detectRefusals, readLedgerUsage } = await createEndpointParser(manifest)
        const spawnRes = await planEndpointSpawn(manifest, {
            configBin: config.endpoints.overrides[request.endpoint]?.bin ?? null,
        })
        if (!spawnRes.plan) {
            return fail(
                'ENDPOINT_BIN_NOT_FOUND',
                `cannot resolve "${manifest.detect.bin}": ${spawnRes.notes.join('; ')}; run paidan doctor`,
            )
        }
        const plan = spawnRes.plan

        let args = buildArgs(manifest, request)
        if (manifest.command.prompt_delivery === 'file') {
            const promptPath = nodePath.join(store.runDir(runId), 'prompt.txt')
            await fs.writeFile(promptPath, request.task_text, 'utf8')
            args = args.map((a) => a.replaceAll('{prompt_file}', promptPath))
        }
        let spawnArgs: string[]
        try {
            spawnArgs = finalSpawnArgs(plan, args)
        } catch (err) {
            return fail('SPAWN_UNSUPPORTED', err instanceof Error ? err.message : String(err))
        }
        const useStdin = manifest.command.prompt_delivery === 'stdin'

        const child = spawn(plan.command, spawnArgs, {
            cwd: request.cwd,
            env: buildEnv(manifest),
            windowsHide: true,
            detached: process.platform !== 'win32',
            stdio: [useStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
            windowsVerbatimArguments: needsVerbatimArgs(plan),
        })
        if (useStdin && child.stdin) {
            child.stdin.write(request.task_text)
            child.stdin.end()
        }
        if (child.pid === undefined) {
            return fail('SPAWN_FAILED', `endpoint spawn returned no pid (bin ${plan.endpoint_bin ?? plan.command})`)
        }
        const endpointPid = child.pid
        const current = await store.readState(runId)
        await store.patchState(runId, now(), {
            worker: { pid: process.pid, started_at: current?.worker?.started_at ?? now(), endpoint_pid: endpointPid },
        })
        const argvForLog = [plan.endpoint_bin ?? plan.command, ...args].map((a) =>
            a === request.task_text ? `[prompt sha256:${sha256Hex(a).slice(0, 12)}]` : a,
        )
        await store.appendEvent(runId, redactor.redactJson({
            ts: now(), type: 'spawn', pid: endpointPid, argv: argvForLog, cwd: request.cwd, resolved_from: plan.resolved_from,
        }) as RunEvent)

        const completion = new Promise<{ exitCode: number | null; signal: string | null }>((resolve) => {
            if (child.exitCode !== null || child.signalCode !== null) {
                resolve({ exitCode: child.exitCode, signal: child.signalCode })
                return
            }
            child.once('exit', (code, signal) => resolve({ exitCode: code, signal }))
        })
        child.once('error', () => {})

        // streaming parse; stderr kept bounded for refusal detection
        const stdoutDecoder = new StringDecoder('utf8')
        const stderrDecoder = new StringDecoder('utf8')
        let stdoutBuf = ''
        let stderrBuf = ''
        let stderrTail = ''
        let stdoutLines = 0
        let stdoutBytes = 0
        const feedStdout = async (text: string) => {
            stdoutBuf += text
            let nl: number
            while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
                const line = stdoutBuf.slice(0, nl)
                stdoutBuf = stdoutBuf.slice(nl + 1)
                parser.acceptStdoutLine(line)
                stdoutLines++
                stdoutBytes += Buffer.byteLength(line, 'utf8') + 1
                if (stdoutLines % STDOUT_EVENT_EVERY_LINES === 0) {
                    await store.appendEvent(runId, { ts: now(), type: 'stdout-meta', lines: stdoutLines, bytes: stdoutBytes })
                }
            }
        }
        const feedStderr = (text: string) => {
            stderrBuf += text
            stderrTail = (stderrTail + text).slice(-STDERR_CAPTURE_LIMIT)
            let nl: number
            while ((nl = stderrBuf.indexOf('\n')) >= 0) {
                const line = stderrBuf.slice(0, nl)
                stderrBuf = stderrBuf.slice(nl + 1)
                parser.acceptStderrLine(line)
            }
        }
        const stdoutDone = pipeTo(child.stdout, (chunk) => feedStdout(stdoutDecoder.write(chunk)))
        const stderrDone = pipeTo(child.stderr, (chunk) => {
            feedStderr(stderrDecoder.write(chunk))
            return Promise.resolve()
        })

        // explicit cancel: marker file -> tree kill (in the watcher, not after
        // completion — a long task must actually be interrupted)
        let cancelRequested = false
        let cancelKillStarted = false
        const startCancelKill = () => {
            if (cancelKillStarted) return
            cancelKillStarted = true
            cancelRequested = true
            void (async () => {
                const term = await terminateEndpointTree(endpointPid)
                await store.appendEvent(runId, {
                    ts: now(), type: 'cancel', pid: endpointPid, method: term.method, ok: term.ok,
                }).catch(() => {})
            })()
        }
        const cancelWatcher = setInterval(() => {
            if (existsSync(store.cancelMarkerPath(runId))) startCancelKill()
        }, CANCEL_POLL_MS)
        if (existsSync(store.cancelMarkerPath(runId))) startCancelKill()

        const { exitCode, signal } = await completion
        clearInterval(cancelWatcher)
        await Promise.all([stdoutDone, stderrDone])

        if (cancelRequested) {
            return finalizeCancelled(
                store, runId, request.endpoint, request.model, exitCode,
                `cancel requested by user; endpoint tree killed (exit_code=${exitCode ?? 'null'})`,
            )
        }

        const parsed = parser.finish(stdoutBuf + stdoutDecoder.end(), stderrBuf + stderrDecoder.end())
        if (parsed.sessionId) {
            await store.patchState(runId, now(), {
                session: { handle: parsed.sessionId, resumable: manifest.resume?.kind === 'flag' },
            })
            await store.appendEvent(runId, { ts: now(), type: 'session', handle: parsed.sessionId })
        }
        // usage: stream parser first; when the stream carries none, try the
        // endpoint's native ledger (e.g. kimi session wire.jsonl). Never fabricate.
        let usage = parsed.usage
        const usageNotes: string[] = []
        if (!usage && parsed.sessionId && readLedgerUsage) {
            try {
                const ledger = await readLedgerUsage(parsed.sessionId, { resume: request.resume_session !== null })
                usageNotes.push(...ledger.warnings)
                if (ledger.usage) {
                    usage = ledger.usage
                    await store.appendEvent(runId, {
                        ts: now(), type: 'usage-ledger', source: ledger.usage.source,
                        input_tokens: ledger.usage.input_tokens, output_tokens: ledger.usage.output_tokens,
                    })
                }
            } catch (err) {
                usageNotes.push(`ledger usage read failed: ${err instanceof Error ? err.message : String(err)}`)
            }
        }
        const deliverables = await resolveDeliverables(request.deliverables, request.cwd)
        const refusals = [...new Set([...parsed.refusals, ...detectRefusals(stderrTail, exitCode)])]
        const judgment = judgeTerminal({
            exit_code: exitCode,
            signal,
            final_text: parsed.finalText,
            deliverables_declared: request.deliverables.length > 0,
            deliverables,
            refusals,
            parser: { type: manifest.parser, degraded: parsed.degraded },
            capabilities: { completed_nonzero_exit: manifest.capabilities?.completed_nonzero_exit },
        })
        const notes = [...judgment.notes, ...parsed.warnings, ...usageNotes]
        await store.appendEvent(runId, redactor.redactJson({
            ts: now(), type: 'terminal', state: judgment.state, exit_code: exitCode, signal, notes,
        }) as RunEvent)
        await finalize(store, runId, request.endpoint, request.model, {
            state: judgment.state,
            exit_code: exitCode,
            final_text: parsed.finalText,
            evidence: {
                deliverables,
                refusals,
                parser: { type: manifest.parser, degraded: parsed.degraded },
                notes,
            },
            // usage: parser-reported (provider) or native-ledger observation
            // (endpoint-ledger); absent stays unavailable
            usage: usage ?? { input_tokens: null, output_tokens: null, cached_input_tokens: null, source: 'unavailable' },
            session_handle: parsed.sessionId,
        })
        return 0
    } catch (err) {
        if (err instanceof ManifestError) return fail('MANIFEST_INVALID', err.message)
        return fail('WORKER_ERROR', err instanceof Error ? err.message : String(err))
    }
}

async function resolveDeliverables(
    specs: Array<{ path: string; expected: string | null }>,
    cwd: string,
): Promise<DeliverableEvidence[]> {
    const out: DeliverableEvidence[] = []
    for (const spec of specs) {
        const abs = nodePath.resolve(cwd, spec.path)
        let found = false
        try {
            if (spec.expected === null) {
                await fs.stat(abs)
                found = true
            } else {
                const content = await fs.readFile(abs, 'utf8')
                found = content.includes(spec.expected)
            }
        } catch {
            found = false
        }
        out.push({ path: spec.path, expected: spec.expected, found })
    }
    return out
}

async function finalizeCancelled(
    store: RunStore,
    runId: string,
    endpoint: string,
    model: string | null,
    exitCode: number | null,
    note: string,
): Promise<number> {
    await finalize(store, runId, endpoint, model, {
        state: 'cancelled',
        exit_code: exitCode,
        final_text: '',
        evidence: {
            deliverables: [],
            refusals: [],
            parser: { type: 'none', degraded: false },
            notes: [note],
        },
        usage: { input_tokens: null, output_tokens: null, cached_input_tokens: null, source: 'unavailable' },
        session_handle: null,
    })
    return 0
}

interface TerminalWrite {
    state: TerminalState
    exit_code: number | null
    final_text: string
    evidence: RunResult['evidence']
    usage: RunResult['usage']
    session_handle: string | null
}

/** result.json once, state transition, usage row — redacted before hitting disk. */
async function finalize(
    store: RunStore,
    runId: string,
    endpoint: string,
    model: string | null,
    write: TerminalWrite,
): Promise<void> {
    const redactor = createRedactor()
    const result = redactor.redactJson({
        schema_version: '1.0.0',
        run_id: runId,
        state: write.state,
        exit_code: write.exit_code,
        final_text: write.final_text,
        evidence: write.evidence,
        usage: write.usage,
        session_handle: write.session_handle,
        terminal_at: now(),
    }) as unknown as RunResult
    try {
        await store.writeResult(result)
    } catch (err) {
        await store.appendEvent(runId, {
            ts: now(), type: 'worker-error', note: `writeResult failed: ${err instanceof Error ? err.message : String(err)}`,
        })
    }
    const current = await store.readState(runId)
    if (current && !isTerminal(current.state)) {
        try {
            await store.writeState(transitionRecord(current, write.state, result.terminal_at))
        } catch (err) {
            await store.appendEvent(runId, {
                ts: now(), type: 'worker-error', note: `state transition to ${write.state} failed: ${err instanceof Error ? err.message : String(err)}`,
            })
        }
    }
    try {
        const db = new UsageDb(nodePath.join(store.dataDir, 'usage.db'))
        db.record({
            run_id: runId,
            endpoint,
            connection: model && model.includes('/') ? model.split('/')[0] ?? null : null,
            model,
            input_tokens: write.usage.input_tokens,
            cached_input_tokens: write.usage.cached_input_tokens,
            output_tokens: write.usage.output_tokens,
            cost: null,
            source: write.usage.source,
            recorded_at: result.terminal_at,
        })
        db.close()
    } catch {
        await store.appendEvent(runId, { ts: now(), type: 'worker-error', note: 'usage.db write failed' }).catch(() => {})
    }
}

async function pipeTo(
    stream: NodeJS.ReadableStream | null,
    onData: (chunk: Uint8Array) => Promise<unknown>,
): Promise<void> {
    if (!stream) return
    const rs = stream as import('node:stream').Readable
    return new Promise((resolve) => {
        const done = () => resolve()
        if (rs.readableEnded || rs.destroyed) {
            done()
            return
        }
        rs.on('data', (chunk: Uint8Array) => {
            onData(chunk).catch(() => {})
        })
        rs.on('end', done)
        rs.on('close', done)
        rs.on('error', done)
    })
}

// A worker crashing before finalize leaves the run non-terminal; reconcile marks
// it attention on the next CLI invocation. Keep stderr textual (never stdout JSON).
main()
    .then((code) => {
        process.exitCode = code
    })
    .catch((err) => {
        process.stderr.write(`worker fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`)
        process.exitCode = 1
    })
