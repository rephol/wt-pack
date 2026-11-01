// Run: node --test hc.routes.test.mjs — WP-378 U5: the dashboard's read side on a stubbed hc core (test-hc.mjs; rows are recorded
// terminal.list rows). Real server process, isolated data dir. Covers the agent listing (states, exited/kept shells, sessions), the
// label sync (a kept shell is never written to), the core-down gate (nothing is run that would START a stopped core: hc connect,
// ls, get and server status all do, recorded in test-fixtures/hc-starts-stopped-core.json), the core-identity drop and DND labels.
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { hcStub, terminal, shell, finished } from './test-hc.mjs'

let hc, child, base, cookie, root
const PORT = 30000 + Math.floor(Math.random() * 20000)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (f, what, ms = 8000) => { for (let t = 0; t < ms; t += 100) { const v = await f(); if (v) return v; await wait(100) } assert.fail(`timed out: ${what}`) }
const agentsList = async () => (await fetch(`${base}/api/agents`, { headers: { cookie } })).json()
const labelCalls = () => hc.calls().filter((c) => c.args[0] === 'label').map((c) => c.args.slice(2))
const claudeAt = (n, name, status, labels = {}) => terminal({ address: `t${n}`, name, status, cwd: '/tmp', labels, pid: 40 + n, foreground: { name: '2.1', argv: ['claude'], cwd: '/tmp', pid: 40 + n } })

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'wt-hcroutes-'))
  mkdirSync(join(root, 'data'), { recursive: true }); mkdirSync(join(root, 'pane-keys'))
  writeFileSync(join(root, 'pane-keys', 't1'), 'a'.repeat(64)); writeFileSync(join(root, 'pane-keys', 't2'), 'b'.repeat(64))
  hc = await hcStub({
    sessions: { s1: 41, s2: 42 },
    terminals: [
      claudeAt(1, 'demo-worker-01', 'idle', { role: 'worker', 'wt.pool': 'demo-workers' }),
      claudeAt(2, 'demo-worker-02', 'working'), // no labels yet: the sync writes them
      shell({ address: 't3', name: 'demo-worker-03' }), // a kept login shell at an agent's address (S5-8)
      finished({ address: 't4', name: 'demo-worker-04' }),
      shell({ address: 't5', name: 'my-own-shell' }), // somebody's terminal
    ],
  })
  // the pack knows 03 and 04 (agents table), so they list as exited rather than not at all
  const boot = new DatabaseSync(join(root, 'data', 'wt.db'))
  boot.close()
  child = spawn(process.execPath, ['server.mjs'], { cwd: import.meta.dirname, stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, PORT: String(PORT), WT_DASHBOARD_DATA: root, HOME: root, WT_HC_CORE_PROBE_MS: '200', ...hc.env } })
  base = `http://127.0.0.1:${PORT}`
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/api/push`)).ok) break } catch { /* not up yet */ } await wait(100) }
  cookie = `hd_session=${readFileSync(join(root, 'session'), 'utf8').trim()}`
  await until(async () => (await fetch(`${base}/api/agents`, { headers: { cookie } })).status === 200, 'server up')
  const db = new DatabaseSync(join(root, 'data', 'wt.db'))
  const ins = db.prepare("INSERT OR IGNORE INTO agents (name, state, created_at) VALUES (?, 'idle', 1)")
  ins.run('demo-worker-03'); ins.run('demo-worker-04'); db.close()
  await wait(3200) // past the 3 s listing cache: the next /api/agents sees the seeded names
})
after(async () => { child?.kill(); await hc?.close() })

test('the listing: states from the reported status, sessions from claude agents, the pool as role fallback; a kept shell and a finished agent are exited; a stranger\'s shell is absent', async () => {
  const list = await agentsList()
  const by = Object.fromEntries(list.map((a) => [a.name, a]))
  assert.deepEqual(['demo-worker-01', 'demo-worker-02', 'demo-worker-03', 'demo-worker-04'].map((n) => by[n]?.status), ['idle', 'working', 'exited', 'exited'])
  assert.ok(!by['my-own-shell'], 'a terminal the pack does not know is not an agent')
  assert.equal(by['demo-worker-01'].id, 't1'); assert.equal(by['demo-worker-01'].session, 's1'); assert.equal(by['demo-worker-02'].session, 's2')
  assert.equal(by['demo-worker-01'].workspace, 'demo-workers'); assert.equal(by['demo-worker-01'].pool, 'worker')
})

test('one hc call serves a refresh: repeated listings inside the cache add at most one connect', async () => {
  await wait(3200)
  const before = hc.calls().filter((c) => c.args[0] === 'connect').length
  for (let i = 0; i < 4; i++) await agentsList()
  assert.ok(hc.calls().filter((c) => c.args[0] === 'connect').length - before <= 1)
})

test('label sync writes the row\'s tags to a live agent and never to an exited one (a kept shell lost its labels)', async () => {
  await until(() => labelCalls().some((a) => a[0] === 't2' && a.includes('role=worker')), 'labels written to t2')
  assert.ok(!labelCalls().some((a) => a[0] === 't3' || a[0] === 't4'), 'no label call on an exited terminal')
  assert.ok(!hc.calls().some((c) => c.args[0] === 'send' || c.args[0] === 'keys'), 'nothing is typed by a read')
})

test('DND is a label: on writes dnd=1, off clears it', async () => {
  const post = (body) => fetch(`${base}/api/agents/${hostname()}/t1/dnd`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const n = labelCalls().length
  assert.equal((await post({ on: true })).status, 200)
  assert.deepEqual(labelCalls().slice(n).at(-1), ['t1', 'dnd=1'])
  assert.equal((await post({ on: false })).status, 200)
  assert.deepEqual(labelCalls().at(-1), ['t1', 'dnd='])
})

test('core down: nothing that starts a core is run, the agents list still answers (stored rows), the banner says so; back up it recovers', async () => {
  await hc.down()
  await wait(1200) // the server's coreUp answer is cached for 1 s
  const mark = hc.calls().length
  const r = await fetch(`${base}/api/agents`, { headers: { cookie } })
  assert.equal(r.status, 200)
  assert.ok((await r.json()).some((a) => a.name === 'demo-worker-04'), 'stored rows still list')
  // the overview itself is cached 3 s and refreshed by the server's own 4 s tick: poll until it has seen the core go
  await until(async () => /hc core not running/.test(((await (await fetch(`${base}/api/overview`, { headers: { cookie } })).json()).sourceIssues ?? []).join('|')), 'the banner names the stopped core')
  const after = hc.calls().slice(mark).filter((c) => ['connect', 'ls', 'get', 'server'].includes(c.args[0]))
  assert.deepEqual(after, [], 'hc connect/ls/get/server status each start a stopped core')
  await hc.up()
  await wait(1200)
  await until(async () => (await agentsList()).some((a) => a.name === 'demo-worker-01' && a.status === 'idle'), 'agents back after the core returns')
})

test('a different core id drops the agents table rows and every pane key; the same id does not', async () => {
  assert.ok(existsSync(join(root, 'pane-keys', 't1')))
  assert.equal((await fetch(`${base}/api/agents/by-name/demo-worker-04`)).status, 200)
  await until(() => existsSync(join(root, 'data', 'hc-core.json')), 'first core id stored')
  await wait(400); await agentsList() // a second probe with the same id: nothing is dropped
  assert.ok(existsSync(join(root, 'pane-keys', 't1')))
  // WP-378 F5: a paused row (Resume needs its session and cwd) and a missing row that carries a session survive; only their addresses go
  { const db = new DatabaseSync(join(root, 'data', 'wt.db'))
    db.prepare("INSERT OR REPLACE INTO agents (name, role, cwd, session, pane, stable_pane, state, paused_at, created_at) VALUES ('demo-paused', 'worker', '/tmp/p', 'sess-p', 't77', 't77', 'paused', 5, 1)").run()
    db.prepare("INSERT OR REPLACE INTO agents (name, role, cwd, session, pane, state, created_at) VALUES ('demo-missing', 'worker', '/tmp/m', 'sess-m', 't78', 'missing', 1)").run()
    db.prepare("INSERT OR REPLACE INTO agents (name, role, cwd, pane, state, created_at) VALUES ('demo-nosess', 'worker', '/tmp/n', 't79', 'missing', 1)").run(); db.close() }
  hc.core({ id: 'core-b', name: 'host' })
  await until(async () => { await agentsList(); return !existsSync(join(root, 'pane-keys', 't1')) }, 'pane keys dropped for the new core')
  assert.ok(!existsSync(join(root, 'pane-keys', 't2')))
  assert.equal((await fetch(`${base}/api/agents/by-name/demo-worker-04`)).status, 404, 'the old core\'s exited row is gone')
  { const db = new DatabaseSync(join(root, 'data', 'wt.db'))
    const row = (n) => db.prepare('SELECT name, cwd, session, pane, stable_pane, state, paused_at FROM agents WHERE name = ?').get(n)
    assert.deepEqual({ ...row('demo-paused') }, { name: 'demo-paused', cwd: '/tmp/p', session: 'sess-p', pane: null, stable_pane: null, state: 'paused', paused_at: 5 }, 'a paused row keeps session and cwd, loses its address')
    assert.deepEqual({ ...row('demo-missing') }, { name: 'demo-missing', cwd: '/tmp/m', session: 'sess-m', pane: null, stable_pane: null, state: 'missing', paused_at: null })
    assert.equal(row('demo-nosess'), undefined, 'a row with nothing to resume is dropped (D14)'); db.close() }
  assert.equal((await fetch(`${base}/api/agents/by-name/demo-worker-01`)).status, 200, 'live agents are re-registered by the watcher')
})
