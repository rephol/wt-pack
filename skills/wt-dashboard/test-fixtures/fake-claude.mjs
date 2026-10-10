#!/usr/bin/env node
// A fake `claude -p --input-format stream-json --output-format stream-json` for headless tests (WP-293). Reads user lines and
// control_request/control_response lines on stdin, writes events on stdout. Prompt keywords drive it:
//   TOOL:<name> -> can_use_tool control_request for <name> (result after the control_response)   ASK -> AskUserQuestion request
//   HANG        -> never answers (until a control_request interrupt)    CRASH -> exit 1 mid-turn    BIG -> a >256 KB line
//   DEAF        -> like HANG, but ignores interrupts and stdin EOF (only SIGTERM stops it)   FLOOD:<n> -> n assistant events, then a result
//   A cwd ending in -crashy crashes on every turn.
//   SPLIT       -> one event written in two chunks, with a multi-byte char on the seam              anything else -> echo result
// It reports argv/env on system/init so tests can assert them. `--resume <id>` reuses that session id.
import { createInterface } from 'node:readline'

const argv = process.argv.slice(2)
const resume = argv.includes('--resume') ? argv[argv.indexOf('--resume') + 1] : null
const session = resume ?? 'sess-' + Math.random().toString(16).slice(2, 10)
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')
const result = (text) => out({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: session, total_cost_usd: 0.01 })
let hanging = false, deaf = false, n = 0
const pending = new Map() // request_id -> continuation

createInterface({ input: process.stdin }).on('line', (line) => {
  let m; try { m = JSON.parse(line) } catch { return }
  if (m.type === 'control_request' && m.request?.subtype === 'interrupt') {
    out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id } })
    if (deaf) return
    if (hanging) { hanging = false; result('interrupted') }
    return
  }
  if (m.type === 'control_response') { pending.get(m.response?.request_id)?.(m.response.response); pending.delete(m.response?.request_id); return }
  if (m.type !== 'user') return
  const text = typeof m.message?.content === 'string' ? m.message.content : JSON.stringify(m.message?.content)
  out({ type: 'system', subtype: 'init', session_id: session, plugins: [{ name: 'fake' }], permissionMode: 'default', apiKeySource: 'none',
    argv, env: Object.keys(process.env).sort(), resumed: !!resume, turn: ++n })
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'working on: ' + text.slice(0, 40) }] } })
  const ask = (tool, input) => new Promise((res) => {
    const id = 'req-' + Math.random().toString(16).slice(2, 8)
    pending.set(id, res)
    out({ type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', tool_name: tool, input } })
  })
  if (text.includes('CRASH') || process.cwd().endsWith('-crashy')) process.exit(1)
  else if (text.includes('HANG') || text.includes('DEAF')) { hanging = true; deaf = text.includes('DEAF'); setInterval(() => {}, 1000) } // the interval keeps a hung child alive after stdin EOF
  else if (/FLOOD:(\d+)/.test(text)) { for (let i = 0; i < +text.match(/FLOOD:(\d+)/)[1]; i++) out({ type: 'assistant', message: { content: [{ type: 'text', text: 'e' + i }] } }); result('flooded') }
  else if (text.includes('BIG')) { out({ type: 'assistant', message: { content: [{ type: 'text', text: 'x'.repeat(300 * 1024) }] } }); result('big') }
  else if (text.includes('SPLIT')) {
    const b = Buffer.from(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'héllo wörld' }] } }) + '\n')
    const cut = b.indexOf(0xc3) + 1 // between the two bytes of é
    process.stdout.write(b.subarray(0, cut)); setTimeout(() => { process.stdout.write(b.subarray(cut)); result('split') }, 20)
  }
  else if (text.includes('ASK')) ask('AskUserQuestion', { questions: [{ question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }] }).then((r) => result('asked: ' + JSON.stringify(r)))
  else if (/TOOL:(\w+)/.test(text)) { const tool = text.match(/TOOL:(\w+)/)[1]; ask(tool, { command: 'echo hi', file_path: '/tmp/x' }).then((r) => result(`${tool} -> ${r.behavior}`)) }
  else result('echo: ' + text)
})
process.stdin.on('end', () => { if (!hanging && !deaf) process.exit(0) }) // EOF = clean exit, like claude; a hung turn ignores it (SIGTERM path)
