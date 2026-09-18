// CLI boundary: command context and JSON envelopes. No task or inspection workflows.
import { fileURLToPath } from 'node:url'
import { defaultConfigPath, loadConfig, resolveDataDir, type PaidanConfig } from '../engine/config.js'
import { RunStore } from '../engine/run-store.js'
import { EndpointRegistry, ManifestError, type EndpointManifest } from '../endpoints/registry.js'
import { PaidanError } from '../engine/errors.js'
export const pkgRoot = fileURLToPath(new URL('../..', import.meta.url))

export function emitOk(payload: Record<string, unknown>): void {
    process.stdout.write(JSON.stringify({ ok: true, ...payload }) + '\n')
}

export function emitError(err: unknown): number {
    if (err instanceof PaidanError) {
        process.stdout.write(JSON.stringify({ ok: false, error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } }) + '\n')
    } else {
        // node:util parseArgs rejections (ERR_PARSE_ARGS_*) are user input
        // errors, not internal ones — surface them as ARGS_INVALID
        const code = (err as { code?: unknown } | null)?.code
        const mapped = typeof code === 'string' && code.startsWith('ERR_PARSE_ARGS') ? 'ARGS_INVALID' : 'INTERNAL'
        const message = err instanceof Error ? err.message : String(err)
        process.stdout.write(JSON.stringify({ ok: false, error: { code: mapped, message } }) + '\n')
    }
    return 1
}

export interface Ctx {
    config: PaidanConfig
    configPath: string
    dataDir: string
    store: RunStore
    registry: EndpointRegistry
}

export async function makeCtx(): Promise<Ctx> {
    const configPath = defaultConfigPath()
    let config: PaidanConfig
    try {
        config = loadConfig(configPath)
    } catch (err) {
        throw new PaidanError('CONFIG_INVALID', err instanceof Error ? err.message : String(err))
    }
    const dataDir = resolveDataDir(config)
    const store = new RunStore(dataDir, { ttlDays: config.ttlDays })
    const registry = await EndpointRegistry.load()
    return { config, configPath, dataDir, store, registry }
}

export function pickEndpoint(ctx: Ctx, flag: string | undefined): EndpointManifest {
    const name = flag ?? ctx.config.defaults.endpoint
    if (!name) throw new PaidanError('ENDPOINT_REQUIRED', 'no --endpoint given and no defaults.endpoint in config.json')
    let manifest: EndpointManifest
    try {
        manifest = ctx.registry.get(name)
    } catch (err) {
        if (err instanceof ManifestError) throw new PaidanError('ENDPOINT_UNKNOWN', err.message)
        throw err
    }
    const enabled = ctx.config.endpoints.enabled
    if (enabled && !enabled.includes(name)) {
        throw new PaidanError('ENDPOINT_DISABLED', `endpoint "${name}" is not in endpoints.enabled`)
    }
    return manifest
}
