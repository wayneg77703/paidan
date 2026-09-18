// Optional installation wizard. Inspection and delegation do not depend on it.
import * as fs from 'node:fs/promises'
import * as nodePath from 'node:path'
import * as os from 'node:os'
import { existsSync } from 'node:fs'
import { parseArgs } from 'node:util'
import * as readline from 'node:readline/promises'
import type { PaidanConfig } from '../engine/config.js'
import { PaidanError } from '../engine/errors.js'
import { defaultInitAnswers, buildInitConfig, mergeInitConfig, parseMultiSelect, planEndpointDefaultQuestions, type InitAnswers, type InitEndpointInfo } from '../engine/init-plan.js'
import { detectHosts, installSkill, loadHostRegistry, selectSkillHosts, type HostInfo, type SkillInstallResult } from '../engine/skill-install.js'
import { ModelsCache, type CachedModels } from '../engine/models-cache.js'
import { writeJsonAtomic } from '../engine/run-store.js'
import type { NativeDefaults } from '../endpoints/parser-api.js'
import { planEndpointSpawn } from '../endpoints/spawn.js'
import { detectVersion, readEndpointNativeDefaults, discoverAndCacheModels } from '../endpoints/inspection.js'
import { checkboxSelect, menuSelect, PromptAbort, rawSelectSupported } from '../tty-select.js'
import { emitOk, pkgRoot, type Ctx } from './context.js'

/** Host-skill detection for the wizard; a missing registry degrades to "no hosts" with a note. */
async function gatherHostInfo(): Promise<{ hosts: HostInfo[]; source: string | null }> {
    try {
        const registry = await loadHostRegistry(pkgRoot)
        // PAIDAN_HOST_HOME is a test hook (keeps tests off real agent homes); production = os.homedir()
        const home = process.env.PAIDAN_HOST_HOME || os.homedir()
        return { hosts: await detectHosts(registry, home), source: nodePath.join(pkgRoot, registry.skill.source) }
    } catch {
        return { hosts: [], source: null }
    }
}

