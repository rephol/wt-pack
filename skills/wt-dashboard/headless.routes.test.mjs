// Run: node --test headless.routes.test.mjs — WP-293 headless routes against a real server process: an isolated data dir, a
// scratch port, a fake `claude` (stream-json over stdin/stdout, WT_HEADLESS_CMD) and a fake `herdr` on PATH that knows one
// agent pane (w9:p1), so nothing reaches a real agent, pane or session. Cap 1, so the second spawn queues.
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const FAKE_CLAUDE = `#!/usr/bin/env node
// init + an idle result at start; per user line: "TOOL:Bash" asks for Bash, "ASK" asks AskUserQuestion, "HANG" stays working,
// anything else gets a result. A control_response or an interrupt ends the turn. Exits on stdin EOF.
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
const result = () => out({ type: 'result', subtype: 'success', total_cost_usd: 0.01 })
out({ type: 'system', subtype: 'init', session_id: 'sess-' + process.pid, plugins: [], permissionMode: 'default', apiKeySource: 'none' })
result()
let buf = '', n = 0
process.stdin.on('data', (d) => {
  buf += d
  let i
  while ((i = buf.indexOf('\\n')) >= 0) {
    const e = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1)
    if (e.type === 'user') {
      const t = e.message.content
      out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'echo ' + t }] } })
      if (t === 'TOOL:Bash') out({ type: 'control_request', request_id: 'req-' + ++n, request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' } } })
      else if (t === 'ASK') out({ type: 'control_request', request_id: 'req-' + ++n, request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions: [{ question: 'Pick one?', options: [{ label: 'A' }, { label: 'B' }] }] } } })
      else if (t !== 'HANG') result()
    } else if (e.type === 'control_response') { out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: JSON.stringify(e.response.response) }] } }); result() }
    else if (e.type === 'control_request' && e.request.subtype === 'interrupt') result()
  }
})
process.stdin.on('end', () => process.exit(0))
`
const FAKE_HERDR = `#!/usr/bin/env node
const a = process.argv.slice(2).join(' ')
if (a === 'agent list') console.log(JSON.stringify({ result: { agents: [{ pane_id: 'w9:p1', agent_status: 'working', cwd: '/tmp', state_change_seq: 1 }] } }))
else if (a === 'pane get w9:p1') console.log(JSON.stringify({ result: { pane: { pane_id: 'w9:p1' } } }))
else if (a === 'machine list') console.log('')
else process.exit(1)
`

