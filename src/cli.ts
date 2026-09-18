#!/usr/bin/env node
// CLI entry: route commands and render JSON errors; workflows live in commands/.
import * as fs from 'node:fs/promises'
import * as nodePath from 'node:path'
import { PaidanError } from './engine/errors.js'
import { reconcileRuns } from './engine/reconcile.js'
import { emitOk, emitError, makeCtx, pkgRoot } from './commands/context.js'
import { verbRun, verbGet, verbCancel, verbList } from './commands/run.js'
import { verbModels, verbDoctor } from './commands/inspect.js'
import { verbProbe } from './commands/probe.js'
import { verbInit } from './commands/init.js'
import { verbSetup } from './commands/setup.js'

// ---------- entry ----------

/** Per-verb flag reference for `paidan help <verb>` (human text on stderr; stdout stays JSON). */
const VERB_HELP: Record<string, string> = {
    setup: 'setup --endpoint <name>... [--bin <absolute-path> | --location <directory-or-file>...] [--cwd <task-directory>]\n' +
        '  list all installation candidates and current provider/model/effort menus; returns a choices template\n' +
        'setup --choices <json-file> [--cwd <task-directory>] [--apply --expect <confirmation>]\n' +
        '  preview selected changes, then apply after user confirmation; no model tasks or init wizard',
    init: 'init [--yes] [--effort <level>] [--hosts <name,name>]\n' +
        '  optional shortcut; recommended setup: give an agent the repository INSTALL.md\n' +
        '  shares setup discovery/writer; ambiguous installations require explicit entry selection\n' +
        '  interactive wizard on a TTY; --yes adds detected endpoints and preserves existing defaults,\n' +
        '  new endpoints follow native defaults; skill into every detected host;\n' +
        '  --yes --effort <level> applies that level where declared; --yes --hosts <names>\n' +
        '  restricts the skill install to those hosts',
    run: 'run --endpoint <name> --cwd <abs> (--task <text> | --task-file <file>)\n' +
        '  [--mode read-only|workspace-write|unattended | --capabilities <json>] [--model <alias>]\n' +
        '  mode defaults: per-endpoint config defaults.modes, then endpoint preset (ZCode unattended; others workspace-write)\n' +
        '  [--effort <level>] [--native] [--selection-context <context>] [--resume <session_handle>] [--add-dir <path>]... [--deliverable <rel>]...\n' +
        '  [--run-timeout <sec>] (0 disables; default 1800 or defaults.run_timeout_sec)',
    get: 'get <run_id> [--wait] [--timeout <sec>]\n' +
        '  --wait blocks until terminal/attention or --timeout; attention returns immediately',
    cancel: 'cancel <run_id>   (explicit only; no-op on terminal runs)',
    list: 'list [--state completed,failed,cancelled,unknown,attention] [--limit N]',
    models: 'models --endpoint <name> [--refresh] [--native] [--cwd <path>]   (queries current candidates every time; --refresh is optional)',
    doctor: 'doctor [--endpoint <name>]...   (inspect selected endpoints, or all when omitted; includes config/host diagnostics)',
    probe: 'probe --endpoint <name> [--timeout <sec>]\n' +
        '  P1 write / P2 read-only refusal / P3 resume contract probes; real agent calls',
}

async function main(): Promise<number> {
    const [verb, ...rest] = process.argv.slice(2)
    if (verb === '--version' || verb === '-v' || verb === 'version') {
        const pkg = JSON.parse(await fs.readFile(nodePath.join(pkgRoot, 'package.json'), 'utf8')) as { version: string }
        emitOk({ version: pkg.version, node: process.version })
        return 0
    }
    if (!verb || verb === 'help' || verb === '--help' || verb === '-h') {
        const topic = rest[0]
        if (topic && VERB_HELP[topic]) {
            process.stderr.write(`paidan ${topic} — flags:\n  ${VERB_HELP[topic].replaceAll('\n', '\n  ')}\n`)
            emitOk({ verb: topic, flags: VERB_HELP[topic] })
            return 0
        }
        if (topic) {
            process.stderr.write(`unknown verb "${topic}"; paidan verbs: ${Object.keys(VERB_HELP).join(' | ')}\n`)
            return 1
        }
        process.stderr.write(
            `paidan ${await fs.readFile(nodePath.join(pkgRoot, 'package.json'), 'utf8').then((s) => (JSON.parse(s) as { version: string }).version).catch(() => '')} — verbs: ${Object.keys(VERB_HELP).join(' | ')}\n` +
            'help <verb> shows per-verb flags; --version prints JSON. All other stdout is a single JSON envelope.\n',
        )
        return verb ? 0 : 1
    }
    // `<verb> --help/-h` short-circuits before strict parseArgs rejects it
    if (rest.includes('--help') || rest.includes('-h')) {
        if (!VERB_HELP[verb]) throw new PaidanError('ARGS_INVALID', `unknown verb "${verb}"`)
        process.stderr.write(`paidan ${verb} — flags:\n  ${(VERB_HELP[verb] ?? 'no help for this verb').replaceAll('\n', '\n  ')}\n`)
        emitOk({ verb, flags: VERB_HELP[verb] ?? null })
        return 0
    }
    const ctx = await makeCtx()
    if (verb === 'setup') { await verbSetup(ctx, rest); return 0 }
    if (verb === 'init') return await verbInit(ctx, rest)
    // startup reconcile: mark dead-worker runs attention; never restarts anything
    await reconcileRuns(ctx.store).catch(() => {})
    switch (verb) {
        case 'run':
            await verbRun(ctx, rest)
            return 0
        case 'get':
            await verbGet(ctx, rest)
            return 0
        case 'cancel':
            await verbCancel(ctx, rest)
            return 0
        case 'list':
            await verbList(ctx, rest)
            return 0
        case 'models':
            await verbModels(ctx, rest)
            return 0
        case 'doctor':
            await verbDoctor(ctx, rest)
            return 0
        case 'probe':
            await verbProbe(ctx, rest)
            return 0
        default:
            throw new PaidanError('ARGS_INVALID', `unknown verb "${verb}"`)
    }
}

main()
    .then((code) => {
        process.exitCode = code
    })
    .catch((err) => {
        process.exitCode = emitError(err)
    })
