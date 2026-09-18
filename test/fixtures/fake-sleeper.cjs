// Fake endpoint that sleeps 30s before printing a minimal kimi-print stream —
// something for the engine run-timeout to kill. No network, no real agent.

setTimeout(() => {
    process.stdout.write(JSON.stringify({ role: 'assistant', content: 'slept 30s' }) + '\n')
}, 30_000)
