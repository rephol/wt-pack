// Run: node --test keepwarm.routes.test.mjs — WP-318 keepwarm routes (a copy of envelope.routes' harness). Was: WP-328: a pane sends fields (kind, body); the server builds the envelope and
// stamps from= with the verified sender. Real server process, isolated data dir, fake herdr with keyed panes w9:p1 (sender)
// and w9:p2 (target). The server-token caller (Dispatch/routines, via handoff.sh) shares the non-pane branch with the user
// (cookie) caller, which stands in for it here: the token itself is random per process.
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const FAKE_HERDR = `#!/usr/bin/env node
const a = process.argv.slice(2).join(' ')
const P = (id, name) => ({ pane_id: id, name, agent_status: 'working', cwd: '/tmp', state_change_seq: 1 })
if (a === 'agent list') console.log(JSON.stringify({ result: { agents: [P('w9:p1', 'demo-worker-01'), P('w9:p2', 'demo-orchestrator-01')] } }))
else if (/^pane get w9:p[12]$/.test(a)) console.log(JSON.stringify({ result: { pane: { pane_id: a.slice(-5) } } }))
else if (a === 'machine list') console.log('')
else process.exit(1)
`
const K1 = 'a'.repeat(64), K2 = 'b'.repeat(64)
let child, base, cookie
const PORT = 30000 + Math.floor(Math.random() * 20000)
const as = (pane, key) => ({ 'x-herdr-pane': pane, 'x-wt-pane-key': key, 'content-type': 'application/json' })
const post = (path, headers, body) => fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body ?? {}) })
const sendP1 = (body) => post('/api/deliveries', as('w9:p1', K1), { pane: 'w9:p2', ...body })
const next = async () => (await (await fetch(`${base}/api/deliveries/next`, { headers: as('w9:p2', K2) })).json())
const rows = async () => (await (await fetch(`${base}/api/messages`, { headers: { cookie } })).json())

before(async () => {
  const root = mkdtempSync(join(tmpdir(), 'wt-kwroutes-'))
  const bin = join(root, 'bin')
  mkdirSync(join(root, 'data'), { recursive: true }); mkdirSync(bin); mkdirSync(join(root, 'pane-keys'))
  writeFileSync(join(bin, 'herdr'), FAKE_HERDR); chmodSync(join(bin, 'herdr'), 0o755)
  writeFileSync(join(root, 'pane-keys', 'w9:p1'), K1); writeFileSync(join(root, 'pane-keys', 'w9:p2'), K2)
  child = spawn(process.execPath, ['server.mjs'], { cwd: import.meta.dirname, stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, PORT: String(PORT), WT_DASHBOARD_DATA: root, HOME: root, PATH: `${bin}:${process.env.PATH}` } })
  base = `http://127.0.0.1:${PORT}`
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/api/push`)).ok) break } catch { /* not up yet */ } await new Promise((r) => setTimeout(r, 100)) }
  cookie = `hd_session=${readFileSync(join(root, 'session'), 'utf8').trim()}`
  await fetch(`${base}/api/rooms`, { headers: { cookie } })
})
after(() => child?.kill())


const user = (path, method, b) => fetch(`${base}${path}`, { method, headers: { cookie, 'content-type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) })
const me = (pane, key, path = '/api/keepwarm/me', method = 'GET', b) => fetch(`${base}${path}`, { method, headers: as(pane, key), body: b === undefined ? undefined : JSON.stringify(b) })

test('settings: GET, PATCH by the user only, bounds are a 400 (windowH 0, 13, 2.5)', async () => {
  const g = await (await user('/api/keepwarm/settings', 'GET')).json()
  assert.equal(g.settings.enabled, false); assert.equal(g.settings.windowH, 3)
  for (const windowH of [0, 13, 2.5]) assert.equal((await user('/api/keepwarm/settings', 'PATCH', { windowH })).status, 400)
  assert.equal((await me('w9:p1', K1, '/api/keepwarm/settings', 'PATCH', { enabled: true })).status, 403) // a pane cannot change the budget
  const ok = await (await user('/api/keepwarm/settings', 'PATCH', { windowH: 6, intervalMin: 45 })).json()
  assert.deepEqual([ok.settings.windowH, ok.settings.intervalMin, ok.settings.enabled], [6, 45, false])
})

test('a pane reads its own config and reports; the user arms and turns it off; a pane cannot arm itself', async () => {
  assert.equal((await (await me('w9:p1', K1)).json()).enabled, false) // global off, no override
  assert.equal((await me('w9:p1', K1, '/api/keepwarm/w9:p1', 'POST', { action: 'arm' })).status, 403)
  assert.equal((await user('/api/keepwarm/w9:p1', 'POST', { action: 'arm', windowH: 13 })).status, 400)
  assert.equal((await user('/api/keepwarm/w9:p9', 'POST', { action: 'arm' })).status, 404)
  assert.equal((await user('/api/keepwarm/w9:p1', 'POST', { action: 'arm', windowH: 5 })).status, 200)
  const cfg = await (await me('w9:p1', K1)).json()
  assert.deepEqual([cfg.enabled, cfg.windowH, cfg.intervalMin, cfg.dailyCap, cfg.pingsToday], [true, 5, 45, 15, 0])
  assert.equal((await me('w9:p1', K1, '/api/keepwarm/me/report', 'POST', { event: 'ping', usage: { read: 1000, write: 20 }, nextAt: 1 })).status, 200)
  assert.equal((await (await me('w9:p1', K1)).json()).pingsToday, 1)
  assert.equal((await me('w9:p1', K1, '/api/keepwarm/me/report', 'POST', { event: 'nap' })).status, 400)
  assert.equal((await user('/api/keepwarm/w9:p1', 'POST', { action: 'off' })).status, 200)
  assert.equal((await (await me('w9:p1', K1)).json()).enabled, false) // the mod sees Off on its next check
  assert.equal((await fetch(`${base}/api/keepwarm/me`)).status, 403) // no pane, no session
})

test('/wt keepwarm off (a stop report with off:true) persists as the user\'s Off until armed again', async () => {
  assert.equal((await user('/api/keepwarm/w9:p1', 'POST', { action: 'arm' })).status, 200)
  assert.equal((await me('w9:p1', K1, '/api/keepwarm/me/report', 'POST', { event: 'stop', off: true, reason: 'turned off' })).status, 200)
  const c = await (await me('w9:p1', K1)).json()
  assert.deepEqual([c.enabled, c.state], [false, 'off'])
})
