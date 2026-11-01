// Run: node --test hc.down.routes.test.mjs — WP-378 F5 (D4): with the hc core STOPPED, no route may run an hc call (every hc call, even
// `hc get` / `hc read`, starts a stopped core). The gate is ONE place, the server's hc wrapper layer; this walks the routes that reach hc
// outside agents()/hcRows(): the activity poll, the conversation read, typing into an agent, the Terminals routes. The fake hc logs every call.
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { hcStub, terminal, shell } from './test-hc.mjs'

let hc, child, base, cookie, root
const PORT = 30000 + Math.floor(Math.random() * 20000)
const LABEL = hostname()
const J = { 'content-type': 'application/json' }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const post = (path, body) => fetch(`${base}${path}`, { method: 'POST', headers: { ...J, cookie }, body: JSON.stringify(body ?? {}) })
const get = (path) => fetch(`${base}${path}`, { headers: { cookie } })

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'wt-hcdown-'))
  mkdirSync(join(root, 'data'), { recursive: true }); mkdirSync(join(root, 'pane-keys'))
  hc = await hcStub({ terminals: [
    terminal({ address: 't1', name: 'demo-worker-01', status: 'idle', cwd: '/tmp', pid: 41, foreground: { name: '2.1', argv: ['claude'], cwd: '/tmp', pid: 41 } }),
    shell({ address: 't9', name: 'sh-demo-01', labels: { 'wt.pool': 'demo-shells' } }),
  ] })
  await hc.down() // the core is stopped before the server starts and stays so
  child = spawn(process.execPath, ['server.mjs'], { cwd: import.meta.dirname, stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, PORT: String(PORT), WT_DASHBOARD_DATA: root, HOME: root, ...hc.env } })
  base = `http://127.0.0.1:${PORT}`
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/api/push`)).ok) break } catch { /* not up yet */ } await sleep(100) }
  cookie = `hd_session=${readFileSync(join(root, 'session'), 'utf8').trim()}`
  await fetch(`${base}/api/rooms`, { headers: { cookie } })
})
after(async () => { child?.kill(); await hc?.close() })

test('core down: the activity poll, conversation read, typing and every Terminals route run no hc call', async () => {
  assert.equal((await post('/api/terminal-settings', { enabled: true })).status, 200)
  const a = `/api/agents/${LABEL}/t1`
  const hits = {
    activity: await get(`${a}/activity`), read: await get(a), visible: await get(`${a}?visible=1`),
    text: await post(a, { text: 'hello' }), keys: await post(a, { keys: ['esc'] }),
    shells: await get('/api/terminals'), create: await post('/api/terminals', { cwd: root, name: 'x' }),
    screen: await get('/api/terminals/t9/screen'), input: await post('/api/terminals/t9/input', { text: 'ls', submit: true }),
    stream: await get('/api/terminals/t9/stream'),
  }
  const status = Object.fromEntries(Object.entries(hits).map(([k, r]) => [k, r.status]))
  // the activity poll is best-effort (an empty answer); everything that needs hc is 503 (D19); the stream never opens
  assert.deepEqual(status, { activity: 200, read: 503, visible: 503, text: 503, keys: 503, shells: 503, create: 503, screen: 503, input: 503, stream: 503 })
  assert.deepEqual(hc.calls().map((c) => c.args.join(' ')), [], 'no hc process ran: it would have started the core')
})
