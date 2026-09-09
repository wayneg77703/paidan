// Fake codex-exec endpoint binary (test fixture): drains stdin, writes a
// deliverable file into cwd, then prints a codex --json NDJSON stream with a
// soft in-band error item and provider usage. No network, no real agent.

const fs = require('node:fs')

let input = ''
process.stdin.resume()
process.stdin.on('data', (c) => {
    input += c
})
process.stdin.on('end', () => {
    fs.writeFileSync('fake-deliverable.txt', 'fake-content')
    const rows = [
        { type: 'thread.started', thread_id: 'fake-thread-0001' },
        { type: 'turn.started' },
        { type: 'item.completed', item: { id: 'item_1', type: 'error', message: 'soft transient error (fake)' } },
        { type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: 'fake done' } },
        { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 7 } },
    ]
    for (const row of rows) process.stdout.write(JSON.stringify(row) + '\n')
})
