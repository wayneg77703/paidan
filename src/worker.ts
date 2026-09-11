// Detached worker entry: `node dist/worker.js <run_id>`.
// Owns the endpoint process lifecycle and is the only writer of events/state/result
// after submit. Never babysat by the CLI; reconcile cleans up if it dies.

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as nodePath from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { loadConfig, resolveDataDir, DEFAULT_RUN_TIMEOUT_SEC } from './engine/config.js'
import { queryProcessStart, verifyProcessIdentity } from './engine/process-identity.js'
import { createRedactor } from './engine/redactor.js'
import { RunStore, sha256Hex } from './engine/run-store.js'
import { isTerminal, transitionRecord } from './engine/state-machine.js'
import { terminateEndpointTree, type TerminateTreeResult } from './engine/supervisor.js'
import { judgeTerminal } from './engine/terminal.js'
import type { DeliverableEvidence, RunEvent, RunRequest, RunResult, TerminalState } from './engine/types.js'
import { UsageDb } from './engine/usage-db.js'
import { buildArgs, buildEnv, createEndpointParser, EndpointRegistry, ManifestError, withPromptCwdHint } from './endpoints/registry.js'
import { cmdShimRefusalMessage, finalSpawnArgs, needsVerbatimArgs, planEndpointSpawn } from './endpoints/spawn.js'

