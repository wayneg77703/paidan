// Smoke: run the built CLI's doctor against an isolated PAIDAN_HOME and assert
// the stdout envelope contract. No real agent is invoked.

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const repoRoot = fileURLToPath(new URL('..', import.meta.url))

const home = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'paidan-smoke-'))
try {
    const { stdout, stderr } = await execFileAsync(
        process.execPath,
        [nodePath.join(repoRoot, 'dist', 'cli.js'), 'doctor'],
        {
            env: {
                ...process.env,
                PAIDAN_HOME: home,
                PAIDAN_DATA_DIR: nodePath.join(home, 'data'),
            },
            timeout: 30_000,
        },
    )
    const envelope = JSON.parse(stdout.trim())
    assert.equal(envelope.ok, true, `doctor failed: ${stdout} ${stderr}`)
    assert.equal(envelope.data_dir, nodePath.join(home, 'data'))
    assert.ok(Array.isArray(envelope.endpoints))
    assert.ok(envelope.endpoints.some((e) => e.name === 'kimi-code'))
    assert.equal(envelope.usage_db.ok, true)
    process.stderr.write('smoke: doctor envelope OK\n')
} finally {
    await fs.rm(home, { recursive: true, force: true }).catch(() => {})
}
