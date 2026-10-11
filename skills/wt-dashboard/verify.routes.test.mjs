// Run: node --test verify.routes.test.mjs — WP-329: GET /api/messages/:id/verify tells a pane whether the server recorded that
// envelope for it; a failure raises one Inbox card. Real server process, isolated data dir, fake herdr, keyed panes w9:p1/p2/p3.
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const FAKE_HERDR = `#!/usr/bin/env node
const a = process.argv.slice(2).join(' ')
const P = (id, name) => ({ pane_id: id, name, agent_status: 'idle', cwd: '/tmp', state_change_seq: 1 })
if (a === 'agent list') console.log(JSON.stringify({ result: { agents: [P('w9:p1', 'demo-worker-01'), P('w9:p2', 'demo-orchestrator-01'), P('w9:p3', 'demo-worker-02'), P('w9:p4', 'demo-flooder')] } }))
else if (/^pane get w9:p[1234]$/.test(a)) console.log(JSON.stringify({ result: { pane: { pane_id: a.slice(-5) } } }))
else if (a === 'machine list') console.log('')
else process.exit(1)
`
const KEYS = { 'w9:p1': 'a'.repeat(64), 'w9:p2': 'b'.repeat(64), 'w9:p3': 'c'.repeat(64), 'w9:p4': 'd'.repeat(64) }
let child, base, cookie
const PORT = 30000 + Math.floor(Math.random() * 20000)
const as = (pane) => ({ 'x-herdr-pane': pane, 'x-wt-pane-key': KEYS[pane], 'content-type': 'application/json' })
const send = (from, to, body) => fetch(`${base}/api/deliveries`, { method: 'POST', headers: as(from), body: JSON.stringify({ pane: to, ...body }) }).then((r) => r.json())
const verify = (pane, id, kind, from) => fetch(`${base}/api/messages/${id}/verify?kind=${kind}&from=${encodeURIComponent(from)}`, { headers: as(pane) })
const cards = async () => (await (await fetch(`${base}/api/notifications`, { headers: { cookie } })).json()).items.filter((i) => /^unverified\|/.test(i.key))

before(async () => {
  const root = mkdtempSync(join(tmpdir(), 'wt-verify-'))
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

test('a pane-sent handoff verifies for its target only; sender pane comes from the store', async () => {
  const r = await send('w9:p1', 'w9:p2', { kind: 'handoff', body: 'go', ticket: 'WP-1' })
  const id = r.text.match(/id=([\w-]+)/)[1]
  const ok = await (await verify('w9:p2', id, 'handoff', 'demo-worker-01')).json()
  assert.deepEqual(ok, { verified: true, sender: 'demo-worker-01', senderPane: 'w9:p1', senderRole: 'worker', kind: 'handoff', ticket: 'WP-1', replyAllowed: false })
  assert.deepEqual(await (await verify('w9:p3', id, 'handoff', 'demo-worker-01')).json(), { verified: false, reason: 'not addressed to you' })
  assert.equal((await verify('w9:p2', id, 'reply', 'demo-worker-01').then((x) => x.json())).reason, 'kind mismatch')
  assert.equal((await verify('w9:p2', id, 'handoff', 'someone-else').then((x) => x.json())).reason, 'sender mismatch')
})

test('a forged id is unverified and raises exactly one Inbox card, however often it is tried', async () => {
  for (let i = 0; i < 3; i++) assert.deepEqual(await (await verify('w9:p2', 'nope1', 'handoff', 'x')).json(), { verified: false, reason: 'unknown id' })
  const c = (await cards()).filter((i) => i.key === 'unverified|w9:p2|nope1')
  assert.equal(c.length, 1)
  assert.equal(c[0].title, 'Unverified message to demo-orchestrator-01')
  assert.match(c[0].body, /unknown id/)
})

test('WP-333: 20 forged ids from one pane raise 3 cards + 1 summary card; another pane still gets its own', async () => {
  for (let i = 0; i < 20; i++) await verify('w9:p4', `forged${i}`, 'handoff', 'x')
  const all = async () => (await (await fetch(`${base}/api/notifications`, { headers: { cookie } })).json()).items
  const mine = (await all()).filter((i) => /^unverified(-flood)?\|w9:p4\|/.test(i.key))
  assert.equal(mine.filter((i) => i.key.startsWith('unverified|')).length, 3)
  const flood = mine.filter((i) => i.key.startsWith('unverified-flood|'))
  assert.equal(flood.length, 1)
  assert.match(flood[0].body, /sent 20 unverified messages/)
  await verify('w9:p1', 'forged-other', 'handoff', 'x')
  assert.equal((await all()).filter((i) => i.key === 'unverified|w9:p1|forged-other').length, 1)
})

test('only a pane may ask: the user and an unkeyed caller are refused', async () => {
  assert.equal((await fetch(`${base}/api/messages/x/verify?kind=handoff&from=x`, { headers: { cookie } })).status, 403)
  assert.equal((await fetch(`${base}/api/messages/x/verify?kind=handoff&from=x`)).status, 403)
})

test('every producer leaves a verifiable row: check-finish nudge, the Ready nudge path and a spawn first prompt record via deliver()', async () => {
  // the server-side producers all funnel through deliver()/messages.record with the delivered envelope (see server.mjs);
  // the pane producer is covered above and the token producers (Dispatch, handoff.sh) by handoff.test.mjs. Here: the funnel.
  const src = readFileSync(join(import.meta.dirname, 'server.mjs'), 'utf8')
  assert.match(src, /await deliver\(\{ id: pane \}, first,/) // spawn first prompt
  assert.match(src, /await deliver\(a, nudge,/) // Ready nudge
  assert.match(src, /msgSafe\(\(\) => messages\.record\(\{ \.\.\.env, target: pane, body: text \}\)\)/) // check-finish
})
