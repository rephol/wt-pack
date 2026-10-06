// Run: node --test push.test.mjs — WP-268 Web Push: payload encryption against RFC 8291's own example, the VAPID JWT,
// the subscription store, the SSRF guard on endpoints, the per-device gate and the sender (against a stub push service).
import test from 'node:test'
import assert from 'node:assert/strict'
import { createDecipheriv, createECDH, createHmac, createPublicKey, verify, randomBytes } from 'node:crypto'
import { mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Push, encrypt, vapidJwt, loadVapid, endpointOk, validSubscription, gate, payloadOf, defaultKinds } from './push.mjs'

const u = (s) => Buffer.from(s, 'base64url')

// RFC 8291 section 5 (and its keys): "When I grow up, I want to be a watermelon" to this receiver.
const RFC = {
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
}

// An independent receiver (the browser's side): HKDF written out with HMAC rather than hkdfSync.
const hmac = (k, d) => createHmac('sha256', k).update(d).digest()
const hkdf = (salt, ikm, info, len) => { const prk = hmac(salt, ikm); let t = Buffer.alloc(0), out = Buffer.alloc(0); for (let i = 1; out.length < len; i++) { t = hmac(prk, Buffer.concat([t, info, Buffer.from([i])])); out = Buffer.concat([out, t]) } return out.subarray(0, len) }
function decrypt(body, uaPrivate, uaPublic, auth) {
  const salt = body.subarray(0, 16), rs = body.readUInt32BE(16), idlen = body[20], asPublic = body.subarray(21, 21 + idlen), rec = body.subarray(21 + idlen)
  const ecdh = createECDH('prime256v1'); ecdh.setPrivateKey(u(uaPrivate))
  const ikm = hkdf(u(auth), ecdh.computeSecret(asPublic), Buffer.concat([Buffer.from('WebPush: info\0'), u(uaPublic), asPublic]), 32)
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16), nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12)
  assert.ok(rec.length <= rs)
  const d = createDecipheriv('aes-128-gcm', cek, nonce); d.setAuthTag(rec.subarray(-16))
  const plain = Buffer.concat([d.update(rec.subarray(0, -16)), d.final()])
  assert.equal(plain.at(-1), 2) // last-record delimiter
  return plain.subarray(0, -1).toString()
}

// A fresh receiver key pair, as a browser's PushSubscription.toJSON() would carry.
function receiver() {
  const e = createECDH('prime256v1'); e.generateKeys()
  const auth = randomBytes(16).toString('base64url')
  return { priv: e.getPrivateKey().toString('base64url'), pub: e.getPublicKey().toString('base64url'), auth }
}
const subOf = (r, endpoint) => ({ endpoint, keys: { p256dh: r.pub, auth: r.auth } })
const EP = 'https://fcm.googleapis.com/fcm/send/abc123'

test('encrypt: reproduces the RFC 8291 example byte for byte', () => {
  const body = encrypt('When I grow up, I want to be a watermelon', RFC.uaPublic, RFC.auth, { as: RFC.asPrivate, salt: u(RFC.salt) })
  assert.equal(body.toString('base64url'), RFC.body)
  assert.equal(decrypt(body, RFC.uaPrivate, RFC.uaPublic, RFC.auth), 'When I grow up, I want to be a watermelon')
})
test('encrypt: a random ephemeral key and salt each time, decryptable by the receiver; oversize refused', () => {
  const r = receiver()
  const a = encrypt('{"title":"hi"}', r.pub, r.auth), b = encrypt('{"title":"hi"}', r.pub, r.auth)
  assert.notEqual(a.toString('base64url'), b.toString('base64url'))
  assert.equal(decrypt(a, r.priv, r.pub, r.auth), '{"title":"hi"}')
  assert.throws(() => encrypt('x'.repeat(4100), r.pub, r.auth), /too large/)
})

