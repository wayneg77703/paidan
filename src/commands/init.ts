// Optional installation wizard. Inspection and delegation do not depend on it.
import * as fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { parseArgs } from 'node:util'
import * as readline from 'node:readline/promises'
import type { PaidanConfig } from '../engine/config.js'
import { PaidanError } from '../engine/errors.js'
import { defaultInitAnswers, parseMultiSelect, planEndpointDefaultQuestions, type InitAnswers, type InitEndpointInfo } from '../engine/init-plan.js'
import type { HostInfo } from '../engine/skill-install.js'
import { surveyInstallation, installationHosts, planInstallation, applyInstallation, type Choices } from '../installation.js'
import { checkboxSelect, menuSelect, PromptAbort, rawSelectSupported } from '../tty-select.js'
import { emitOk, type Ctx } from './context.js'

async function gatherEndpointInfo(ctx: Ctx) {
    const surveyed = await Promise.all(ctx.registry.list().map(m => surveyInstallation(ctx, m.name, {}, process.cwd())))
    const info: InitEndpointInfo[] = surveyed.map(e => {
        const m = ctx.registry.get(e.name)
        return { name: e.name, detected: !!e.selected_bin && !e.version_error, bin: e.selected_bin, version: e.candidates.find(c => c.bin === e.selected_bin)?.version ?? null,
            models: e.models.map(v => ({ alias: v.alias, connection: v.connection ?? null })), model_selectable: !!m.command.model_arg,
            effort_options: m.effort?.options ?? null, native: e.native_defaults,
            repair: e.selection_required ? 'Use setup to choose an installation or supply its exact entry path.' : e.version_error ?? e.error }
    })
    return { info, surveyed }
}

