// Fake claude-code endpoint binary (test fixture): prints a claude stream-json
// NDJSON stream (init -> assistant -> one terminal result carrying usage and
// total_cost_usd). No network, no real agent.

const rows = [
    { type: 'system', subtype: 'init', session_id: 'fake-claude-0001' },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'fake claude done' }] } },
    {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'fake claude done',
        session_id: 'fake-claude-0001',
        usage: { input_tokens: 4, cache_creation_input_tokens: 60, cache_read_input_tokens: 30, output_tokens: 9 },
        total_cost_usd: 0.0123,
        permission_denials: [],
    },
]
for (const row of rows) process.stdout.write(JSON.stringify(row) + '\n')
