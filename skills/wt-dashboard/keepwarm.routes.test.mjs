// Run: node --test keepwarm.routes.test.mjs — WP-318 keepwarm routes (a copy of envelope.routes' harness). Was: WP-328: a pane sends fields (kind, body); the server builds the envelope and
// stamps from= with the verified sender. Real server process, isolated data dir, fake herdr with keyed panes t1 (sender)
// and t2 (target). The server-token caller (Dispatch/routines, via handoff.sh) shares the non-pane branch with the user
// (cookie) caller, which stands in for it here: the token itself is random per process.
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hcStub, terminal } from './test-hc.mjs'

// WP-378: the agents are terminals of a stubbed hc core (test-hc.mjs)
const T = () => [
  terminal({ address: 't1', name: 'demo-worker-01', status: 'working', cwd: '/tmp', labels: {}, pid: 41, foreground: { name: '2.1', argv: ['claude'], cwd: '/tmp', pid: 41 } }),
  terminal({ address: 't2', name: 'demo-orchestrator-01', status: 'working', cwd: '/tmp', labels: {}, pid: 42, foreground: { name: '2.1', argv: ['claude'], cwd: '/tmp', pid: 42 } }),
]
const K1 = 'a'.repeat(64), K2 = 'b'.repeat(64)
let hc, child, base, cookie, root
const PORT = 30000 + Math.floor(Math.random() * 20000)
const as = (pane, key) => ({ 'x-herdr-pane': pane, 'x-wt-pane-key': key, 'content-type': 'application/json' })
const post = (path, headers, body) => fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body ?? {}) })
const sendP1 = (body) => post('/api/deliveries', as('t1', K1), { pane: 't2', ...body })
const next = async () => (await (await fetch(`${base}/api/deliveries/next`, { headers: as('t2', K2) })).json())
const rows = async () => (await (await fetch(`${base}/api/messages`, { headers: { cookie } })).json())

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'wt-kwroutes-'))
  const bin = join(root, 'bin')
  mkdirSync(join(root, 'data'), { recursive: true }); mkdirSync(bin); mkdirSync(join(root, 'pane-keys'))
  hc = await hcStub({ terminals: T() })
  writeFileSync(join(root, 'pane-keys', 't1'), K1); writeFileSync(join(root, 'pane-keys', 't2'), K2)
  child = spawn(process.execPath, ['server.mjs'], { cwd: import.meta.dirname, stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, PORT: String(PORT), WT_DASHBOARD_DATA: root, HOME: root, ...hc.env } })
  base = `http://127.0.0.1:${PORT}`
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/api/push`)).ok) break } catch { /* not up yet */ } await new Promise((r) => setTimeout(r, 100)) }
  cookie = `hd_session=${readFileSync(join(root, 'session'), 'utf8').trim()}`
  await fetch(`${base}/api/rooms`, { headers: { cookie } })
})
after(async () => { child?.kill(); await hc?.close() })


const user = (path, method, b) => fetch(`${base}${path}`, { method, headers: { cookie, 'content-type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) })
const me = (pane, key, path = '/api/keepwarm/me', method = 'GET', b) => fetch(`${base}${path}`, { method, headers: as(pane, key), body: b === undefined ? undefined : JSON.stringify(b) })

test('settings: GET, PATCH by the user only, bounds are a 400 (windowH 0, 13, 2.5)', async () => {
  const g = await (await user('/api/keepwarm/settings', 'GET')).json()
  assert.equal(g.settings.enabled, false); assert.equal(g.settings.windowH, 3)
  for (const windowH of [0, 13, 2.5]) assert.equal((await user('/api/keepwarm/settings', 'PATCH', { windowH })).status, 400)
  assert.equal((await me('t1', K1, '/api/keepwarm/settings', 'PATCH', { enabled: true })).status, 403) // a pane cannot change the budget
  const ok = await (await user('/api/keepwarm/settings', 'PATCH', { windowH: 6, intervalMin: 45 })).json()
  assert.deepEqual([ok.settings.windowH, ok.settings.intervalMin, ok.settings.enabled], [6, 45, false])
})

test('a pane reads its own config and reports; the user arms and turns it off; a pane cannot arm itself', async () => {
  assert.equal((await (await me('t1', K1)).json()).enabled, false) // global off, no override
  assert.equal((await me('t1', K1, '/api/keepwarm/t1', 'POST', { action: 'arm' })).status, 403)
  assert.equal((await user('/api/keepwarm/t1', 'POST', { action: 'arm', windowH: 13 })).status, 400)
  assert.equal((await user('/api/keepwarm/t9', 'POST', { action: 'arm' })).status, 404)
  assert.equal((await user('/api/keepwarm/t1', 'POST', { action: 'arm', windowH: 5 })).status, 200)
  const cfg = await (await me('t1', K1)).json()
  assert.deepEqual([cfg.enabled, cfg.windowH, cfg.intervalMin, cfg.dailyCap, cfg.pingsToday], [true, 5, 45, 15, 0])
  assert.equal((await me('t1', K1, '/api/keepwarm/me/report', 'POST', { event: 'ping', usage: { read: 1000, write: 20 }, nextAt: 1 })).status, 200)
  assert.equal((await (await me('t1', K1)).json()).pingsToday, 1)
  assert.equal((await me('t1', K1, '/api/keepwarm/me/report', 'POST', { event: 'nap' })).status, 400)
  assert.equal((await user('/api/keepwarm/t1', 'POST', { action: 'off' })).status, 200)
  assert.equal((await (await me('t1', K1)).json()).enabled, false) // the mod sees Off on its next check
  assert.equal((await fetch(`${base}/api/keepwarm/me`)).status, 403) // no pane, no session
})

test('/wt keepwarm off (a stop report with off:true) persists as the user\'s Off until armed again', async () => {
  assert.equal((await user('/api/keepwarm/t1', 'POST', { action: 'arm' })).status, 200)
  assert.equal((await me('t1', K1, '/api/keepwarm/me/report', 'POST', { event: 'stop', off: true, reason: 'turned off' })).status, 200)
  const c = await (await me('t1', K1)).json()
  assert.deepEqual([c.enabled, c.state], [false, 'off'])
})

test('WP-358: the user turns an agent off then arms it again: the agent\'s keepwarm state leaves off, and keepwarm.json says armed', async () => {
  const state = async () => (await (await user('/api/agents', 'GET')).json()).find((a) => a.id === 't1').info?.keepwarm
  assert.equal((await user('/api/keepwarm/t1', 'POST', { action: 'off' })).status, 200)
  assert.equal((await state())?.state, 'off')
  assert.equal((await user('/api/keepwarm/t1', 'POST', { action: 'arm' })).status, 200)
  assert.notEqual((await state())?.state, 'off')
  const ov = JSON.parse(readFileSync(join(root, 'data', 'keepwarm.json'), 'utf8')).overrides
  assert.equal((ov['demo-worker-01'] ?? ov['t1'])?.armed, true) // keyed by agent name once the agents table has the row, else by pane
})

test('WP-358: /wt keepwarm on (an arm report) undoes /wt keepwarm off for that pane only; no pane key is refused', async () => {
  assert.equal((await me('t1', K1, '/api/keepwarm/me/report', 'POST', { event: 'stop', off: true, reason: 'turned off' })).status, 200)
  assert.deepEqual(await me('t1', K1).then((r) => r.json()).then((c) => [c.enabled, c.state]), [false, 'off'])
  assert.equal((await me('t1', 'c'.repeat(64), '/api/keepwarm/me/report', 'POST', { event: 'arm' })).status, 403) // wrong key
  assert.equal((await fetch(`${base}/api/keepwarm/me/report`, { method: 'POST', headers: { 'x-herdr-pane': 't1', 'content-type': 'application/json' }, body: '{"event":"arm"}' })).status, 403) // no key
  assert.deepEqual(await me('t1', K1).then((r) => r.json()).then((c) => [c.enabled, c.state]), [false, 'off']) // still off
  assert.equal((await me('t1', K1, '/api/keepwarm/me/report', 'POST', { event: 'arm' })).status, 200)
  assert.deepEqual(await me('t1', K1).then((r) => r.json()).then((c) => [c.enabled, c.state]), [true, 'cold'])
  assert.equal((await me('t2', K2).then((r) => r.json())).enabled, false) // the other pane was not armed
})
