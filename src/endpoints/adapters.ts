// Native adapter loading and endpoint-specific launch preparation.
import { ManifestError, type EndpointManifest } from './registry.js'
import type { EndpointParserModule, EndpointStreamParser } from './parser-api.js'
import type { SpawnPlan } from './spawn.js'
import { prepareZcodeRuntime } from './zcode-runtime.js'

/** Endpoint-specific launch resources; credentials stay in native custody. */
export async function prepareEndpointRuntime(manifest: EndpointManifest, plan: SpawnPlan, env: NodeJS.ProcessEnv, cwd?: string, providerConfig?: string | null) {
    if (manifest.name === 'zcode') return prepareZcodeRuntime(plan, env, cwd, providerConfig)
    return { env, check: null, expected: null, provider_config: null }
}

export interface EndpointParserBundle {
    parser: EndpointStreamParser
    detectRefusals: (stderrText: string, exitCode: number | null) => string[]
    readLedgerUsage?: EndpointParserModule['readLedgerUsage']
    captureLedgerCursor?: EndpointParserModule['captureLedgerCursor']
    readExecutionSelection?: EndpointParserModule['readExecutionSelection']
}

const PARSER_NAME_RE = /^[a-z0-9][a-z0-9-]*$/

/** Convention: manifest.parser "<name>" -> src/endpoints/<name>.ts with createParser + detectRefusals. */
export async function loadParserModule(parserName: string): Promise<EndpointParserModule> {
    if (!PARSER_NAME_RE.test(parserName)) {
        throw new ManifestError(`invalid parser name ${JSON.stringify(parserName)}`)
    }
    let mod: Record<string, unknown>
    try {
        mod = await import(`./${parserName}.js`)
    } catch {
        throw new ManifestError(`parser module not found for "${parserName}" (expected src/endpoints/${parserName}.ts)`)
    }
    if (typeof mod.createParser !== 'function' || typeof mod.detectRefusals !== 'function') {
        throw new ManifestError(`parser module "${parserName}" must export createParser and detectRefusals`)
    }
    return mod as unknown as EndpointParserModule
}

/** Parser selection by manifest.parser; the only place engine code reaches parser code. */
export async function createEndpointParser(manifest: EndpointManifest): Promise<EndpointParserBundle> {
    const mod = await loadParserModule(manifest.parser)
    return {
        parser: mod.createParser(),
        detectRefusals: mod.detectRefusals,
        readLedgerUsage: mod.readLedgerUsage,
        captureLedgerCursor: mod.captureLedgerCursor,
        readExecutionSelection: mod.readExecutionSelection,
    }
}
