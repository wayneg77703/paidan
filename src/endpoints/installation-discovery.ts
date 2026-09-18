// Setup-only location discovery. Runtime dispatch continues to use the saved exact entry.
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { EndpointManifest } from './registry.js'
import { enumerateEndpointSpawns, type SpawnSource } from './spawn.js'

const exec = promisify(execFile)
const isFile = (p: string) => fs.stat(p).then(s => s.isFile(), () => false)

/** Read installation records and named shortcuts, never search entire drives. */
async function windowsZcodeLocations(env: NodeJS.ProcessEnv): Promise<string[]> {
    if (process.platform !== 'win32' || env.PAIDAN_HOST_HOME) return [] // isolated test homes
    const script = `
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$roots = @('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*', 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*', 'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*')
$found = @(Get-ItemProperty $roots | Where-Object { $_.DisplayName -match '(?i)zcode' } | ForEach-Object { $_.InstallLocation; $_.DisplayIcon })
$shell = New-Object -ComObject WScript.Shell
$folders = @([Environment]::GetFolderPath('StartMenu'), [Environment]::GetFolderPath('CommonStartMenu'), [Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('CommonDesktopDirectory'))
$found += @(foreach ($folder in $folders) { if ($folder) { Get-ChildItem -LiteralPath $folder -Filter '*zcode*.lnk' -Recurse -File | ForEach-Object { $shell.CreateShortcut($_.FullName).TargetPath } } })
ConvertTo-Json -Compress -InputObject @($found | Where-Object { $_ } | Select-Object -Unique)
`
    const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env, timeout: 8000, windowsHide: true })
    return (JSON.parse(stdout.replace(/^\uFEFF/, '')) as string[]).map(s => s.replace(/,\s*-?\d+$/, '').replace(/^"|"$/g, ''))
}

async function npmCache(env: NodeJS.ProcessEnv): Promise<string | null> {
    if (env.npm_config_cache || env.NPM_CONFIG_CACHE) return env.npm_config_cache || env.NPM_CONFIG_CACHE!
    const cli = [env.npm_execpath, path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
        ...[env.APPDATA && path.join(env.APPDATA, 'npm'), env.NPM_CONFIG_PREFIX].filter(Boolean).map(p => path.join(p!, 'node_modules/npm/bin/npm-cli.js'))]
    for (const dir of (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean)) {
        if (process.platform === 'win32') cli.push(path.join(dir, 'node_modules/npm/bin/npm-cli.js'))
        else cli.push(await fs.realpath(path.join(dir, 'npm')).catch(() => undefined))
    }
    for (const file of cli) if (file && await isFile(file)) {
        const { stdout } = await exec(process.execPath, [file, 'config', 'get', 'cache', '--json'], { env, timeout: 5000, windowsHide: true })
        // npm versions differ: some ignore --json for config get and print a bare path.
        let value: unknown = stdout.trim()
        try { value = JSON.parse(stdout) } catch { /* ordinary path output */ }
        if (typeof value === 'string' && path.isAbsolute(value)) return value
    }
    return null
}

export async function discoverInstallations(manifest: EndpointManifest, opts: {
    configBin?: string | null; locations?: string[]; env?: NodeJS.ProcessEnv
} = {}) {
    const env = opts.env ?? process.env
    const paths: Array<{ file: string; source: SpawnSource }> = []
    const checked: string[] = [], notes: string[] = []
    const add = async (file: string, source: SpawnSource) => {
        checked.push(file)
        if (await isFile(file)) paths.push({ file, source })
    }
    const location = async (input: string, source: SpawnSource) => {
        const p = path.resolve(input), stat = await fs.stat(p).catch(() => null)
        checked.push(p)
        if (!stat) return
        const dir = stat.isDirectory() ? p : path.dirname(p)
        if (manifest.name === 'zcode') {
            if (stat.isFile() && /\.(cjs|mjs|js)$/i.test(p)) await add(p, source)
            else for (const relative of ['resources/glm/zcode.cjs', 'glm/zcode.cjs', 'zcode.cjs']) await add(path.join(dir, relative), source)
        } else if (manifest.name === 'dsh') {
            if (stat.isFile()) { await add(p, source); return }
            for (const root of [dir, path.join(dir, 'node_modules/@deepseek-ai/dsh'), path.join(dir, 'profiles/node_modules/@deepseek-ai/dsh')]) {
                const pkg = await fs.readFile(path.join(root, 'package.json'), 'utf8').then(JSON.parse, () => null).catch(() => null)
                if (pkg?.name === '@deepseek-ai/dsh') await add(path.join(root, 'lib/bin.js'), source)
            }
            const cache = path.basename(dir) === '_npx' ? dir : path.join(dir, '_npx')
            for (const entry of await fs.readdir(cache, { withFileTypes: true }).catch(() => [])) if (entry.isDirectory()) await location(path.join(cache, entry.name), 'npm-cache')
        } else if (stat.isFile()) await add(p, source)
        else {
            for (const ext of process.platform === 'win32' ? ['.exe', '.cmd', '.js', '.cjs'] : ['', '.js', '.cjs']) await add(path.join(dir, manifest.detect.bin + ext), source)
            for (const entry of [manifest.detect.npm_exe, manifest.detect.npm_entry]) if (entry) await add(path.join(dir, 'node_modules', entry), source)
        }
    }
    for (const hint of opts.locations ?? []) await location(hint, 'location-hint')
    if (manifest.name === 'zcode') {
        checked.push('Windows installed applications / ZCode shortcuts')
        try { for (const p of await windowsZcodeLocations(env)) await location(p, 'install-record') }
        catch { notes.push('Windows 安装记录查询失败；仍检查常见位置，可补充安装目录或桌面程序位置。') }
    }
    if (manifest.name === 'dsh') {
        await location(env.DSH_HOME ?? path.join(env.PAIDAN_HOST_HOME ?? os.homedir(), '.dsh'), 'native-home')
        let cache: string | null = null
        try { cache = await npmCache(env) } catch { notes.push('npm 缓存位置查询失败，可补充缓存目录作为 location。') }
        if (cache) {
            checked.push(path.join(cache, '_npx'))
            await location(cache, 'npm-cache')
        }
        notes.push('npx 缓存入口可能被清理；失效后重新查找并确认，不自动下载、升级或更换入口。')
    }
    const candidates = await enumerateEndpointSpawns(manifest, { configBin: opts.configBin, env, extraPaths: paths })
    for (const candidate of candidates) if (manifest.name === 'dsh' && candidate.resolved_from !== 'config-override'
        && /[\\/]_npx[\\/]/.test(candidate.endpoint_bin ?? '')) candidate.resolved_from = 'npm-cache'
    return { candidates, checked: [...new Set(['PATH / npm layouts / manifest known_paths', ...checked])], notes }
}
