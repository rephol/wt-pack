// Run: node --test pins.routes.test.mjs — WP-273 routes against a real server process (isolated data dir): mutations need the
// dashboard session (an agent pane is refused), changes reach other clients through /api/changes, `room read` marks pins.
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let child, base, cookie
const PORT = 30000 + Math.floor(Math.random() * 20000)
const call = (path, { method = 'GET', body, auth = true, headers = {} } = {}) =>
  fetch(`${base}${path}`, { method, headers: { ...(auth ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined })
before(async () => {
  const root = mkdtempSync(join(tmpdir(), 'wt-pinroutes-'))
  mkdirSync(join(root, 'data'), { recursive: true })
  child = spawn(process.execPath, ['server.mjs'], { cwd: import.meta.dirname, stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, PORT: String(PORT), WT_DASHBOARD_DATA: root, HOME: root } })
  base = `http://127.0.0.1:${PORT}`
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/api/push`)).ok) break } catch { /* not up yet */ } await new Promise((r) => setTimeout(r, 100)) }
  cookie = `hd_session=${readFileSync(join(root, 'session'), 'utf8').trim()}`
  await call('/api/rooms') // rooms settings load on first use
})
after(() => child?.kill())

test('mutations are the dashboard user\'s: no cookie, or an agent pane header alone, is refused; reads are open', async () => {
  const b = { chat: 'room:x', msg: 'm1', text: 'hi' }
  assert.equal((await call('/api/pins', { method: 'POST', body: b, auth: false })).status, 403)
  assert.equal((await call('/api/pins', { method: 'POST', body: b, auth: false, headers: { 'x-herdr-pane': 'w1:p1' } })).status, 403)
  assert.equal((await call('/api/bookmarks', { method: 'POST', body: b, auth: false, headers: { 'x-herdr-pane': 'w1:p1' } })).status, 403)
  assert.equal((await call('/api/pins?chat=room:x', { auth: false })).status, 200)
  assert.equal((await call('/api/pins', { method: 'POST', body: { chat: 'bad', msg: 'm' } })).status, 400)
})

test('pin, list, unpin; the change stream announces it', async () => {
  const ev = await fetch(`${base}/api/changes`, { headers: { cookie } })
  const reader = ev.body.getReader()
  const seen = (async () => { let s = ''; for (;;) { const { value, done } = await reader.read(); if (done) return s; s += Buffer.from(value).toString(); if (/"topic":"pins"/.test(s)) return s } })()
  assert.equal((await call('/api/pins', { method: 'POST', body: { chat: 'room:x', msg: 'm1', text: 'ship it', author: 'ann' } })).status, 200)
  assert.match(await seen, /"topic":"pins","chat":"room:x"/)
  await reader.cancel()
  const list = await (await call('/api/pins?chat=room:x')).json()
  assert.equal(list.length, 1); assert.equal(list[0].text, 'ship it')
  assert.equal((await call('/api/pins?chat=room:x&msg=m1', { method: 'DELETE' })).status, 200)
  assert.deepEqual(await (await call('/api/pins?chat=room:x')).json(), [])
})

test('bookmarks: save, search, remove', async () => {
  await call('/api/bookmarks', { method: 'POST', body: { chat: 'room:x', msg: 'm1', text: 'remember the milk', label: '#x', open: 'rooms/x' } })
  assert.equal((await (await call('/api/bookmarks?q=MILK')).json()).saved.length, 1)
  assert.equal((await (await call('/api/bookmarks?q=zzz')).json()).saved.length, 0)
  await call('/api/bookmarks?chat=room:x&msg=m1', { method: 'DELETE' })
  assert.equal((await (await call('/api/bookmarks')).json()).saved.length, 0)
})

test('room read marks a pinned message as plain data after its time, and only that one', async () => {
  const room = await (await call('/api/rooms', { method: 'POST', body: { title: 'pin test', slug: 'tmp-pintest' } })).json()
  const slug = room.slug ?? 'tmp-pintest'
  const r1 = await call(`/api/rooms/${slug}/messages`, { method: 'POST', body: { text: 'first note' } })
  assert.equal(r1.status, 200, await r1.clone().text())
  const first = await r1.json()
  await call(`/api/rooms/${slug}/messages`, { method: 'POST', body: { text: 'second note' } })
  await call('/api/pins', { method: 'POST', body: { chat: `room:${slug}`, msg: first.id, text: 'first note' } })
  const text = await (await call(`/api/rooms/${slug}/messages?format=text`, { auth: false })).text()
  const lines = text.trim().split('\n')
  assert.match(lines[0], /^1\. \[\d\d:\d\d\] \[pinned\] .*: first note$/)
  assert.doesNotMatch(lines[1], /pinned/)
  await call(`/api/rooms/${slug}`, { method: 'DELETE' })
})