export async function verbInit(ctx: Ctx, args: string[]): Promise<number> {
    const { values } = parseArgs({
        args,
        strict: true,
        options: {
            yes: { type: 'boolean', default: false },
            effort: { type: 'string' },
            hosts: { type: 'string' },
        },
    })
    const hostsFilter = values.hosts !== undefined
        ? values.hosts.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
        : null
    if (hostsFilter !== null && !values.yes) {
        throw new PaidanError('ARGS_INVALID', '--hosts applies to the --yes path (the interactive wizard picks hosts with checkboxes)')
    }
    const { info, surveyed } = await gatherEndpointInfo(ctx)
    const hostInfo = await installationHosts()
    if (hostsFilter !== null) {
        const detectedNames = new Set(hostInfo.hosts.filter((h) => h.detected).map((h) => h.name))
        const unknown = hostsFilter.filter((h) => !detectedNames.has(h))
        if (unknown.length > 0) {
            throw new PaidanError('ARGS_INVALID', `--hosts names not detected on this machine: ${unknown.join(', ')} (detected: ${[...detectedNames].join(', ') || 'none'})`)
        }
    }

    if (!process.stdin.isTTY && !values.yes) {
        // non-TTY callers (pipes, agents) get state + guidance, never a hanging
        // prompt; the shared survey writes no configuration or model caches.
        process.stdout.write(JSON.stringify({
            ok: false,
            error: { code: 'INIT_INTERACTIVE_REQUIRED', message: 'init is interactive on a TTY; use setup for scoped configuration or --yes to add detected endpoints' },
            state: {
                config_path: ctx.configPath,
                config_exists: existsSync(ctx.configPath),
                endpoints: info,
                hosts: hostInfo.hosts.map((h) => ({ name: h.name, detected: h.detected, skills_dir: h.skills_dir })),
                non_interactive: 'paidan init --yes adds uniquely detected endpoints, preserving existing choices; use setup for targeted maintenance. --hosts restricts host skills.',
            },
        }) + '\n')
        return 1
    }

    let answers: InitAnswers
    const recordedOverrides: Record<string, string> = {}
    if (values.yes) {
        answers = defaultInitAnswers(info, hostInfo.hosts.filter((h) => h.detected).map((h) => h.name), values.effort, hostsFilter)
    } else {
        // bin-override intake for undetected endpoints: turns "not detected ->
        // hand-edit JSON -> re-run" into one in-wizard step (the recorded path
        // is paidan's own config — credentials are never asked for or touched)
        if (info.some((e) => !e.detected)) {
            const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
            try {
                for (const ep of info.filter((e) => !e.detected)) {
                    const answer = (await rl.question(`bin path for "${ep.name}" (paidan writes it to endpoints.overrides; empty = skip): `)).trim().replace(/^"|"$/g, '')
                    if (answer.length === 0) continue
                    const found = await surveyInstallation(ctx, ep.name, { bin: answer }, process.cwd())
                    if (!found.selected_bin || found.version_error) {
                        process.stderr.write(`  ${ep.name}: ${found.version_error ?? `no unique usable entry; use setup --endpoint ${ep.name} --location <directory>`}\n`)
                        continue
                    }
                    recordedOverrides[ep.name] = found.selected_bin
                    surveyed[surveyed.findIndex(e => e.name === ep.name)] = found
                    ep.bin = found.selected_bin
                    ep.detected = true
                    ep.version = found.candidates.find(c => c.bin === found.selected_bin)?.version ?? null
                    ep.models = found.models.map(m => ({ alias: m.alias, connection: m.connection ?? null }))
                    ep.native = found.native_defaults
                    ep.repair = null
                }
            } finally {
                rl.close()
            }
        }
        try {
            answers = await promptInitAnswers(info, hostInfo.hosts, ctx.config)
        } catch (err) {
            if (err instanceof PromptAbort) {
                process.stdout.write(
                    JSON.stringify({
                        ok: false,
                        error: {
                            code: 'INIT_ABORTED',
                            message: 'init aborted by user (Ctrl+C); config, skills and this survey\'s model caches were not written',
                        },
                    }) + '\n',
                )
                return 130
            }
            throw err
        }
    }
    const choices: Choices = { endpoints: {}, hosts: answers.skill_hosts }
    for (const name of answers.enabled) {
        const bin = recordedOverrides[name] ?? info.find(e => e.name === name)?.bin ?? undefined
        choices.endpoints[name] = { bin }
        if (!values.yes) {
            const model = answers.models?.[name] ?? null, effort = answers.efforts?.[name] ?? null
            // Keeping a saved choice does not silently refresh its route binding.
            if (model !== (ctx.config.defaults.models[name] ?? null) || effort !== (ctx.config.defaults.efforts[name] ?? null)) {
                Object.assign(choices.endpoints[name], { model, effort })
            }
        } else if (answers.efforts?.[name] != null) choices.endpoints[name].effort = answers.efforts[name]
    }
    if (!values.yes) {
        // Only deselected, detected endpoints were presented by this UI. Unavailable entries survive.
        for (const e of info) if (e.detected && !answers.enabled.includes(e.name)) choices.endpoints[e.name] = { enabled: false }
        choices.default_endpoint = answers.default_endpoint
    } else if (!ctx.config.defaults.endpoint) choices.default_endpoint = answers.default_endpoint
    const plan = await planInstallation(ctx, choices, process.cwd(), surveyed.filter(e => answers.enabled.includes(e.name)))
    const result = await applyInstallation(plan, plan.preview.confirmation)
    const effective = JSON.parse(await fs.readFile(ctx.configPath, 'utf8').catch(() => '{}')).defaults ?? {}
    emitOk({ ...result, config_path: ctx.configPath, written: true, enabled: answers.enabled,
        defaults: effective, effective_defaults: effective,
        skills: result.written.filter(f => f.kind === 'skill').map(f => ({ ...f, host: f.owner })),
    })
    return 0
}

async function promptInitAnswers(info: InitEndpointInfo[], hosts: HostInfo[], config: PaidanConfig): Promise<InitAnswers> {
    process.stderr.write('paidan init — detection complete. Human output is on stderr; stdout stays JSON.\n\n')
    if (rawSelectSupported()) return promptInitRaw(info, hosts, config)
    return promptInitLine(info, hosts, config)
}

