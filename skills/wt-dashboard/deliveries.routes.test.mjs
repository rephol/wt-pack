// Run: node --test deliveries.routes.test.mjs — WP-272 routes against a real server process (isolated data dir):
// the finish check and the delivery cancel/status are for the pane itself (or the server's own handoff.sh), nobody else.
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let child, base, cookie
const PORT = 30000 + Math.floor(Math.random() * 20000)
before(async () => {
  const root = mkdtempSync(join(tmpdir(), 'wt-delroutes-'))
  mkdirSync(join(root, 'data'), { recursive: true })
  child = spawn(process.execPath, ['server.mjs'], { cwd: import.meta.dirname, stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, PORT: String(PORT), WT_DASHBOARD_DATA: root, HOME: root } })
  base = `http://127.0.0.1:${PORT}`
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/api/push`)).ok) break } catch { /* not up yet */ } await new Promise((r) => setTimeout(r, 100)) }
  cookie = `hd_session=${readFileSync(join(root, 'session'), 'utf8').trim()}`
  await fetch(`${base}/api/rooms`, { headers: { cookie } }) // rooms settings load on first use; a user-authed call before that is a 500
})
after(() => child?.kill())

test('check-finish is the pane\'s own call: no pane id, or the user, is refused', async () => {
  { const r = await fetch(`${base}/api/messages/check-finish`); assert.equal(r.status, 403, await r.text()) }
  { const r = await fetch(`${base}/api/messages/check-finish`, { headers: { cookie } }); assert.equal(r.status, 403, await r.text()) }
})
test('delivery status: needs the user, a pane or the server token (then an unknown id is 404); cancel needs a pane or the server token', async () => {
  assert.equal((await fetch(`${base}/api/deliveries/nope`)).status, 403)
  assert.equal((await fetch(`${base}/api/deliveries/nope`, { headers: { cookie } })).status, 404)
  assert.equal((await fetch(`${base}/api/deliveries/nope/cancel`, { method: 'POST', headers: { cookie } })).status, 403)
  assert.equal((await fetch(`${base}/api/deliveries/nope/cancel`, { method: 'POST' })).status, 403)
})
