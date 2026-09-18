// Models cache store semantics (src/engine/models-cache.ts).

import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import { test } from 'node:test'
import { ModelsCache } from '../dist/engine/models-cache.js'

function entry(overrides = {}) {
    return {
        schema_version: '1.0.0',
        endpoint: 'kimi-code',
        fetched_at: '2026-09-10T00:00:00.000Z',
        version: '0.42.0',
        source: 'kimi-native-config',
        models: [{ alias: 'kimi-for-coding/k3', connection: 'kimi-for-coding' }],
        notes: [],
        ...overrides,
    }
}

test('write -> read round trip; missing and corrupt caches read as absent', async () => {
    const dir = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'paidan-mcache-'))
    try {
        const cache = new ModelsCache(dir)
        assert.equal(await cache.read('kimi-code'), null)
        await cache.write(entry())
        const read = await cache.read('kimi-code')
        assert.equal(read?.models[0]?.alias, 'kimi-for-coding/k3')
        assert.equal(read?.version, '0.42.0')

        await fs.writeFile(nodePath.join(dir, 'models-cache', 'kimi-code.json'), '{broken', 'utf8')
        assert.equal(await cache.read('kimi-code'), null)
    } finally {
        await fs.rm(dir, { recursive: true, force: true })
    }
})

test('a successful empty model list overwrites the previous cache (no borrowing)', async () => {
    const dir = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'paidan-mcache-'))
    try {
        const cache = new ModelsCache(dir)
        await cache.write(entry())
        await cache.write(entry({ models: [], fetched_at: '2026-09-10T01:00:00.000Z' }))
        const read = await cache.read('kimi-code')
        assert.deepEqual(read?.models, [])
        assert.equal(read?.fetched_at, '2026-09-10T01:00:00.000Z')
    } finally {
        await fs.rm(dir, { recursive: true, force: true })
    }
})

test('ageHours is fractional hours since fetched_at', async () => {
    const cache = new ModelsCache('D:/unused')
    const e = entry({ fetched_at: '2026-09-10T00:00:00.000Z' })
    const now = new Date('2026-09-10T06:00:00.000Z')
    assert.equal(cache.ageHours(e, now), 6)
})

test('unsafe endpoint names are rejected', async () => {
    const cache = new ModelsCache('D:/unused')
    await assert.rejects(cache.write(entry({ endpoint: '../escape' })), /unsafe endpoint name/)
})
