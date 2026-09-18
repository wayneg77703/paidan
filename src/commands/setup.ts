// CLI envelope only; installation discovery, planning and persistence are shared with init.
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { parseArgs } from 'node:util'
import { PaidanError } from '../engine/errors.js'
import { parseChoices, surveyInstallation, installationHosts, choicesTemplate, planInstallation, applyInstallation } from '../installation.js'
import { emitOk, type Ctx } from './context.js'

export async function verbSetup(ctx: Ctx, args: string[]) {
    const { values } = parseArgs({ args, strict: true, options: {
        endpoint: { type: 'string', multiple: true }, bin: { type: 'string' }, location: { type: 'string', multiple: true }, cwd: { type: 'string' },
        choices: { type: 'string' }, apply: { type: 'boolean' }, expect: { type: 'string' },
    } })
    if (values.choices && (values.endpoint || values.bin || values.location)
        || (values.bin || values.location) && values.endpoint?.length !== 1) throw new PaidanError('ARGS_INVALID', 'choices 与 endpoint/bin/location 分开使用；bin/location 只用于单个端点。')
    if (values.apply && (!values.choices || !values.expect)) throw new PaidanError('ARGS_INVALID', '先用 setup --choices 预览；用户确认后加 --apply --expect <返回的 confirmation>。')
    const cwd = path.resolve(values.cwd ?? process.cwd())
    if (!values.choices) {
        if (!values.endpoint?.length) throw new PaidanError('ARGS_INVALID', 'setup 需要 --endpoint <所选端点>（可重复）或 --choices <文件>。')
        const choices = parseChoices({ endpoints: Object.fromEntries(values.endpoint.map(name => [name, { bin: values.bin, locations: values.location }])) }, ctx)
        const endpoints = await Promise.all(Object.entries(choices.endpoints).map(([name, c]) => surveyInstallation(ctx, name, c, cwd)))
        emitOk({ config_path: ctx.configPath, endpoints, hosts: (await installationHosts()).hosts, choices: choicesTemplate(ctx, endpoints),
            guidance: '只处理所选端点；可以提供安装目录或程序路径作为 location 线索。多候选由用户选，不默认运行 probe。' })
        return
    }
    let raw: unknown
    try { raw = JSON.parse(await fs.readFile(values.choices, 'utf8')) }
    catch { throw new PaidanError('SETUP_INVALID', 'choices 文件无法读取或不是 JSON。') }
    const plan = await planInstallation(ctx, parseChoices(raw, ctx), cwd)
    emitOk(values.apply ? await applyInstallation(plan, values.expect!) : { applied: false, ...plan.preview })
}
