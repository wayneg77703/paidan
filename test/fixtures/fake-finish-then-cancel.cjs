// Fake endpoint that completes successfully — writes the deliverable, prints
// one assistant line — then writes the cancel marker itself and exits 0.
// Stages the "endpoint finished but the cancel flag appeared" race
// deterministically: the marker always lands before the endpoint exits.

const fs = require('node:fs')
const path = require('node:path')

fs.writeFileSync(path.join(process.cwd(), 'fake-deliverable.txt'), 'fake deliverable content\n')
process.stdout.write(JSON.stringify({ role: 'assistant', content: 'finished before cancel' }) + '\n', () => {
    const runsDir = path.join(process.env.PAIDAN_DATA_DIR, 'runs')
    const runs = fs.readdirSync(runsDir).filter((d) => d.startsWith('run_'))
    if (runs.length === 1) {
        fs.writeFileSync(
            path.join(runsDir, runs[0], 'cancel.request'),
            JSON.stringify({ requested_at: new Date().toISOString() }),
        )
    }
    process.exit(0)
})
