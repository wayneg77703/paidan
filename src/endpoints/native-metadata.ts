// Shared mechanics for read-only native queries and metadata-only selection checks.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { EndpointRegistry } from './registry.js'
import { buildEnv } from './invocation.js'
import { planEndpointSpawn, finalSpawnArgs, needsVerbatimArgs } from './spawn.js'
import { PaidanError } from '../engine/errors.js'
import type { DiscoverModelsResult, NativeDefaults } from './parser-api.js'

export interface NativeQueryOptions { configBin?: string | null; cwd?: string }

export async function queryNative(endpoint: string, args: string[], opts: NativeQueryOptions = {}): Promise<string> {
    const manifest = (await EndpointRegistry.load()).get(endpoint)
    const { plan } = await planEndpointSpawn(manifest, { configBin: opts.configBin ?? null })
    if (!plan) throw new PaidanError('MODELS_QUERY_FAILED', `${endpoint} 所选入口不可用，请检查已选安装路径。`)
    try {
        const { stdout } = await promisify(execFile)(plan.command, finalSpawnArgs(plan, args), {
            env: buildEnv(manifest), cwd: opts.cwd,
            timeout: args[0] === 'models' ? (endpoint === 'omp' ? 30_000 : 60_000) : 20_000,
            maxBuffer: 16 * 1024 * 1024,
            windowsHide: true, windowsVerbatimArguments: needsVerbatimArgs(plan),
        })
        return stdout
    } catch { throw new PaidanError('MODELS_QUERY_FAILED', `${endpoint} ${args.join(' ')} 查询失败；请检查所选 CLI、原生配置或网络。原始输出可能含凭据，已隐藏。`) }
}

export const record = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}
export const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value : null

export function jsonObject(raw: string, endpoint: string): Record<string, any> {
    try {
        const value: unknown = JSON.parse(raw)
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
        return value as Record<string, any>
    } catch { throw new PaidanError('MODELS_QUERY_FAILED', `${endpoint} 配置格式无法识别；未使用其他配置代替，原始内容已隐藏。`) }
}

export async function optionalFile(file: string): Promise<string | null> {
    try { return await fs.readFile(file, 'utf8') }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw new PaidanError('MODELS_QUERY_FAILED', '原生配置无法读取，请检查文件权限；未使用其他配置代替。')
    }
}

/** Callers pass an explicit metadata whitelist, never a full native configuration. */
export function selectionContext(metadata: unknown): string {
    const stable = (v: any): any => Array.isArray(v) ? v.map(stable)
        : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, stable(v[k])])) : v
    return 'sha256:' + createHash('sha256').update(JSON.stringify(stable(metadata))).digest('hex')
}

/** URLs affect routing, but embedded credentials and query strings are not selection metadata. */
export function routeIdentity(value: unknown): string | null {
    if (!text(value)) return null
    try { const u = new URL(value as string); return u.origin + u.pathname }
    catch { return 'unresolved-route' }
}

export function validateCatalogSelection(endpoint: string, selection: { model: string | null; effort: string | null }, current: DiscoverModelsResult): NativeDefaults {
    const native = current.native_defaults ?? {}
    const model = current.models.find(m => m.alias === (selection.model ?? native.model))
    const details = { requested: selection, native_defaults: native, query: `paidan models --endpoint ${endpoint}`, user_choice_required: true }
    if (!model) throw new PaidanError('MODEL_UNAVAILABLE', `${endpoint} 所选模型已不在当前目录，或原生默认模型尚不能确定。请展示当前组合让用户选择；不会自动换路。`, details)
    if (selection.effort !== null && (!model.effort_options || !model.effort_options.includes(selection.effort))) {
        throw new PaidanError('EFFORT_INVALID', `${endpoint} 此模型的强度选项为 ${model.effort_options?.join(', ') || '未声明'}。请选择目录中该模型的档位，或跟随原生强度。`, details)
    }
    return native
}