test('vapid: the key pair is made once, stored mode 600; the JWT verifies with the public key and names the push service', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wt-push-'))
  const v = loadVapid(dir)
  assert.equal(statSync(join(dir, 'vapid.json')).mode & 0o777, 0o600)
  assert.deepEqual(loadVapid(dir), v) // second load: same key
  const jwt = vapidJwt(`${EP}?x=1`, 'mailto:a@example.com', v.privateJwk, 1_000_000_000_000)
  const [h, c, s] = jwt.split('.')
  assert.deepEqual(JSON.parse(u(h)), { typ: 'JWT', alg: 'ES256' })
  assert.deepEqual(JSON.parse(u(c)), { aud: 'https://fcm.googleapis.com', exp: 1_000_000_000 + 12 * 3600, sub: 'mailto:a@example.com' })
  const pub = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: v.privateJwk.x, y: v.privateJwk.y }, format: 'jwk' })
  assert.equal(u(v.publicKey).length, 65)
  assert.ok(verify('sha256', Buffer.from(`${h}.${c}`), { key: pub, dsaEncoding: 'ieee-p1363' }, u(s)))
})

test('endpointOk: only https push services; no other host, port, credentials or scheme (SSRF)', () => {
  for (const ok of [EP, 'https://updates.push.services.mozilla.com/wpush/v2/x', 'https://web.push.apple.com/Q', 'https://wns2-par02p.notify.windows.com/w/?token=x'])
    assert.equal(endpointOk(ok), true, ok)
  for (const bad of ['http://fcm.googleapis.com/x', 'https://evil.example/x', 'https://127.0.0.1/x', 'https://fcm.googleapis.com.evil.example/x', 'https://u:p@fcm.googleapis.com/x', 'https://fcm.googleapis.com:8443/x', 'https://notfcm.googleapis.com.x/', 'file:///etc/passwd', 'nonsense', 'https://pushXapple.com/'])
    assert.equal(endpointOk(bad), false, bad)
  assert.equal(endpointOk('http://127.0.0.1:9/p', ['127.0.0.1:9']), true) // the test/self-host escape hatch is explicit
})
test('validSubscription: needs a 65-byte uncompressed point and a 16-byte auth secret', () => {
  const r = receiver()
  assert.ok(validSubscription(subOf(r, EP)))
  assert.equal(validSubscription({ endpoint: EP, keys: { p256dh: r.pub } }), null)
  assert.equal(validSubscription({ endpoint: EP, keys: { p256dh: 'AAAA', auth: r.auth } }), null)
  assert.equal(validSubscription({ endpoint: EP, keys: { p256dh: r.pub, auth: 'AAAA' } }), null)
  assert.equal(validSubscription(subOf(r, 'https://evil.example/x')), null)
  assert.equal(validSubscription(null), null)
})

const item = (o = {}) => ({ id: 'i1', kind: 'question', key: 'k1', title: 'a asks you', body: 'which?', target: { agent: 'w:1' }, ...o })
test('gate: per-device kind switch, quiet items, once per key, one per target per 30 s', () => {
  const s = { seen: new Set(), lastAt: new Map(), now: 1000 }
  const d = { id: 'd1', kinds: { ...defaultKinds() } }
  assert.equal(gate(item({ quiet: true }), d, s), false)
  assert.equal(gate(item({ kind: 'server', key: 's' }), d, s), false, 'server is off by default')
  assert.equal(gate(item(), d, s), true)
  assert.equal(gate(item(), d, s), false, 'same key again')
  assert.equal(gate(item({ key: 'k2' }), d, s), false, 'same target within 30 s')
  assert.equal(gate(item({ key: 'k3', target: { agent: 'w:2' } }), d, s), true, 'another target')
  s.now += 30_000
  assert.equal(gate(item({ key: 'k4' }), d, s), true, 'after the window')
  assert.equal(gate(item({ key: 'k5', target: { agent: 'w:9' } }), { id: 'd2', kinds: { ...defaultKinds(), question: false } }, s), false, 'kind off on that device')
  assert.equal(gate(item({ key: 'k1', target: { agent: 'w:5' } }), { id: 'd3', kinds: defaultKinds() }, s), true, 'seen is per device')
})
test('payloadOf: short, with a hash route for the click', () => {
  assert.deepEqual(JSON.parse(payloadOf(item({ body: 'x'.repeat(500) }))), { title: 'a asks you', body: 'x'.repeat(200), tag: 'k1', url: '/#inbox' })
  assert.equal(JSON.parse(payloadOf(item({ target: { room: 'my room' } }))).url, '/#rooms/my%20room')
})

// A stub push service: records each POST, answers with the next status in `statuses`.
async function stub() {
  const http = await import('node:http')
  const got = [], statuses = []
  const srv = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => { got.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks) }); res.writeHead(statuses.shift() ?? 201).end() })
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  return { got, statuses, host: `127.0.0.1:${srv.address().port}`, close: () => srv.close() }
}
const fresh = (extra) => new Push(mkdtempSync(join(tmpdir(), 'wt-push-')), { extraHosts: extra, log: () => {} })