/** Detection + model discovery for every manifest. Discovery entries are collected in memory only (persist:false) — an aborted or surveyed init writes nothing; the caller persists after committing answers (codex P1-04). */
async function gatherEndpointInfo(ctx: Ctx): Promise<{ info: InitEndpointInfo[]; pendingCache: CachedModels[]; cache: ModelsCache }> {
    const cache = new ModelsCache(ctx.dataDir)
    const out: InitEndpointInfo[] = []
    const pendingCache: CachedModels[] = []
    for (const manifest of ctx.registry.list()) {
        const configBin = ctx.config.endpoints.overrides[manifest.name]?.bin ?? null
        const spawnRes = await planEndpointSpawn(manifest, { configBin })
        const detected = spawnRes.plan !== null
        const version = spawnRes.plan ? await detectVersion(manifest, spawnRes.plan) : null
        let models: InitEndpointInfo['models'] = []
        let discoveredNative: NativeDefaults | undefined
        try {
            const entry = await discoverAndCacheModels(manifest, cache, version, configBin, { persist: false, providerConfig: ctx.config.endpoints.overrides[manifest.name]?.provider_config })
            if (entry) {
                models = entry.models
                discoveredNative = entry.native_defaults
                pendingCache.push(entry)
            }
        } catch {
            // discovery is best-effort during init; notes stay with the cache
        }
        out.push({
            name: manifest.name,
            detected,
            version,
            models,
            model_selectable: manifest.command.model_arg !== undefined,
            effort_options: manifest.effort?.options ?? null,
            native: discoveredNative ?? await readEndpointNativeDefaults(manifest, configBin, ctx.config.endpoints.overrides[manifest.name]?.provider_config),
            repair: detected ? null : (spawnRes.notes.at(-1) ?? null),
        })
    }
    return { info: out, pendingCache, cache }
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
    const { info, pendingCache, cache } = await gatherEndpointInfo(ctx)
    const hostInfo = await gatherHostInfo()
    if (hostsFilter !== null) {
        const detectedNames = new Set(hostInfo.hosts.filter((h) => h.detected).map((h) => h.name))
        const unknown = hostsFilter.filter((h) => !detectedNames.has(h))
        if (unknown.length > 0) {
            throw new PaidanError('ARGS_INVALID', `--hosts names not detected on this machine: ${unknown.join(', ')} (detected: ${[...detectedNames].join(', ') || 'none'})`)
        }
    }

    if (!process.stdin.isTTY && !values.yes) {
        // non-TTY callers (pipes, agents) get state + guidance, never a hanging
        // prompt; the survey itself wrote nothing (model caches persist only
        // after a completed init)
        process.stdout.write(JSON.stringify({
            ok: false,
            error: { code: 'INIT_INTERACTIVE_REQUIRED', message: 'init is interactive on a TTY; use --yes for defaults or edit config.json directly' },
            state: {
                config_path: ctx.configPath,
                config_exists: existsSync(ctx.configPath),
                endpoints: info,
                hosts: hostInfo.hosts.map((h) => ({ name: h.name, detected: h.detected, skills_dir: h.skills_dir })),
                non_interactive: 'paidan init --yes enables all detected endpoints and leaves every model/effort at the endpoint\'s native default (the agent\'s own home carries them; --yes --effort <level> additionally applies that level to every endpoint whose options include it; --hosts <names> restricts the skill install to those hosts); the skill is installed into every detected host unless --hosts narrows it',
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
                    const manifest = ctx.registry.get(ep.name)
                    const spawnRes = await planEndpointSpawn(manifest, { configBin: answer })
                    if (!spawnRes.plan) {
                        process.stderr.write(`  ${ep.name}: that path did not resolve either (${spawnRes.notes.at(-1) ?? 'no plan'}); not recorded\n`)
                        continue
                    }
                    recordedOverrides[ep.name] = answer
                    ep.detected = true
                    ep.version = await detectVersion(manifest, spawnRes.plan)
                    ep.repair = null
                    try {
                        const entry = await discoverAndCacheModels(manifest, cache, ep.version, answer, { persist: false, providerConfig: ctx.config.endpoints.overrides[manifest.name]?.provider_config })
                        if (entry) {
                            ep.models = entry.models
                            pendingCache.push(entry)
                        }
                    } catch {
                        // best-effort; the endpoint still enablable without a model menu
                    }
                    process.stderr.write(`  ${ep.name}: resolved via override (${spawnRes.plan.resolved_from}); it can now be enabled\n`)
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
    const cfg = buildInitConfig(info, answers, ctx.config)
    const selectedHosts = selectSkillHosts(hostInfo.hosts, answers.skill_hosts)

    if (existsSync(ctx.configPath)) {
        // one cheap insurance copy before overwrite
        await fs.copyFile(ctx.configPath, `${ctx.configPath}.bak-${Date.now()}`)
    }
    // re-init merges: the wizard owns endpoints.enabled + the wizard-owned
    // defaults keys (endpoint/model/models/effort/efforts); machine-local keys
    // it does not own (endpoints.overrides, dataDir, defaults.run_timeout_sec,
    // ...) survive. The global model/effort fallbacks are deliberately cleared:
    // they poison endpoints without that selection surface and a surviving
    // global silently overrides a "native" wizard choice.
    let existingRaw: Record<string, unknown> = {}
    if (existsSync(ctx.configPath)) {
        existingRaw = JSON.parse(await fs.readFile(ctx.configPath, 'utf8')) as Record<string, unknown>
    }
    const merged = mergeInitConfig(existingRaw, cfg)
    // in-wizard bin overrides land in endpoints.overrides (machine config paidan
    // owns; other endpoints' overrides and all machine keys are untouched)
    if (Object.keys(recordedOverrides).length > 0) {
        const endpoints = { ...((merged.endpoints ?? {}) as Record<string, unknown>) }
        endpoints.overrides = { ...((endpoints.overrides ?? {}) as Record<string, unknown>) }
        for (const [name, bin] of Object.entries(recordedOverrides)) {
            ;(endpoints.overrides as Record<string, { bin: string }>)[name] = { bin }
        }
        merged.endpoints = endpoints
    }
    await writeJsonAtomic(ctx.configPath, merged)
    // the survey's model caches persist only now — an aborted or surveyed
    // (non-TTY) init wrote nothing at all (codex P1-04)
    for (const entry of pendingCache) await cache.write(entry).catch(() => {})

    const skills: SkillInstallResult[] = []
    if (selectedHosts.length > 0 && hostInfo.source) {
        for (const host of selectedHosts) {
            try {
                const hostSource = host.source ? nodePath.join(pkgRoot, host.source) : hostInfo.source
                skills.push(await installSkill(host, hostSource))
            } catch (err) {
                // one failing host must not sink the rest; the envelope reports it
                skills.push({
                    host: host.name,
                    path: host.target,
                    status: 'error',
                    error: err instanceof Error ? err.message : String(err),
                })
            }
        }
    }
    const effortReport = values.effort !== undefined
        ? {
            // --effort preference report: where it landed and where it could not
            effort_preference: values.effort,
            effort_applied_to: Object.keys(cfg.defaults.efforts),
            effort_skipped: info
                .filter((e) => e.detected && e.effort_options && !e.effort_options.includes(values.effort as string))
                .map((e) => `${e.name} (top option: ${(e.effort_options ?? []).at(-1) ?? '?'})`),
        }
        : {}
    emitOk({
        config_path: ctx.configPath,
        written: true,
        enabled: answers.enabled,
        defaults: cfg.defaults,
        // what actually applies after the merge — machine keys and the cleared
        // global fallbacks are visible here, not just the wizard's own answers
        effective_defaults: (merged.defaults ?? {}) as Record<string, unknown>,
        endpoints: info.map((e) => ({ name: e.name, detected: e.detected, version: e.version, models: e.models.length })),
        ...effortReport,
        skills,
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
