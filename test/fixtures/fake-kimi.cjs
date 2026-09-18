// Fake kimi-print endpoint binary (test fixture): writes a deliverable into
// cwd, then prints kimi stream-json rows (assistant + session.resume_hint).
// Usage is absent from the stream by design — the worker must find it in the
// fake native ledger pointed at by KIMI_CODE_HOME.

const fs = require('node:fs')

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
