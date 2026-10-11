import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const WORKER = fileURLToPath(new URL('./worker.mjs', import.meta.url))
const FAKE = fileURLToPath(new URL('../test-fixtures/fake-sdk.mjs', import.meta.url))

// Start the worker against the fake SDK. `until(pred)` resolves with the first stdout event matching pred (including already seen ones).
function start(args = [], env = {}) {
  const child = spawn(process.execPath, [WORKER, ...args], { env: { ...process.env, WT_HEADLESS_SDK_MODULE: FAKE, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
  const events = [], waiters = []
  let buf = '', stderr = ''
  child.stdout.on('data', (d) => {
    buf += d
    for (let i; (i = buf.indexOf('\n')) >= 0; buf = buf.slice(i + 1)) {
      const e = JSON.parse(buf.slice(0, i)); events.push(e)
      for (const w of waiters.filter((w) => w.pred(e))) { waiters.splice(waiters.indexOf(w), 1); w.res(e) }
    }
  })
  child.stderr.on('data', (d) => { stderr += d })
  const exited = new Promise((res) => child.on('exit', (code, signal) => res({ code, signal })))
  const until = (pred) => new Promise((res, rej) => {
    const hit = events.find(pred)
    if (hit) return res(hit)
    const t = setTimeout(() => rej(new Error('timeout; saw ' + JSON.stringify(events))), 5000)
    waiters.push({ pred, res: (e) => { clearTimeout(t); res(e) } })
  })
  const send = (o) => child.stdin.write(JSON.stringify(o) + '\n')
  const user = (text) => send({ type: 'user', message: { role: 'user', content: text } })
  return { child, events, until, send, user, exited, stderr: () => stderr }
}
const is = (type, subtype) => (e) => e.type === type && (!subtype || e.subtype === subtype)
const text = (re) => (e) => e.type === 'assistant' && re.test(e.message.content[0].text)

test('args become query() options', async () => {
  const mcp = { mcpServers: { f: { command: 'x' } } }
  const w = start(['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--permission-prompt-tool', 'stdio',
    '--permission-mode', 'default', '--tools', 'Read,Grep', '--strict-mcp-config', '--mcp-config', JSON.stringify(mcp), '--model', 'haiku',
    '--effort', 'low', '--settings', '{"a":1}', '--resume', 'sid-1'], { WT_CLAUDE_BIN: '/abs/claude' })
  const o = (await w.until(is('system', 'init'))).options
  assert.deepEqual(o, { settingSources: ['user', 'project', 'local'], cwd: process.cwd(), pathToClaudeCodeExecutable: '/abs/claude', permissionMode: 'default',
    tools: ['Read', 'Grep'], strictMcpConfig: true, mcpServers: mcp.mcpServers, model: 'haiku', effort: 'low', settings: '{"a":1}', resume: 'sid-1', abortController: {} })
  w.child.stdin.end()
  assert.equal((await w.exited).code, 0)
})

test('a user line gives assistant and result; stdin EOF exits 0', async () => {
  const w = start()
  w.user('hi')
  await w.until(text(/echo hi/))
  await w.until(is('result'))
  w.child.stdin.end()
  assert.equal((await w.exited).code, 0)
})

test('context_usage after each result, commands once after init', async () => {
  const w = start()
  w.user('a')
  assert.deepEqual(await w.until(is('system', 'commands')), { type: 'system', subtype: 'commands', commands: [{ name: 'compact' }] })
  assert.deepEqual(await w.until(is('system', 'context_usage')), { type: 'system', subtype: 'context_usage', totalTokens: 1234, maxTokens: 200000, percentage: 0.6 })
  w.user('b')
  await w.until((e) => e.type === 'system' && e.subtype === 'context_usage' && w.events.filter(is('result')).length === 2)
  assert.equal(w.events.filter(is('system', 'commands')).length, 1)
  w.child.stdin.end(); await w.exited
})

test('failing context_usage/commands are swallowed', async () => {
  const w = start([], { WT_FAKE_FAIL: '1' })
  w.user('a')
  await w.until(is('result'))
  w.user('b')
  await w.until(text(/echo b/))
  w.child.stdin.end()
  assert.equal((await w.exited).code, 0)
  assert.match(w.stderr(), /context_usage: usage failed/)
  assert.equal(w.events.some(is('system', 'context_usage')), false)
})

for (const [name, answer, want] of [
  ['allow', { behavior: 'allow', updatedInput: { command: 'ls -l' } }, { behavior: 'allow', updatedInput: { command: 'ls -l' } }],
  ['deny', { behavior: 'deny', message: 'no' }, { behavior: 'deny', message: 'no' }],
]) test(`can_use_tool round trip: ${name}`, async () => {
  const w = start()
  w.user('tool')
  const req = await w.until(is('control_request'))
  assert.equal(req.request.subtype, 'can_use_tool')
  assert.equal(req.request.tool_name, 'Bash')
  assert.deepEqual(req.request.input, { command: 'ls' })
  w.send({ type: 'control_response', response: { subtype: 'success', request_id: req.request_id, response: answer } })
  const a = await w.until(text(/^decision/))
  assert.deepEqual(JSON.parse(a.message.content[0].text.slice(9)), want)
  w.child.stdin.end(); await w.exited
})

test('abort cancels a pending can_use_tool; SIGTERM exits', async () => {
  const w = start()
  w.user('tool')
  const req = await w.until(is('control_request'))
  w.child.kill('SIGTERM')
  assert.equal((await w.until(is('control_cancel_request'))).request_id, req.request_id)
  assert.equal((await w.exited).code, 0)
})

test('interrupt and set_permission_mode control requests', async () => {
  const w = start()
  w.user('hang')
  await w.until(is('system', 'init'))
  w.send({ type: 'control_request', request_id: 'r1', request: { subtype: 'set_permission_mode', mode: 'acceptEdits' } })
  assert.equal((await w.until((e) => e.type === 'control_response' && e.response.request_id === 'r1')).response.subtype, 'success')
  w.send({ type: 'control_request', request_id: 'r2', request: { subtype: 'interrupt' } })
  assert.equal((await w.until((e) => e.type === 'control_response' && e.response.request_id === 'r2')).response.subtype, 'success')
  await w.until(is('result'))
  w.user('modes')
  await w.until(text(/modes acceptEdits/))
  w.child.stdin.end(); await w.exited
})

test('missing SDK exits 3 with a hint', async () => {
  const w = start([], { WT_HEADLESS_SDK_MODULE: '/nonexistent/sdk.mjs' })
  const { code } = await w.exited
  assert.equal(code, 3)
  assert.match(w.stderr(), /SDK driver not installed: run \.\/setup/)
})