let child, base, cookie, root
const PORT = 30000 + Math.floor(Math.random() * 20000)
const call = (path, { method = 'GET', body, auth = true, headers = {} } = {}) =>
  fetch(`${base}${path}`, { method, headers: { ...(auth ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined })
const json = async (path, o) => { const r = await call(path, o); assert.equal(r.status, 200, `${o?.method ?? 'GET'} ${path}: ${await r.clone().text()}`); return r.json() }
const until = async (f, what) => { for (let i = 0; i < 100; i++) { const v = await f(); if (v) return v; await new Promise((r) => setTimeout(r, 50)) } assert.fail(`timed out: ${what}`) }
const state = (id, s) => until(async () => (await (await call(`/api/headless/${id}`)).json()).state === s, `${id} → ${s}`)
const PANE = { 'x-herdr-pane': 'w9:p1' }

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'wt-hlroutes-'))
  const bin = join(root, 'bin')
  mkdirSync(join(root, 'data'), { recursive: true }); mkdirSync(bin)
  writeFileSync(join(bin, 'fake-claude'), FAKE_CLAUDE); writeFileSync(join(bin, 'herdr'), FAKE_HERDR)
  chmodSync(join(bin, 'fake-claude'), 0o755); chmodSync(join(bin, 'herdr'), 0o755)
  child = spawn(process.execPath, ['server.mjs'], { cwd: import.meta.dirname, stdio: ['ignore', 'ignore', 'inherit'], env: {
    ...process.env, PORT: String(PORT), WT_DASHBOARD_DATA: root, HOME: root, PATH: `${bin}:${process.env.PATH}`,
    WT_HEADLESS_CMD: join(bin, 'fake-claude'), WT_HEADLESS_CAP: '1', WT_HEADLESS_ROLES: '*', WT_HEADLESS_GRACE_MS: '500' } })
  base = `http://127.0.0.1:${PORT}`
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/api/push`)).ok) break } catch { /* not up yet */ } await new Promise((r) => setTimeout(r, 100)) }
  cookie = `hd_session=${readFileSync(join(root, 'session'), 'utf8').trim()}`
})
after(() => child?.kill()) // the server's own pid; the fake claudes exit on stdin EOF when it goes

test('spawn validates role and cwd; cap 1 queues the second run until the first stops', async () => {
  assert.equal((await call('/api/headless', { method: 'POST', body: { role: 'bad role!', cwd: root } })).status, 400)
  assert.equal((await call('/api/headless', { method: 'POST', body: { role: 'worker', cwd: join(root, 'nope') } })).status, 400)
  assert.equal((await call('/api/headless', { method: 'POST', body: { role: 'worker' } })).status, 400)
  assert.equal((await call('/api/headless', { method: 'POST', body: [1] })).status, 400)
  const a = await json('/api/headless', { method: 'POST', body: { role: 'worker', cwd: root, name: 'hl-a' } })
  assert.match(a.id, /^hl-/)
  await state(a.id, 'idle')
  const b = await json('/api/headless', { method: 'POST', body: { role: 'worker', cwd: root } })
  assert.equal(b.state, 'queued')
  assert.equal((await call(`/api/headless/${b.id}/message`, { method: 'POST', body: { text: 'hi' } })).status, 409)
  const list = await json('/api/headless')
  assert.ok(list.some((r) => r.id === a.id) && list.some((r) => r.id === b.id))
  await json(`/api/headless/${a.id}/stop`, { method: 'POST', body: {} })
  await state(a.id, 'ended')
  await state(b.id, 'idle')
  await json(`/api/headless/${b.id}/stop`, { method: 'POST', body: {} })
  await state(b.id, 'ended')
})

test('message, events?after=, SSE replay from Last-Event-ID, interrupt, tool + AskUserQuestion answers, stop, resume', async () => {
  const r = await json('/api/headless', { method: 'POST', body: { role: 'worker', cwd: root, prompt: 'hello' } })
  await state(r.id, 'idle')
  const all = await json(`/api/headless/${r.id}/events`)
  assert.ok(all.events.some((e) => e.type === 'system/init'))
  const mid = all.events[1].seq
  const later = await json(`/api/headless/${r.id}/events?after=${mid}`)
  assert.ok(later.events.length && later.events.every((e) => e.seq > mid))
  assert.equal((await json(`/api/headless/${r.id}/events?limit=-5`)).events.length, all.events.length) // clamped, not unbounded

  // SSE: a reconnect with Last-Event-ID replays only what came after it, then streams new events
  const ctl = new AbortController()
  const sse = await fetch(`${base}/api/headless/${r.id}/stream`, { headers: { 'last-event-id': String(mid) }, signal: ctl.signal })
  const reader = sse.body.getReader()
  let text = ''
  const read = (re) => until(async () => { const { value } = await reader.read(); text += Buffer.from(value ?? []).toString(); return re.test(text) }, `sse ${re}`)
  await read(/id: \d+/)
  const ids = [...text.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]))
  assert.ok(ids.length && ids.every((s) => s > mid))
  await json(`/api/headless/${r.id}/message`, { method: 'POST', body: { text: 'second' } })
  await read(/echo second/)
  ctl.abort()

  await json(`/api/headless/${r.id}/message`, { method: 'POST', body: { text: 'HANG' } })
  await state(r.id, 'working')
  await json(`/api/headless/${r.id}/interrupt`, { method: 'POST', body: {} })
  await state(r.id, 'idle')
  assert.equal((await call(`/api/headless/${r.id}/interrupt`, { method: 'POST', body: {} })).status, 409)

  await json(`/api/headless/${r.id}/message`, { method: 'POST', body: { text: 'TOOL:Bash' } })
  const ask = await until(async () => (await (await call(`/api/headless/${r.id}`)).json()).asks[0], 'tool ask')
  assert.equal(ask.tool, 'Bash')
  const row = (await json('/api/agents')).find((x) => x.id === r.id)
  assert.equal(row.status, 'blocked')
  const inboxItem = async () => (await json('/api/notifications')).items.find((it) => it.kind === 'headless-ask' && it.target.ask === ask.id)
  const item = await until(inboxItem, 'inbox item for the ask')
  assert.equal(item.target.agent, `${row.machine}/${r.id}`); assert.equal(item.resolvedAt, null)
  await json(`/api/headless/${r.id}/answer`, { method: 'POST', body: { ask: ask.id, allow: false, message: 'no' } })
  await until(async () => (await inboxItem()).resolvedAt, 'inbox item resolved after the answer')
  await until(async () => (await json(`/api/headless/${r.id}/events`)).events.some((e) => /"behavior":"deny"/.test(JSON.stringify(e.event))), 'deny reached the child')

  await json(`/api/headless/${r.id}/message`, { method: 'POST', body: { text: 'ASK' } })
  const q = await until(async () => (await (await call(`/api/headless/${r.id}`)).json()).asks[0], 'AskUserQuestion ask')
  assert.equal(q.tool, 'AskUserQuestion')
  assert.equal((await call(`/api/headless/${r.id}/answer`, { method: 'POST', body: { ask: q.id, answers: { 'Other?': 'A' } } })).status, 400)
  await json(`/api/headless/${r.id}/answer`, { method: 'POST', body: { ask: q.id, answers: { 'Pick one?': 'B' } } })
  await until(async () => (await json(`/api/headless/${r.id}/events`)).events.some((e) => e.type === 'user' && JSON.parse(e.event.message.content[0].content).updatedInput?.answers?.['Pick one?'] === 'B'), 'answer reached the child')
  assert.equal((await call(`/api/headless/${r.id}/answer`, { method: 'POST', body: { ask: q.id, answers: { 'Pick one?': 'A' } } })).status, 404)

  await json(`/api/headless/${r.id}/stop`, { method: 'POST', body: {} })
  await state(r.id, 'ended')
  const session = (await json(`/api/headless/${r.id}`)).session
  await json(`/api/headless/${r.id}/resume`, { method: 'POST', body: { text: 'again' } })
  await state(r.id, 'idle')
  const started = (await json(`/api/headless/${r.id}/events`)).events.filter((e) => e.type === 'supervisor' && e.event.subtype === 'started')
  assert.equal(started.at(-1).event.resume, session)
  await json(`/api/headless/${r.id}/stop`, { method: 'POST', body: {} })
  await state(r.id, 'ended')
})

test('Agents list shows the run (headless:true); agents() (pane lookup) never does', async () => {
  const r = await json('/api/headless', { method: 'POST', body: { role: 'reviewer', cwd: root } })
  await state(r.id, 'idle')
  const ag = await json('/api/agents')
  const row = ag.find((x) => x.id === r.id)
  assert.equal(row.headless, true); assert.equal(row.tags.role, 'reviewer'); assert.equal(row.status, 'idle')
  assert.ok(ag.some((x) => x.id === 'w9:p1' && !x.headless))
  // agents() (roomAuthor's pane lookup, Dispatch, token sync) knows only herdr panes: the run's id is no pane identity
  assert.equal((await call('/api/headless', { method: 'POST', auth: false, headers: { 'x-herdr-pane': r.id }, body: { role: 'worker', cwd: root } })).status, 403)
  assert.equal((await call(`/api/agents/${encodeURIComponent(row.machine)}/${r.id}`)).status, 200)
  await json(`/api/headless/${r.id}/stop`, { method: 'POST', body: {} })
  await state(r.id, 'ended')
})

test('auth: an agent pane may only spawn and message; no cookie is refused; Host/Origin allowlist applies', async () => {
  const r = await json('/api/headless', { method: 'POST', auth: false, headers: PANE, body: { role: 'worker', cwd: root } })
  await state(r.id, 'idle')
  await json(`/api/headless/${r.id}/message`, { method: 'POST', auth: false, headers: PANE, body: { text: 'from a pane' } })
  for (const sub of ['interrupt', 'stop', 'resume', 'answer'])
    assert.equal((await call(`/api/headless/${r.id}/${sub}`, { method: 'POST', auth: false, headers: PANE, body: {} })).status, 403, sub)
  assert.equal((await call('/api/headless', { method: 'POST', auth: false, headers: { 'x-herdr-pane': 'w9:p404' }, body: { role: 'worker', cwd: root } })).status, 403)
  assert.equal((await call('/api/headless', { method: 'POST', auth: false, body: { role: 'worker', cwd: root } })).status, 403)
  assert.equal((await call(`/api/headless/${r.id}/message`, { method: 'POST', auth: false, body: { text: 'x' } })).status, 403)
  assert.equal((await call(`/api/agents/x/${r.id}`, { method: 'POST', auth: false, headers: PANE, body: { text: 'x' } })).status, 403)
  assert.equal((await call('/api/headless', { method: 'POST', headers: { origin: 'http://evil.example' }, body: { role: 'worker', cwd: root } })).status, 403)
  const host = await new Promise((res, rej) => http.request({ host: '127.0.0.1', port: PORT, path: '/api/headless', headers: { host: 'evil.example' } }, (x) => { x.resume(); res(x.statusCode) }).on('error', rej).end())
  assert.equal(host, 403)
  await json(`/api/headless/${r.id}/stop`, { method: 'POST', body: {} })
  await state(r.id, 'ended')
})