/** Raw-mode wizard: checkbox multi-selects (space toggles, enter confirms) and arrow-key menus. */
async function promptInitRaw(info: InitEndpointInfo[], hosts: HostInfo[], config: PaidanConfig): Promise<InitAnswers> {
    const detectedEps = info.filter((e) => e.detected)
    for (const ep of info) {
        if (!ep.detected) {
            process.stderr.write(`  ${ep.name}  NOT detected — skipped${ep.repair ? `. Repair: ${ep.repair}` : ''}\n`)
        }
    }
    let enabled: string[] = []
    if (detectedEps.length > 0) {
        // re-init starts from the current selection, fresh installs from "all"
        const preEnabled = config.endpoints.enabled
        const picked = await checkboxSelect(
            'Enable endpoints',
            detectedEps.map((ep) => ({
                label: `${ep.name}  ${ep.version ?? 'unknown version'}`,
                hint: ep.models.length > 0 ? `${ep.models.length} models` : undefined,
                checked: preEnabled ? preEnabled.includes(ep.name) : true,
            })),
        )
        enabled = picked.map((i) => (detectedEps[i] as InitEndpointInfo).name)
    }
    let defaultEndpoint: string | null = null
    const models: Record<string, string | null> = {}
    const efforts: Record<string, string | null> = {}
    if (enabled.length > 0) {
        defaultEndpoint = enabled[await menuSelect('Default endpoint', enabled.map((name) => ({ label: name })), enabled.indexOf(config.defaults.endpoint ?? ''))] as string
        // every enabled endpoint gets its own default model and effort — the
        // decision plan is shared (init-plan), this shell only renders it
        for (const name of enabled) {
            const epInfo = info.find((e) => e.name === name) as InitEndpointInfo
            const q = planEndpointDefaultQuestions(epInfo, config)
            if (q.model.kind === 'skip-no-selection') {
                process.stderr.write(`(no headless model selection for ${name}; its native config owns the model${q.nativeModel ? ` (currently ${q.nativeModel})` : ''})\n`)
            } else if (q.model.kind === 'skip-none') {
                process.stderr.write(`(no discovered models for ${name} and no configured default; native default will be used)\n`)
            } else {
                if (q.model.staleModelValue) {
                    process.stderr.write(`(configured model "${q.model.staleModelValue}" for ${name} is not in the discovered lineup; keep it explicitly or pick another)\n`)
                }
                const idx = await menuSelect(
                    `Default model for ${name}`,
                    q.model.options.map((alias) => ({
                        label: alias,
                        hint: epInfo.models.find((m) => m.alias === alias)?.connection ?? undefined,
                    })),
                    q.model.options.indexOf(q.model.fallback),
                )
                const choice = q.model.options[idx] as string
                if (choice === q.nativeModelLabel) models[name] = null
                else if (q.model.staleModelValue && choice === `(keep current: ${q.model.staleModelValue})`) models[name] = q.model.staleModelValue
                else models[name] = choice
            }
            if (q.effort.kind === 'skip') {
                process.stderr.write(`(no effort selection for ${name}; ${q.nativeEffortNote})\n`)
            } else {
                if (q.effort.staleValue) {
                    process.stderr.write(`(configured effort "${q.effort.staleValue}" for ${name} is no longer in its options; it will be replaced unless you pick one)\n`)
                }
                const idx = await menuSelect(
                    `Default effort for ${name}`,
                    q.effort.options.map((o) => ({ label: o })),
                    q.effort.options.indexOf(q.effort.fallback),
                )
                const choice = q.effort.options[idx] as string
                if (choice !== q.nativeEffortLabel) efforts[name] = choice
            }
        }
    }
    const skillHosts: string[] = []
    const detectedHosts = hosts.filter((h) => h.detected)
    if (detectedHosts.length > 0) {
        const picked = await checkboxSelect(
            'Install skill into hosts',
            detectedHosts.map((h) => ({
                label: h.name,
                hint: `${h.skills_dir}${h.installed ? ' — already installed' : ''}`,
                // preselect what is actually installed; a newly detected host is
                // opt-in (explicit selection, never a silent write to a new home)
                checked: h.installed,
            })),
        )
        skillHosts.push(...picked.map((i) => (detectedHosts[i] as HostInfo).name))
    }
    return { enabled, default_endpoint: defaultEndpoint, models, efforts, skill_hosts: skillHosts }
}

