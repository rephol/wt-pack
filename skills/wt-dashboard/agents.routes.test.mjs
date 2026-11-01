// Run: node --test agents.routes.test.mjs — WP-348: the agents table over HTTP (by-name GET, forget guard). Real server, isolated data dir, stubbed hc (test-hc.mjs).
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hcStub, terminal } from './test-hc.mjs'

// WP-378: two claude terminals t1 (role worker, task secret) and t2 on a stubbed hc core (test-hc.mjs); their sessions come from `claude agents --json`.
const T = () => [
  terminal({ address: 't1', name: 'demo-worker-01', status: 'idle', cwd: '/tmp', labels: { role: 'worker', task: 'WP-1 secret', 'wt.pool': 'demo-workers' }, pid: 41, foreground: { name: '2.1', argv: ['claude'], cwd: '/tmp', pid: 41 } }),
  terminal({ address: 't2', name: 'demo-worker-02', status: 'idle', cwd: '/tmp', pid: 42, foreground: { name: '2.1', argv: ['claude'], cwd: '/tmp', pid: 42 } }),
]
const children = [], stubs = []
after(async () => { children.forEach((c) => c.kill()); for (const h of stubs) await h.close() })

test('by-name returns the row without tags; forget: a pane may forget itself or an exited row, never another running/paused one; the user may forget a paused one', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wt-agents-rt-')), bin = join(root, 'bin')
  mkdirSync(join(root, 'data'), { recursive: true }); mkdirSync(bin); mkdirSync(join(root, 'pane-keys'))
  const hc = await hcStub({ terminals: T(), sessions: { s1: 41, s2: 42 } }); stubs.push(hc)
  const port = 30000 + Math.floor(Math.random() * 20000), base = `http://127.0.0.1:${port}`
  children.push(spawn(process.execPath, ['server.mjs'], { cwd: import.meta.dirname, stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, PORT: String(port), WT_DASHBOARD_DATA: root, HOME: root, ...hc.env } }))
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/api/push`)).ok) break } catch { /* not up yet */ } await new Promise((r) => setTimeout(r, 100)) }
  const pane = (p) => ({ 'x-herdr-pane': p })
  let first
  for (let i = 0; i < 20; i++) { first = await fetch(`${base}/api/agents`); if (first.status === 200) break; await new Promise((r) => setTimeout(r, 250)) } // the server may still be loading under a busy suite
  assert.equal(first.status, 200, await first.text()) // the watcher writes a row per live agent
  const row = await (await fetch(`${base}/api/agents/by-name/demo-worker-01`)).json()
  assert.deepEqual([row.name, row.pane, row.state, row.session], ['demo-worker-01', 't1', 'idle', 's1'])
  assert.ok(!('tags' in row) && !JSON.stringify(row).includes('secret'))
  assert.equal((await fetch(`${base}/api/agents/by-name/nobody`)).status, 404)
  assert.equal((await fetch(`${base}/api/agents/by-name/t2`)).status, 200) // a pane id works too
  // seed a paused row and an exited one next to the live ones
  const db = new DatabaseSync(join(root, 'data', 'wt.db'))
  const ins = db.prepare("INSERT INTO agents (name, state, created_at) VALUES (?, ?, 1)")
  ins.run('demo-worker-07', 'paused'); ins.run('demo-worker-08', 'exited'); ins.run('demo-worker-09', 'idle'); db.close() // 09: still idle in the table, but hc no longer lists it (agents.sh rm just closed its tab)
  const forget = (n, h) => fetch(`${base}/api/agents/by-name/${n}/forget`, { method: 'POST', body: '{}', headers: h })
  assert.equal((await forget('demo-worker-02', pane('t1'))).status, 403) // another running agent
  assert.equal((await forget('demo-worker-07', pane('t1'))).status, 403) // a paused one: only the dashboard
  assert.equal((await forget('demo-worker-08', pane('t1'))).status, 200) // exited
  assert.equal((await fetch(`${base}/api/agents/by-name/demo-worker-08`)).status, 404)
  assert.equal((await forget('demo-worker-09', pane('t1'))).status, 200) // a pane may forget a row whose agent is no longer live
  const cookie = `hd_session=${readFileSync(join(root, 'session'), 'utf8').trim()}`
  // WP-353: a stored row streams its saved transcript once (user only); no session/file is a fast 404; a live row is 409
  const db2 = new DatabaseSync(join(root, 'data', 'wt.db'))
  db2.prepare("UPDATE agents SET session = ? WHERE name = ?").run('sess-saved', 'demo-worker-07')
  db2.prepare("INSERT INTO agents (name, state, created_at) VALUES (?, ?, 1)").run('demo-worker-10', 'missing'); db2.close()
  mkdirSync(join(root, '.claude', 'projects', 'p'), { recursive: true })
  writeFileSync(join(root, '.claude', 'projects', 'p', 'sess-saved.jsonl'), JSON.stringify({ type: 'user', uuid: 'a', timestamp: 't', message: { content: 'hello saved' } }) + '\n')
  const stream = (n, h = { cookie }) => fetch(`${base}/api/agents/by-name/${n}/stream?since=0`, { headers: h })
  const ok = await stream('demo-worker-07')
  assert.equal(ok.status, 200)
  const body = await ok.text() // ends by itself: a snapshot, not a live stream
  assert.match(body, /hello saved/); assert.match(body, /event: end/)
  const t0 = Date.now(), none = await stream('demo-worker-10')
  assert.equal(none.status, 404); assert.match((await none.json()).error, /no saved transcript/); assert.ok(Date.now() - t0 < 1500)
  assert.equal((await stream('demo-worker-01')).status, 409)
  assert.equal((await stream('demo-worker-07', pane('t1'))).status, 403)
  assert.equal((await forget('demo-worker-07', { cookie })).status, 200) // the user
})

test('WP-364 forget-stored: the user forgets missing/exited rows and skips live/paused ones; a pane is refused; >200 names is 400', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wt-agents-fs-')), bin = join(root, 'bin')
  mkdirSync(join(root, 'data'), { recursive: true }); mkdirSync(bin); mkdirSync(join(root, 'pane-keys'))
  const hc = await hcStub({ terminals: T(), sessions: { s1: 41, s2: 42 } }); stubs.push(hc)
  const port = 30000 + Math.floor(Math.random() * 20000), base = `http://127.0.0.1:${port}`
  children.push(spawn(process.execPath, ['server.mjs'], { cwd: import.meta.dirname, stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, PORT: String(port), WT_DASHBOARD_DATA: root, HOME: root, ...hc.env } }))
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/api/push`)).ok) break } catch { /* not up yet */ } await new Promise((r) => setTimeout(r, 100)) }
  let first
  for (let i = 0; i < 20; i++) { first = await fetch(`${base}/api/agents`); if (first.status === 200) break; await new Promise((r) => setTimeout(r, 250)) }
  assert.equal(first.status, 200)
  const db = new DatabaseSync(join(root, 'data', 'wt.db'))
  const ins = db.prepare('INSERT INTO agents (name, state, created_at) VALUES (?, ?, 1)')
  ins.run('gone-a', 'missing'); ins.run('gone-b', 'exited'); ins.run('keep-paused', 'paused'); db.close()
  const cookie = `hd_session=${readFileSync(join(root, 'session'), 'utf8').trim()}`
  const post = (names, h = { cookie }) => fetch(`${base}/api/agents/forget-stored`, { method: 'POST', body: JSON.stringify({ names }), headers: { 'content-type': 'application/json', ...h } })
  assert.equal((await post(['gone-a'], { 'x-herdr-pane': 't1' })).status, 403) // a pane
  assert.equal((await post(Array.from({ length: 201 }, (_, i) => `n${i}`))).status, 400)
  const r = await post(['gone-a', 'gone-b', 'keep-paused', 'demo-worker-01', 'nobody'])
  assert.equal(r.status, 200)
  const out = await r.json()
  assert.equal(out.forgot, 2)
  assert.deepEqual(out.skipped.map((s) => s.name).sort(), ['demo-worker-01', 'keep-paused', 'nobody'])
  assert.equal((await fetch(`${base}/api/agents/by-name/gone-a`)).status, 404)
  assert.equal((await fetch(`${base}/api/agents/by-name/keep-paused`)).status, 200)
  assert.equal((await fetch(`${base}/api/agents/by-name/demo-worker-01`)).status, 200)
})
