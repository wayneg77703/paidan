// Metadata and task surface for the three native catalog adapters. No network or real credentials.
const fs = require('node:fs')
const path = require('node:path')
const home = process.env.PAIDAN_HOST_HOME
const state = JSON.parse(fs.readFileSync(path.join(home, 'state.json'), 'utf8'))
const args = process.argv.slice(2)
const print = value => console.log(JSON.stringify(value))
if (args.includes('--version')) console.log('1.0.0')
else if (args[0] === 'debug' && args[1] === 'paths') console.log('data ' + home)
else if (args[0] === 'debug') print(state.config)
else if (args[0] === 'config' && args[1] === 'path') console.log(home)
else if (args[0] === 'config') print(state.config)
else if (args[0] === 'models') {
    if (state.endpoint === 'opencode') for (const alias of state.models) {
        console.log(alias)
        print({ variants: { low: {}, high: {}, removed: { disabled: true } } })
    }
    else if (state.endpoint === 'omp') print({ models: state.models.map(selector => ({ selector, provider: 'route', thinking: ['low', 'high'] })) })
    else for (const alias of state.models) console.log(alias + '\t' + alias)
} else {
    fs.appendFileSync(path.join(home, 'calls.jsonl'), JSON.stringify({ args, cwd: process.cwd() }) + '\n')
    if (state.fail) { console.error('fixture: authentication expired'); process.exit(1) }
    if (state.endpoint === 'opencode') print({ type: 'text', sessionID: 'fixture', part: { text: 'done' } })
    else if (state.endpoint === 'omp') {
        print({ type: 'session', id: 'fixture' })
        print({ type: 'turn_end', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } })
    } else print({ event: 'result', result: { conversation_id: 'fixture', status: 'SUCCESS', response: 'done' } })
}
