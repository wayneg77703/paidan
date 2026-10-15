// Profile-owned metadata. Never boot DSH to inspect config: --dump-config rewrites
// the native root file. Read literal patch layers; unknown YAML stays unknown.
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { PaidanError } from '../engine/errors.js'
import { optionalFile } from './native-metadata.js'
import { inspectDshPatch, type DshModelFields } from './dsh-patch.js'
import type { DiscoverModelsResult, NativeDefaults } from './parser-api.js'

export function dshHomePath(): string { return process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh') }
export function dshSettingsPath(): string { return path.join(dshHomePath(), 'profiles', 'headless', 'cordis.patch.yml') }
export function dshHomePatchPath(): string { return path.join(dshHomePath(), 'cordis.patch.yml') }

export function readDshPatchDefaults(layers: Array<string | null>): NativeDefaults {
    let fields: DshModelFields = {}, disabled = false, unknown = false
    for (const layer of layers) {
        if (layer === null) continue
        const projection = inspectDshPatch(layer)
        if (!projection.safe) { unknown = true; break }
        // Cordis replaces the row's entire config; it does not merge its fields.
        if (projection.config !== undefined) fields = projection.config
        if (projection.disabled !== undefined) disabled = projection.disabled
    }
    if (unknown || disabled) fields = {}
    return { model: fields.model ?? null, connection: fields.provider ?? null, effort: fields.reasoningEffort ?? null,
        profile: 'headless', credential_ready: null,
        notes: [unknown ? 'DSH patch contains unsupported/dynamic model or patch syntax; effective selection unknown. No YAML/JavaScript was evaluated.'
            : disabled ? 'DSH agent-default-model row is disabled; selection unknown.'
                : 'Literal DSH headless patch snapshot only; bundle → profile → home order, whole config replacement. Plugin runtime selection/authentication unverified.'] }
}

/** One literal patch layer; callers needing effective metadata must supply the full stack. */
export function readDshNativeDefaults(raw: string | null): NativeDefaults { return readDshPatchDefaults([raw]) }
export function discoverDshModels(raw: string | null): DiscoverModelsResult { return catalog(readDshNativeDefaults(raw)) }
function catalog(native: NativeDefaults): DiscoverModelsResult {
    const connection = native.connection ?? null, model = native.model
    return { models: connection && model ? [{ alias: connection + '/' + model, connection, resolved_model: model,
        source: 'native-config', effort_selectable: false, default_effort: native.effort ?? null }] : [],
        connections: connection ? [{ id: connection, source: 'native-config', auth_type: 'unknown' }] : [], native_defaults: native,
        notes: [...native.notes ?? [], 'Only the configured literal default is listed, not the plugin model catalog. DSH owns provider/model/effort; missing entries do not imply unavailable models.'] }
}

async function readPatchLayers(): Promise<{ layers: Array<string | null>; complete: boolean }> {
    const directory = path.dirname(dshSettingsPath()), manifest = await optionalFile(path.join(directory, 'package.json'))
    const layers: Array<string | null> = []
    let complete = true
    try {
        const bundles: unknown = JSON.parse(manifest ?? '{}').dsh?.profile?.bundles
        if (!Array.isArray(bundles) || !bundles.length) return { layers: [], complete: false }
        for (const bundle of bundles) {
            if (typeof bundle !== 'string' || !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(bundle)) return { layers: [], complete: false }
            let folder = directory, found: string | null = null
            while (true) {
                const candidate = path.join(folder, 'node_modules', bundle)
                try { await fs.access(path.join(candidate, 'package.json')); found = candidate; break }
                catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
                const parent = path.dirname(folder); if (parent === folder) break; folder = parent
            }
            if (!found) { complete = false; break }
            const patch = await optionalFile(path.join(found, 'cordis.patch.yml'))
            if (patch === null) { complete = false; break }
            layers.push(patch)
        }
    } catch { complete = false }
    layers.push(await optionalFile(dshSettingsPath()), await optionalFile(dshHomePatchPath()))
    return { layers, complete }
}
export async function readNativeDefaults(): Promise<NativeDefaults> {
    const { layers, complete } = await readPatchLayers()
    if (!complete) return { model: null, connection: null, effort: null, profile: 'headless', credential_ready: null,
        notes: ['DSH headless bundle stack is unavailable or unsupported; no fallback to obsolete settings.yaml. Configure the native profile first.'] }
    return readDshPatchDefaults(layers)
}
export async function discoverModels(): Promise<DiscoverModelsResult> { return catalog(await readNativeDefaults()) }

/** Setup preserves omitted effort only when the complete effective literal stack is known. */
export async function readDshSetupDefaults(): Promise<DshModelFields> {
    const { layers, complete } = await readPatchLayers()
    if (!complete || layers.some(layer => layer !== null && !inspectDshPatch(layer).safe))
        throw new PaidanError('SETUP_NATIVE_UNSUPPORTED', 'DSH 原生模型层无法完整解析，不能证明省略 effort 会保持当前强度；请用原生设置调整，或明确选择强度。')
    const native = readDshPatchDefaults(layers)
    if (!native.connection || !native.model) throw new PaidanError('SETUP_NATIVE_UNSUPPORTED', 'DSH 当前默认模型不可确定，不能保留未选择修改的强度。')
    return { provider: native.connection, model: native.model, ...(native.effort === null ? {} : { reasoningEffort: native.effort ?? undefined }) }
}
