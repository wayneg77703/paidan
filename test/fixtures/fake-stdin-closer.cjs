// Fake stdin-delivery endpoint: exits 0 immediately WITHOUT reading stdin.
// The worker must not die on EPIPE/EOF; the run must reach a terminal state.
process.stdout.write(JSON.stringify({ role: 'assistant', content: 'done without reading stdin' }) + '\n')
process.exit(0)