/** Line-based fallback for when stderr is not a TTY (raw-mode widgets need it). */
async function promptInitLine(info: InitEndpointInfo[], hosts: HostInfo[], config: PaidanConfig): Promise<InitAnswers> {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
    try {
        process.stderr.write('Endpoints:\n')
        const detectedEps: InitEndpointInfo[] = []
        for (const ep of info) {
            if (ep.detected) {
                detectedEps.push(ep)
                process.stderr.write(`  ${detectedEps.length}) ${ep.name}  detected ${ep.version ?? 'unknown version'}${ep.models.length > 0 ? ` (${ep.models.length} models)` : ''}\n`)
            } else {
                process.stderr.write(`     ${ep.name}  NOT detected — skipped${ep.repair ? `. Repair: ${ep.repair}` : ''}\n`)
            }
        }
        let enabled: string[] = []
        if (detectedEps.length > 0) {
            const preEnabled = config.endpoints.enabled
            const fallback = preEnabled
                ? detectedEps.map((_, i) => i).filter((i) => preEnabled.includes((detectedEps[i] as InitEndpointInfo).name))
                : detectedEps.map((_, i) => i)
            const picked = await pickMulti(rl, 'Enable endpoints', detectedEps.length, fallback)
            enabled = picked.map((i) => (detectedEps[i] as InitEndpointInfo).name)
        }
        let defaultEndpoint: string | null = null
        const models: Record<string, string | null> = {}
        const efforts: Record<string, string | null> = {}
        if (enabled.length > 0) {
            const preDefault = config.defaults.endpoint && enabled.includes(config.defaults.endpoint) ? config.defaults.endpoint : (enabled[0] as string)
            defaultEndpoint = await pickOne(rl, 'Default endpoint', enabled, preDefault)
            // every enabled endpoint gets its own default model and effort — the
            // decision plan is shared (init-plan), this shell only renders it
            for (const name of enabled) {
                const epInfo = info.find((e) => e.name === name) as InitEndpointInfo
                const q = planEndpointDefaultQuestions(epInfo, config)
                if (q.model.kind === 'skip-no-selection') {
                    process.stderr.write(`(no headless model selection for ${name}; its native config owns the model${q.nativeModel ? ` (currently ${q.nativeModel})` : ''})\n`)
                } else if (q.model.kind === 'skip-none') {
                    process.stderr.write(`(no discovered models for ${name} and no configured default; native default will be used)\n`)
                } else {
                    if (q.model.staleModelValue) {
                        process.stderr.write(`(configured model "${q.model.staleModelValue}" for ${name} is not in the discovered lineup; keep it explicitly or pick another)\n`)
                    }
                    const choice = await pickOne(rl, `Default model for ${name}`, q.model.options, q.model.fallback)
                    if (choice === q.nativeModelLabel) models[name] = null
                    else if (q.model.staleModelValue && choice === `(keep current: ${q.model.staleModelValue})`) models[name] = q.model.staleModelValue
                    else models[name] = choice
                }
                if (q.effort.kind === 'skip') {
                    process.stderr.write(`(no effort selection for ${name}; ${q.nativeEffortNote})\n`)
                } else {
                    if (q.effort.staleValue) {
                        process.stderr.write(`(configured effort "${q.effort.staleValue}" for ${name} is no longer in its options; it will be replaced unless you pick one)\n`)
                    }
                    const choice = await pickOne(rl, `Default effort for ${name}`, q.effort.options, q.effort.fallback)
                    if (choice !== q.nativeEffortLabel) efforts[name] = choice
                }
            }
        }
        const skillHosts: string[] = []
        const detectedHosts = hosts.filter((h) => h.detected)
        if (detectedHosts.length > 0) {
            process.stderr.write('\nHosts for the paidan skill (copied into each selected host):\n')
            detectedHosts.forEach((h, i) => {
                process.stderr.write(`  ${i + 1}) ${h.name} (${h.skills_dir}${h.installed ? ' — already installed' : ''})\n`)
            })
            const picked = await pickMulti(rl, 'Install skill into hosts', detectedHosts.length,
                // default keeps installed hosts only; newly detected hosts are opt-in
                detectedHosts.map((h, i) => (h.installed ? i : -1)).filter((i) => i >= 0))
            skillHosts.push(...picked.map((i) => (detectedHosts[i] as HostInfo).name))
        }
        return { enabled, default_endpoint: defaultEndpoint, models, efforts, skill_hosts: skillHosts }
    } finally {
        rl.close()
    }
}

/** Multi-select prompt: one question, space/comma-separated numbers; empty = fallback (default: all). */
async function pickMulti(rl: readline.Interface, title: string, count: number, fallback?: number[]): Promise<number[]> {
    const all = Array.from({ length: count }, (_, i) => i)
    const fb = fallback ?? all
    for (;;) {
        const answer = await rl.question(`${title} [1-${count}, all, none] (default ${fb.length === count ? 'all' : fb.map((i) => i + 1).join(' ')}): `)
        try {
            return parseMultiSelect(answer, count, fb)
        } catch (err) {
            process.stderr.write(`${(err as Error).message}\n`)
        }
    }
}

async function pickOne(rl: readline.Interface, title: string, options: string[], fallback: string): Promise<string> {
    process.stderr.write(`${title}:\n`)
    options.forEach((opt, i) => process.stderr.write(`  ${i + 1}) ${opt}\n`))
    for (;;) {
        const answer = (await rl.question(`Choose [1-${options.length}] (default ${fallback}): `)).trim()
        if (answer === '') return fallback
        const n = Number(answer)
        if (Number.isInteger(n) && n >= 1 && n <= options.length) return options[n - 1] as string
        process.stderr.write('invalid choice\n')
    }
}