const STDERR_CAPTURE_LIMIT = 256 * 1024
const STDOUT_EVENT_EVERY_LINES = 200
const CANCEL_POLL_MS = 500
// a stdout/stderr line that never sees '\n' must not grow without bound; past
// this cap the buffered prefix is fed to the parser as one (degraded) line
const MAX_STDIO_LINE_BYTES = 16 * 1024 * 1024

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

    // pending -> running, registering worker identity; reconcile uses this pid.
    // pid_start is the platform start token so reconcile can tell a reused pid
    // from this worker; a failed query degrades to pid-only liveness (noted).
    const selfStart = await queryProcessStart(process.pid)
    try {
        await store.writeState(
            transitionRecord(initial, 'running', now(), {
                worker: { pid: process.pid, started_at: now(), pid_start: selfStart, endpoint_pid: null },
            }),
        )
    } catch {
        return 0 // cancelled/terminal race: nothing to do
    }
    if (selfStart === null) {
        await store.appendEvent(runId, {
            ts: now(), type: 'note',
            note: 'process identity query unavailable for the worker; pid-reuse checks degrade to pid liveness',
        }).catch(() => {})
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
            usage: { input_tokens: null, output_tokens: null, cached_input_tokens: null, cost: null, source: 'unavailable' },
            session_handle: null,
        }, redactor)
        return 0
    }

    if (existsSync(store.cancelMarkerPath(runId))) {
        return finalizeCancelled(store, runId, request.endpoint, request.model, null, 'cancel requested before endpoint spawn', redactor)
    }

    let registry: EndpointRegistry
    try {
        registry = await EndpointRegistry.load()
    } catch (err) {
        return fail('MANIFEST_LOAD_FAILED', err instanceof Error ? err.message : String(err))
    }

    try {
        const manifest = registry.get(request.endpoint)
        const { parser, detectRefusals, readLedgerUsage, captureLedgerCursor } = await createEndpointParser(manifest)
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

        // cmd-shim backstop (same semantics as the CLI-side guard): cmd.exe
        // re-splits the shim's %* on spaces, so argv prompt delivery would
        // mangle the prompt. Refuse before anything is spawned.
        if (plan.resolved_from === 'cmd-shim' && manifest.command.prompt_delivery === 'argv') {
            const note = cmdShimRefusalMessage(manifest.name, plan.endpoint_bin ?? manifest.detect.bin)
            await store.appendEvent(runId, redactor.redactJson({
                ts: now(), type: 'spawn-refused', endpoint: manifest.name,
                resolved_from: plan.resolved_from, prompt_delivery: manifest.command.prompt_delivery, note,
            }) as RunEvent)
            return fail('SPAWN_UNSUPPORTED', note)
        }

        // resume runs with a native ledger: pin wire byte sizes pre-spawn so the
        // settlement sums only this run's delta (undefined = no cursor taken)
        let ledgerCursor: unknown
        if (request.resume_session && readLedgerUsage && captureLedgerCursor) {
            try {
                ledgerCursor = await captureLedgerCursor(request.resume_session)
            } catch {
                ledgerCursor = undefined
            }
        }

        // request.json keeps the original task text; only the delivered copy carries the hint
        const hint = withPromptCwdHint(manifest, request.task_text, request.cwd)
        const delivery: RunRequest = hint.appended ? { ...request, task_text: hint.text } : request
        if (hint.appended) {
            await store.appendEvent(runId, { ts: now(), type: 'note', note: 'prompt_cwd_hint appended' })
        }
        let args = buildArgs(manifest, delivery)
        if (manifest.command.prompt_delivery === 'file') {
            const promptPath = nodePath.join(store.runDir(runId), 'prompt.txt')
            await fs.writeFile(promptPath, delivery.task_text, 'utf8')
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
            env: buildEnv(manifest, process.env, request.mode, request.effort),
            windowsHide: true,
            detached: process.platform !== 'win32',
            stdio: [useStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
            windowsVerbatimArguments: needsVerbatimArgs(plan),
        })
        if (useStdin && child.stdin) {
            // an endpoint that exits before reading stdin raises EPIPE/EOF on
            // the stream; without a listener that is an uncaught exception and
            // the worker dies leaving the run 'running' forever (reproduced).
            // The exit event still fires and the terminal judgment proceeds.
            child.stdin.on('error', (err: NodeJS.ErrnoException) => {
                void store.appendEvent(runId, {
                    ts: now(), type: 'note',
                    note: `endpoint closed stdin early (${err.code ?? 'error'}); judging by the exit path`,
                }).catch(() => {})
            })
            child.stdin.write(delivery.task_text)
            child.stdin.end()
        }
        if (child.pid === undefined) {
            return fail('SPAWN_FAILED', `endpoint spawn returned no pid (bin ${plan.endpoint_bin ?? plan.command})`)
        }
        const endpointPid = child.pid
        // in flight while the stream plumbing attaches below — awaiting it inline
        // here would let a fast endpoint exit before the stdout listeners exist
        // (Windows destroys the pipe on exit and the buffered output is lost)
        const endpointStartP = queryProcessStart(endpointPid)

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
        // buffered line overflow: record honestly, feed the capped prefix to
        // the parser (it will likely degrade — that is the honest path)
        const stdioTruncated = async (stream: 'stdout' | 'stderr', bytes: number) => {
            await store.appendEvent(runId, { ts: now(), type: 'stdio-truncated', stream, bytes }).catch(() => {})
        }
        const cappedPrefix = (buf: string): string =>
            Buffer.from(buf, 'utf8').subarray(0, MAX_STDIO_LINE_BYTES).toString('utf8')
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
            if (Buffer.byteLength(stdoutBuf, 'utf8') > MAX_STDIO_LINE_BYTES) {
                const bytes = Buffer.byteLength(stdoutBuf, 'utf8')
                const line = cappedPrefix(stdoutBuf)
                stdoutBuf = ''
                await stdioTruncated('stdout', bytes)
                parser.acceptStdoutLine(line)
                stdoutLines++
                stdoutBytes += Buffer.byteLength(line, 'utf8')
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
            if (Buffer.byteLength(stderrBuf, 'utf8') > MAX_STDIO_LINE_BYTES) {
                const bytes = Buffer.byteLength(stderrBuf, 'utf8')
                const line = cappedPrefix(stderrBuf)
                stderrBuf = ''
                void stdioTruncated('stderr', bytes)
                parser.acceptStderrLine(line)
            }
        }
        // the stream-end tail handed to parser.finish obeys the same cap
        const boundedTail = async (buf: string, end: string, stream: 'stdout' | 'stderr'): Promise<string> => {
            const tail = buf + end
            const bytes = Buffer.byteLength(tail, 'utf8')
            if (bytes <= MAX_STDIO_LINE_BYTES) return tail
            await stdioTruncated(stream, bytes)
            return cappedPrefix(tail)
        }
        const stdoutDone = pipeTo(child.stdout, (chunk) => feedStdout(stdoutDecoder.write(chunk)))
        const stderrDone = pipeTo(child.stderr, (chunk) => {
            feedStderr(stderrDecoder.write(chunk))
            return Promise.resolve()
        })

        // stream plumbing is attached; now register identity, log the spawn,
        // and arm the wall-clock cap
        const endpointStart = await endpointStartP
        const current = await store.readState(runId)
        await store.patchState(runId, now(), {
            worker: {
                pid: process.pid,
                started_at: current?.worker?.started_at ?? now(),
                pid_start: current?.worker?.pid_start ?? null,
                endpoint_pid: endpointPid,
                endpoint_pid_start: endpointStart,
            },
        })
        if (endpointStart === null) {
            await store.appendEvent(runId, {
                ts: now(), type: 'note',
                note: 'process identity query unavailable for the endpoint; cancel/reconcile degrade to pid liveness',
            }).catch(() => {})
        }
        const argvForLog = [plan.endpoint_bin ?? plan.command, ...args].map((a) =>
            a === delivery.task_text ? `[prompt sha256:${sha256Hex(a).slice(0, 12)}]` : a,
        )
        await store.appendEvent(runId, redactor.redactJson({
            ts: now(), type: 'spawn', pid: endpointPid, argv: argvForLog, cwd: request.cwd, resolved_from: plan.resolved_from,
        }) as RunEvent)

        // contracts §5: re-verify the endpoint's start token before any direct
        // kill — a reused pid must never be taskkilled. 'mismatch' means the
        // recorded endpoint is already gone (kill skipped, flow continues as
        // if it had exited); 'unknown' (query unavailable or no recorded
        // token) degrades to the pid-only behavior, with a note.
        const terminateEndpointVerified = async (): Promise<TerminateTreeResult | null> => {
            const verdict = await verifyProcessIdentity(endpointPid, endpointStart)
            if (verdict === 'mismatch') {
                await store.appendEvent(runId, {
                    ts: now(), type: 'note',
                    note: 'endpoint pid identity mismatch (pid reused); tree kill skipped',
                }).catch(() => {})
                return null
            }
            if (verdict === 'unknown') {
                await store.appendEvent(runId, {
                    ts: now(), type: 'note',
                    note: 'endpoint identity re-query unavailable; tree kill degrades to pid liveness',
                }).catch(() => {})
            }
            return terminateEndpointTree(endpointPid)
        }

        // engine wall-clock cap: at the deadline kill the endpoint tree (same
        // termination path as cancel); the judgment below is then forced to
        // failed with a 'run timeout after Ns' note. 0 disables; pre-timeout
        // requests (no field) fall back to the default.
        const runTimeoutSec = request.run_timeout_sec ?? DEFAULT_RUN_TIMEOUT_SEC
        let runTimedOut = false
        const runTimer = runTimeoutSec > 0
            ? setTimeout(() => {
                runTimedOut = true
                void (async () => {
                    const term = await terminateEndpointVerified()
                    await store.appendEvent(runId, {
                        ts: now(), type: 'run-timeout', pid: endpointPid, after_sec: runTimeoutSec,
                        method: term?.method ?? 'already_exited', ok: term?.ok ?? true,
                    }).catch(() => {})
                })()
            }, runTimeoutSec * 1000)
            : null

        // explicit cancel: marker file -> tree kill (in the watcher, not after
        // completion — a long task must actually be interrupted)
        let cancelRequested = false
        let cancelKillStarted = false
        const startCancelKill = () => {
            if (cancelKillStarted) return
            cancelKillStarted = true
            cancelRequested = true
            void (async () => {
                const term = await terminateEndpointVerified()
                await store.appendEvent(runId, {
                    ts: now(), type: 'cancel', pid: endpointPid, method: term?.method ?? 'already_exited', ok: term?.ok ?? true,
                }).catch(() => {})
            })()
        }
        const cancelWatcher = setInterval(() => {
            if (existsSync(store.cancelMarkerPath(runId))) startCancelKill()
        }, CANCEL_POLL_MS)
        if (existsSync(store.cancelMarkerPath(runId))) startCancelKill()

        const { exitCode, signal } = await completion
        if (runTimer) clearTimeout(runTimer)
        clearInterval(cancelWatcher)
        await Promise.all([stdoutDone, stderrDone])
        // a marker that landed in the completion window (after the last poll)
        // is still honored — the endpoint already exited on its own
        if (!cancelRequested && existsSync(store.cancelMarkerPath(runId))) {
            cancelRequested = true
            await store.appendEvent(runId, {
                ts: now(), type: 'cancel', pid: endpointPid, method: 'already_exited', ok: true,
            }).catch(() => {})
        }

        // parse + evidence collection run on every exit path, including a
        // cancel that raced a successful completion: the run still ends
        // cancelled, but the endpoint's evidence is never thrown away
        const parsed = parser.finish(
            await boundedTail(stdoutBuf, stdoutDecoder.end(), 'stdout'),
            await boundedTail(stderrBuf, stderrDecoder.end(), 'stderr'),
        )
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
                const ledger = await readLedgerUsage(parsed.sessionId, {
                    resume: request.resume_session !== null,
                    cursor: ledgerCursor,
                })
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

        if (cancelRequested) {
            const note = `cancel requested by user; endpoint tree killed (exit_code=${exitCode ?? 'null'})`
            const cancelNotes = [note, ...parsed.warnings, ...usageNotes]
            await store.appendEvent(runId, redactor.redactJson({
                ts: now(), type: 'terminal', state: 'cancelled', exit_code: exitCode, signal, notes: cancelNotes,
            }) as RunEvent)
            return finalizeCancelled(store, runId, request.endpoint, request.model, exitCode, note, redactor, {
                final_text: parsed.finalText,
                evidence: {
                    deliverables,
                    refusals,
                    parser: { type: manifest.parser, degraded: parsed.degraded },
                    notes: cancelNotes,
                },
                usage: usage ?? { input_tokens: null, output_tokens: null, cached_input_tokens: null, cost: null, source: 'unavailable' },
                session_handle: parsed.sessionId,
            })
        }

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
        if (runTimedOut) {
            // the wall-clock cap outranks whatever the process happened to report
            judgment.state = 'failed'
            judgment.notes.unshift(`run timeout after ${runTimeoutSec}s`)
        }
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
            usage: usage ?? { input_tokens: null, output_tokens: null, cached_input_tokens: null, cost: null, source: 'unavailable' },
            session_handle: parsed.sessionId,
        }, redactor)
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

