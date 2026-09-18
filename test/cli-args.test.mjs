// node:util parseArgs rejections (ERR_PARSE_ARGS_*) surface as ARGS_INVALID in
// the JSON error envelope, not INTERNAL. Fully isolated tmp dirs.

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { test } from 'node:test'

const execFileAsync = promisify(execFile)
const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const CLI = nodePath.join(repoRoot, 'dist', 'cli.js')

async function paidan(env, args) {
    try {
        const { stdout } = await execFileAsync(process.execPath, [CLI, ...args], { env, timeout: 60_000 })
        return JSON.parse(stdout.trim())
    } catch (err) {
        // error envelopes are JSON on stdout too; only the exit code is non-zero
        if (err.stdout) return JSON.parse(err.stdout.trim())
        throw err
    }
}

test('unknown option (run --bogus) maps to ARGS_INVALID, keeping the JSON envelope shape', async () => {
    const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'paidan-cli-args-'))
    try {
        const env = {
            ...process.env,
            PAIDAN_HOME: nodePath.join(root, 'home'),
            PAIDAN_DATA_DIR: nodePath.join(root, 'data'),
        }
        const res = await paidan(env, ['run', '--bogus'])
        assert.equal(res.ok, false)
        assert.equal(res.error.code, 'ARGS_INVALID')
        assert.match(res.error.message, /--bogus/)
        const get = await paidan(env, ['get', '--bogus'])
        assert.equal(get.ok, false)
        assert.equal(get.error.code, 'ARGS_INVALID')
    } finally {
        await fs.rm(root, { recursive: true, force: true })
    }
})
