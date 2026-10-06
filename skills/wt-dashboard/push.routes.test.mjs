// Run: node --test push.routes.test.mjs — WP-268 /api/push routes against a real server process (isolated data dir),
// with a stub push service the server is allowed to reach (WT_DASHBOARD_PUSH_HOSTS).
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { createDecipheriv, createECDH, createHmac, randomBytes } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const u = (s) => Buffer.from(s, 'base64url')
const hmac = (k, d) => createHmac('sha256', k).update(d).digest()
const hkdf = (salt, ikm, info, len) => { const prk = hmac(salt, ikm); return hmac(prk, Buffer.concat([info, Buffer.from([1])])).subarray(0, len) } // len ≤ 32: one block
function decrypt(body, r) {
  const salt = body.subarray(0, 16), n = body[20], asPub = body.subarray(21, 21 + n), rec = body.subarray(21 + n)
  const e = createECDH('prime256v1'); e.setPrivateKey(u(r.priv))
  const ikm = hkdf(u(r.auth), e.computeSecret(asPub), Buffer.concat([Buffer.from('WebPush: info\0'), u(r.pub), asPub]), 32)
  const d = createDecipheriv('aes-128-gcm', hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16), hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12))
  d.setAuthTag(rec.subarray(-16))
  return Buffer.concat([d.update(rec.subarray(0, -16)), d.final()]).subarray(0, -1).toString()
}

let child, base, cookie, svc, got = []
const PORT = 30000 + Math.floor(Math.random() * 20000)
before(async () => {
  svc = http.createServer((req, res) => { const c = []; req.on('data', (x) => c.push(x)); req.on('end', () => { got.push(Buffer.concat(c)); res.writeHead(201).end() }) })
  await new Promise((r) => svc.listen(0, '127.0.0.1', r))
  const root = mkdtempSync(join(tmpdir(), 'wt-pushroutes-'))
  mkdirSync(join(root, 'data'), { recursive: true })
  child = spawn(process.execPath, ['server.mjs'], { cwd: import.meta.dirname, stdio: 'ignore',
    env: { ...process.env, PORT: String(PORT), WT_DASHBOARD_DATA: root, WT_DASHBOARD_PUSH_HOSTS: `127.0.0.1:${svc.address().port}`, HOME: root } })
  base = `http://127.0.0.1:${PORT}`
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/api/push`)).ok) break } catch { /* not up yet */ } await new Promise((r) => setTimeout(r, 100)) }
  cookie = `hd_session=${readFileSync(join(root, 'session'), 'utf8').trim()}`
})
after(() => { child?.kill(); svc?.close() })

const call = (method, path, body, headers = {}) => fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
const authed = (method, path, body) => call(method, path, body, { cookie })

test('GET /api/push: the VAPID public key and no devices yet', async () => {
  const j = await (await call('GET', '/api/push')).json()
  assert.equal(u(j.publicKey).length, 65)
  assert.deepEqual(j.devices, [])
})
test('writes need the session cookie and a local Origin', async () => {
  const r = { priv: '', pub: '', auth: '' }
  assert.equal((await call('POST', '/api/push/subscription', { subscription: r })).status, 403)
  assert.equal((await call('POST', '/api/push/subscription', {}, { cookie, origin: 'https://evil.example' })).status, 403)
  assert.equal((await call('DELETE', '/api/push/subscription/x')).status, 403)
  assert.equal((await call('POST', '/api/push/test', { id: 'x' })).status, 403)
})
test('subscription lifecycle: add (bad endpoint refused), kinds, test push arrives encrypted, remove', async () => {
  const e = createECDH('prime256v1'); e.generateKeys()
  const r = { priv: e.getPrivateKey().toString('base64url'), pub: e.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') }
  const sub = (endpoint) => ({ endpoint, keys: { p256dh: r.pub, auth: r.auth } })
  assert.equal((await authed('POST', '/api/push/subscription', { subscription: sub('https://evil.example/x') })).status, 400)
  assert.equal((await authed('POST', '/api/push/subscription', { subscription: { endpoint: 'nope' } })).status, 400)
  const { id } = await (await authed('POST', '/api/push/subscription', { subscription: sub(`http://127.0.0.1:${svc.address().port}/p`), label: 'Test phone' })).json()
  assert.ok(id)
  let list = (await (await call('GET', '/api/push')).json()).devices
  assert.deepEqual(list.map((d) => d.label), ['Test phone'])
  assert.equal(list[0].kinds.question, true)
  assert.equal(JSON.stringify(list).includes(r.auth), false)
  assert.equal((await authed('PATCH', `/api/push/subscription/${id}`, { kinds: { question: false } })).status, 200)
  list = (await (await call('GET', '/api/push')).json()).devices
  assert.equal(list[0].kinds.question, false)
  assert.equal((await authed('PATCH', '/api/push/subscription/nope', { kinds: {} })).status, 404)
  const t = await authed('POST', '/api/push/test', { id })
  assert.deepEqual(await t.json(), { ok: true, status: 201 })
  assert.equal(JSON.parse(decrypt(got.at(-1), r)).title, 'wt-dashboard')
  assert.equal((await authed('POST', '/api/push/test', { id: 'nope' })).status, 404)
  assert.equal((await authed('DELETE', `/api/push/subscription/${id}`)).status, 200)
  assert.equal((await authed('DELETE', `/api/push/subscription/${id}`)).status, 404)
  assert.deepEqual((await (await call('GET', '/api/push')).json()).devices, [])
})
