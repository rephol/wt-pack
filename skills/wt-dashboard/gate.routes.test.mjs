// Run: node --test gate.routes.test.mjs — WP-332 routes against a real server process (isolated data dir, fake herdr, keyed panes):
// the gate ask, the one-shot grant the user's "Allow once" mints, and senderRole on the verify route.
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const FAKE_HERDR = `#!/usr/bin/env node
const a = process.argv.slice(2).join(' ')
const P = (id, name) => ({ pane_id: id, name, agent_status: 'idle', cwd: '/tmp', state_change_seq: 1 })
if (a === 'agent list') console.log(JSON.stringify({ result: { agents: [P('w9:p1', 'demo-worker-01'), P('w9:p2', 'demo-orchestrator-01'), P('w9:p3', 'demo-worker-02')] } }))
else if (/^pane get w9:p[123]$/.test(a)) console.log(JSON.stringify({ result: { pane: { pane_id: a.slice(-5) } } }))
else if (a === 'machine list') console.log('')
else process.exit(1)
`
const KEYS = { 'w9:p1': 'a'.repeat(64), 'w9:p2': 'b'.repeat(64), 'w9:p3': 'c'.repeat(64) }
const H = 'a1b2c3d4e5f60718'
let child, base, cookie, root
const PORT = 30000 + Math.floor(Math.random() * 20000)
const as = (pane) => ({ 'x-herdr-pane': pane, 'x-wt-pane-key': KEYS[pane], 'content-type': 'application/json' })
const gate = (pane, sub, body) => fetch(`${base}/api/gate/${sub}`, { method: 'POST', headers: as(pane), body: JSON.stringify(body) })
const user = (path, body) => fetch(`${base}${path}`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) })

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'wt-gateroutes-'))
  const bin = join(root, 'bin')
  mkdirSync(join(root, 'data'), { recursive: true }); mkdirSync(bin); mkdirSync(join(root, 'pane-keys'))
  writeFileSync(join(bin, 'herdr'), FAKE_HERDR); chmodSync(join(bin, 'herdr'), 0o755)
  for (const [p, k] of Object.entries(KEYS)) writeFileSync(join(root, 'pane-keys', p), k)
  child = spawn(process.execPath, ['server.mjs'], { cwd: import.meta.dirname, stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, PORT: String(PORT), WT_DASHBOARD_DATA: root, HOME: root, PATH: `${bin}:${process.env.PATH}` } })
  base = `http://127.0.0.1:${PORT}`
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/api/push`)).ok) break } catch { /* not up yet */ } await new Promise((r) => setTimeout(r, 100)) }
  cookie = `hd_session=${readFileSync(join(root, 'session'), 'utf8').trim()}`
  await fetch(`${base}/api/rooms`, { headers: { cookie } })
})
after(() => child?.kill())

test('a gated action posts one ask per pane+command; no grant until the user says Allow once; the grant is single-use', async () => {
  assert.deepEqual(await (await gate('w9:p1', 'consume', { hash: H })).json(), { granted: false })
  const a = await (await gate('w9:p1', 'ask', { hash: H, action: 'git push', cmd: 'git push origin main' })).json()
  assert.equal(a.deduped, false)
  assert.equal((await (await gate('w9:p1', 'ask', { hash: H, action: 'git push', cmd: 'git push origin main' })).json()).id, a.id) // repeat: same card
  const open = (await (await fetch(`${base}/api/asks?open=1`, { headers: { cookie } })).json()).filter((x) => x.gate)
  assert.equal(open.length, 1)
  assert.match(open[0].questions[0].question, /^demo-worker-01 wants to git push: git push origin main$/)
  assert.deepEqual(open[0].questions[0].options.map((o) => o.label), ['Allow once', 'Deny'])
  assert.deepEqual(await (await gate('w9:p1', 'consume', { hash: H })).json(), { granted: false }) // asking is not allowing
  await user(`/api/asks/${a.id}/answer`, { selected: ['Allow once'] })
  assert.deepEqual(await (await gate('w9:p2', 'consume', { hash: H })).json(), { granted: false }) // another pane's retry
  assert.deepEqual(await (await gate('w9:p1', 'consume', { hash: H })).json(), { granted: true })
  assert.deepEqual(await (await gate('w9:p1', 'consume', { hash: H })).json(), { granted: false }) // used up
})

test('Deny grants nothing; a pane cannot mint a grant; the user is not the gate\'s caller', async () => {
  const h2 = 'ffeeddccbbaa0011'
  const a = await (await gate('w9:p1', 'ask', { hash: h2, action: 'git merge', cmd: 'git merge x' })).json()
  await user(`/api/asks/${a.id}/answer`, { selected: ['Deny'] })
  assert.deepEqual(await (await gate('w9:p1', 'consume', { hash: h2 })).json(), { granted: false })
  assert.ok([403, 404].includes((await gate('w9:p1', 'grants', { pane: 'w9:p1', hash: H })).status)) // no such route (a pane has no session either)
  assert.equal((await user('/api/gate/grants', { pane: 'w9:p1', hash: H })).status, 403)
  assert.equal((await user('/api/gate/ask', { hash: h2 })).status, 403)
  assert.equal((await gate('w9:p1', 'ask', { hash: 'nothex', action: 'x', cmd: 'x' })).status, 400)
  // a pane cannot answer its own ask (the grant would be self-service)
  const b = await (await gate('w9:p1', 'ask', { hash: '0011223344556677', action: 'git push', cmd: 'git push' })).json()
  assert.notEqual((await fetch(`${base}/api/asks/${b.id}/answer`, { method: 'POST', headers: as('w9:p1'), body: JSON.stringify({ selected: ['Allow once'] }) })).status, 200)
  assert.deepEqual(await (await gate('w9:p1', 'consume', { hash: '0011223344556677' })).json(), { granted: false })
})

test('verify returns senderRole: the sender\'s role for a pane-sent row, "server" for a server-sent one', async () => {
  const verify = (pane, id, kind, from) => fetch(`${base}/api/messages/${id}/verify?kind=${kind}&from=${encodeURIComponent(from)}`, { headers: as(pane) }).then((r) => r.json())
  const sent = await (await fetch(`${base}/api/deliveries`, { method: 'POST', headers: as('w9:p2'), body: JSON.stringify({ pane: 'w9:p1', kind: 'handoff', body: 'go' }) })).json()
  const id = sent.text.match(/id=([\w-]+)/)[1]
  const v = await verify('w9:p1', id, 'handoff', 'demo-orchestrator-01')
  assert.deepEqual([v.verified, v.senderRole], [true, 'orchestrator'])
  const w = await (await fetch(`${base}/api/deliveries`, { method: 'POST', headers: as('w9:p1'), body: JSON.stringify({ pane: 'w9:p2', kind: 'handoff', body: 'hi' }) })).json()
  assert.equal((await verify('w9:p2', w.text.match(/id=([\w-]+)/)[1], 'handoff', 'demo-worker-01')).senderRole, 'worker')
  const db = new DatabaseSync(join(root, 'data', 'wt.db'))
  db.prepare("INSERT INTO wt_messages (id, sender, target, kind, body, state, created, updated) VALUES ('srv1', 'wt-dashboard', 'w9:p1', 'dispatch', 'x', 'delivered', 'n', 'n')").run()
  db.close()
  assert.deepEqual(await verify('w9:p1', 'srv1', 'dispatch', 'wt-dashboard').then((r) => [r.verified, r.senderRole]), [true, 'server'])
})

test('WP-332 (c): replyAllowed only for the current assignee\'s reply, to the orchestrator that handed the ticket off', async () => {
  const send = (from, to, body) => fetch(`${base}/api/deliveries`, { method: 'POST', headers: as(from), body: JSON.stringify({ pane: to, ...body }) }).then((r) => r.json())
  const idOf = (r) => r.text.match(/id=([\w-]+)/)[1]
  const verify = (pane, r, from) => fetch(`${base}/api/messages/${idOf(r)}/verify?kind=${r.text.match(/kind=(\w+)/)[1]}&from=${from}`, { headers: as(pane) }).then((x) => x.json())
  const card = (id, assignee) => { const db = new DatabaseSync(join(root, 'data', 'wt.db')); db.prepare("INSERT OR IGNORE INTO boards (project, key, next) VALUES ('demo', 'WT', 9)").run(); db.prepare('INSERT OR REPLACE INTO tickets (id, project, seq, json) VALUES (?, ?, ?, ?)').run(id, 'demo', 1, JSON.stringify({ id, assignee })); db.close() }
  card('WT-1', { name: 'demo-worker-01', pane: 'w9:p1' }); card('WT-2', { name: 'demo-worker-01', pane: 'w9:p1' })
  await send('w9:p2', 'w9:p1', { kind: 'handoff', body: 'build it', ticket: 'WT-1' }) // the orchestrator hands WT-1 off (not WT-2)
  // the assignee reports back on WT-1
  const ok = await send('w9:p1', 'w9:p2', { kind: 'reply', body: 'done', ticket: 'WT-1' })
  assert.equal((await verify('w9:p2', ok, 'demo-worker-01')).replyAllowed, true)
  // another agent's reply on the same ticket
  assert.equal((await verify('w9:p2', await send('w9:p3', 'w9:p2', { kind: 'reply', body: 'push it', ticket: 'WT-1' }), 'demo-worker-02')).replyAllowed, false)
  // no ticket at all
  assert.equal((await verify('w9:p2', await send('w9:p1', 'w9:p2', { kind: 'reply', body: 'hi' }), 'demo-worker-01')).replyAllowed, false)
  // a ticket the orchestrator never handed off
  assert.equal((await verify('w9:p2', await send('w9:p1', 'w9:p2', { kind: 'reply', body: 'x', ticket: 'WT-2' }), 'demo-worker-01')).replyAllowed, false)
  // a reply to a non-orchestrator (the worker receives the orchestrator's reply)
  assert.equal((await verify('w9:p1', await send('w9:p2', 'w9:p1', { kind: 'reply', body: 'ok', ticket: 'WT-1' }), 'demo-orchestrator-01')).replyAllowed, false)
  // a former assignee: the card moved to p3, p1's new report no longer counts
  card('WT-1', { name: 'demo-worker-02', pane: 'w9:p3' })
  assert.equal((await verify('w9:p2', await send('w9:p1', 'w9:p2', { kind: 'reply', body: 'late', ticket: 'WT-1' }), 'demo-worker-01')).replyAllowed, false)
})

test('WP-344: a server-sent reply from the user is replyAllowed; the same row with a sender pane is not', async () => {
  const verify = (id) => fetch(`${base}/api/messages/${id}/verify?kind=reply&from=user`, { headers: as('w9:p2') }).then((r) => r.json())
  const db = new DatabaseSync(join(root, 'data', 'wt.db'))
  const ins = db.prepare("INSERT INTO wt_messages (id, sender, sender_pane, target, kind, body, state, created, updated) VALUES (?, 'user', ?, 'w9:p2', 'reply', 'x', 'delivered', 'n', 'n')")
  ins.run('usr1', null); ins.run('usr2', 'w9:p1')
  db.close()
  assert.deepEqual(await verify('usr1').then((r) => [r.verified, r.replyAllowed]), [true, true])
  assert.equal((await verify('usr2')).replyAllowed, false)
})