test('subscriptions: upsert per endpoint (keeps id and kinds), list hides secrets, setKinds, remove, cap', () => {
  const p = fresh(), r = receiver()
  const id = p.upsert(subOf(r, EP), { label: 'My <iPhone>!' })
  assert.equal(p.upsert(subOf(r, EP), { label: 'Renamed' }), id, 'same endpoint, same id')
  assert.deepEqual(p.list().map((d) => [d.id, d.label]), [[id, 'Renamed']])
  assert.deepEqual(p.list()[0].kinds, defaultKinds())
  assert.ok(!JSON.stringify(p.list()).includes(r.auth) && !JSON.stringify(p.list()).includes('fcm.googleapis'))
  assert.equal(p.setKinds(id, { question: false, bogus: true, 'agent-done': 'yes' }), true)
  const k = p.list()[0].kinds
  assert.equal(k.question, false)
  assert.equal(k['agent-done'], true, 'a non-boolean falls back to the default')
  assert.ok(!('bogus' in k))
  assert.equal(p.setKinds('nope', {}), false)
  assert.throws(() => p.upsert({ endpoint: 'https://evil.example/x', keys: { p256dh: r.pub, auth: r.auth } }), /valid push subscription/)
  assert.equal(p.remove(id), true)
  assert.equal(p.remove(id), false)
  for (let i = 0; i < 20; i++) p.upsert(subOf(receiver(), `${EP}${i}`))
  assert.throws(() => p.upsert(subOf(receiver(), `${EP}x`)), /at most 20/)
})

test('notify: encrypts and signs for each device, once per item, prunes a 410, keeps a 5xx', async () => {
  const svc = await stub()
  try {
    const p = fresh([svc.host]), a = receiver(), b = receiver()
    const ida = p.upsert(subOf(a, `http://${svc.host}/a`), { label: 'a' })
    const idb = p.upsert(subOf(b, `http://${svc.host}/b`), { label: 'b' })
    p.setKinds(idb, { ...defaultKinds(), question: false })
    assert.equal(await p.notify(item()), 1) // only a has `question` on
    assert.equal(svc.got.length, 1)
    const g = svc.got[0]
    assert.equal(g.url, '/a')
    assert.equal(g.headers['content-encoding'], 'aes128gcm')
    assert.match(g.headers.authorization, new RegExp(`^vapid t=[\\w-]+\\.[\\w-]+\\.[\\w-]+, k=${p.publicKey}$`))
    assert.equal(JSON.parse(decrypt(g.body, a.priv, a.pub, a.auth)).title, 'a asks you')
    assert.equal(await p.notify(item()), 0, 'the same item is not sent twice')
    svc.statuses.push(410)
    assert.equal(await p.notify(item({ key: 'k9', target: { agent: 'z' } })), 1)
    assert.deepEqual(p.list().map((d) => d.id), [idb], 'the 410 pruned a')
    p.upsert(subOf(a, `http://${svc.host}/a`), { label: 'a2' })
    svc.statuses.push(500)
    await p.notify(item({ key: 'k10', target: { agent: 'y' } }))
    assert.equal(p.list().length, 2, 'a 500 keeps the device')
  } finally { svc.close() }
})

test('inbox → push: a new item reaches the device once; the inbox\'s own key dedupe and the gate stop repeats', async () => {
  const { Inbox } = await import('./inbox.mjs')
  const svc = await stub()
  try {
    const p = fresh([svc.host]), r = receiver()
    p.upsert(subOf(r, `http://${svc.host}/x`))
    const inbox = new Inbox(p.dir)
    inbox.subs.add((it) => { p.notify(it).catch(() => {}) }) // what server.mjs wires
    const draft = { kind: 'agent-done', key: 'done|w:1|1', title: 'a is done', body: '', target: { agent: 'w:1' } }
    await inbox.add(draft); await inbox.add(draft)
    await inbox.add({ ...draft, key: 'done|w:1|2', quiet: true }) // a baseline item: never pushed
    await new Promise((r) => setTimeout(r, 200))
    assert.equal(svc.got.length, 1)
    assert.equal(JSON.parse(decrypt(svc.got[0].body, r.priv, r.pub, r.auth)).title, 'a is done')
  } finally { svc.close() }
})
