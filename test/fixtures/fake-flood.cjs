// Fake endpoint that floods stdout with >16 MiB on a single line (no '\n'),
// then emits one valid assistant line. Exercises the worker's stdio line cap:
// the run must reach a terminal state with a stdio-truncated event, and the
// worker must not OOM. Chunks are written with backpressure so the fixture
// itself never holds the whole flood in one buffer.

const CHUNK = 'x'.repeat(256 * 1024)
const CHUNKS = 68 // 17 MiB total, above the 16 MiB line cap
let written = 0
const writeNext = () => {
    if (written >= CHUNKS) {
        process.stdout.write(
            '\n' + JSON.stringify({ role: 'assistant', content: 'after the flood' }) + '\n',
            () => process.exit(0),
        )
        return
    }
    written++
    process.stdout.write(CHUNK, writeNext)
}
writeNext()