/**
 * Terminal state is always 'cancelled'. When the endpoint had already produced
 * output (a cancel that raced a successful completion), `settled` carries the
 * parsed evidence through to result.json; the default is the pre-spawn shape.
 */
async function finalizeCancelled(
    store: RunStore,
    runId: string,
    endpoint: string,
    model: string | null,
    exitCode: number | null,
    note: string,
    redactor: ReturnType<typeof createRedactor>,
    settled: Omit<TerminalWrite, 'state' | 'exit_code'> = {
        final_text: '',
        evidence: {
            deliverables: [],
            refusals: [],
            parser: { type: 'none', degraded: false },
            notes: [note],
        },
        usage: { input_tokens: null, output_tokens: null, cached_input_tokens: null, cost: null, source: 'unavailable' },
        session_handle: null,
    },
): Promise<number> {
    await finalize(store, runId, endpoint, model, {
        state: 'cancelled',
        exit_code: exitCode,
        ...settled,
    }, redactor)
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

/** result.json once, state transition, usage row — redacted before hitting disk. State and usage derive from the WINNING result record: when the CLI's cancel fallback settled result.json first, this side adopts it instead of writing its own state over it (codex F2). */
async function finalize(
    store: RunStore,
    runId: string,
    endpoint: string,
    model: string | null,
    write: TerminalWrite,
    redactor: ReturnType<typeof createRedactor>,
): Promise<void> {
    const draft = redactor.redactJson({
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
    let winner = draft
    let own = true
    try {
        ;({ winner, own } = await store.settleResult(draft))
    } catch (err) {
        await store.appendEvent(runId, {
            ts: now(), type: 'worker-error', note: `settleResult failed: ${err instanceof Error ? err.message : String(err)}`,
        })
    }
    if (!own) {
        await store.appendEvent(runId, {
            ts: now(), type: 'note', note: `result.json already settled as ${winner.state}; adopting it (this side drafted ${write.state})`,
        })
    }
    const current = await store.readState(runId)
    if (current && !isTerminal(current.state)) {
        try {
            await store.writeState(transitionRecord(current, winner.state, winner.terminal_at))
        } catch (err) {
            await store.appendEvent(runId, {
                ts: now(), type: 'worker-error', note: `state transition to ${winner.state} failed: ${err instanceof Error ? err.message : String(err)}`,
            })
        }
    }
    if (own) {
        // usage is this side's own settlement; a losing drafter must not bill its numbers
        try {
            const db = new UsageDb(nodePath.join(store.dataDir, 'usage.db'))
            db.record({
                run_id: runId,
                endpoint,
                connection: model && model.includes('/') ? model.split('/')[0] ?? null : null,
                model,
                input_tokens: winner.usage.input_tokens,
                cached_input_tokens: winner.usage.cached_input_tokens,
                output_tokens: winner.usage.output_tokens,
                cost: winner.usage.cost,
                source: winner.usage.source,
                recorded_at: winner.terminal_at,
            })
            db.close()
        } catch {
            await store.appendEvent(runId, { ts: now(), type: 'worker-error', note: 'usage.db write failed' }).catch(() => {})
        }
    }
}

async function pipeTo(
    stream: NodeJS.ReadableStream | null,
    onData: (chunk: Uint8Array) => Promise<unknown>,
): Promise<void> {
    if (!stream) return
    const rs = stream as import('node:stream').Readable
    return new Promise((resolve) => {
        // serialize onData through a promise chain and resolve only after it
        // drains: firing onData un-awaited lets slow event writes (e.g. a 100ms
        // appendEvent) interleave buffer mutations and lets 'end' resolve
        // while tail lines are still suspended behind them
        let chain: Promise<unknown> = Promise.resolve()
        const done = () => void chain.then(() => resolve(), () => resolve())
        if (rs.readableEnded || rs.destroyed) {
            done()
            return
        }
        rs.on('data', (chunk: Uint8Array) => {
            chain = chain.then(() => onData(chunk)).catch(() => {})
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
