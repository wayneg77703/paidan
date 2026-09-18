// Fake kimi-print endpoint that also appends one usage.record row to the wire
// file named by FAKE_WIRE — simulating the real endpoint writing its own native
// ledger mid-run, which is what the resume-run pre-spawn cursor diff keys on.

const fs = require('node:fs')

if (process.env.FAKE_WIRE) {
    fs.appendFileSync(
        process.env.FAKE_WIRE,
        JSON.stringify({
            type: 'usage.record',
            usageScope: 'turn',
            usage: { inputCacheRead: 0, inputOther: 200, inputCacheCreation: 0, output: 11 },
        }) + '\n',
    )
}
fs.writeFileSync('fake-deliverable.txt', 'fake-content')
process.stdout.write(JSON.stringify({ role: 'assistant', content: 'fake kimi done' }) + '\n')
process.stdout.write(
    JSON.stringify({
        role: 'meta',
        type: 'session.resume_hint',
        session_id: 'session_fakekimi01',
        command: 'kimi -r session_fakekimi01',
    }) + '\n',
)
