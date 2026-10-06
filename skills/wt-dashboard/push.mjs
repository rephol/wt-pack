// WP-268 Web Push (RFC 8030 + VAPID RFC 8292 + aes128gcm RFC 8291/8188) with node:crypto only, no dependency.
// VAPID keys: generated once, kept in <data dir>/vapid.json (mode 600). Subscriptions: table push_subscriptions in
// wt.db, one row per browser/device, each with its own per-kind switches (the "Phone" column in Settings).
// Pure pieces (encrypt, vapidJwt, endpointOk, validSubscription, gate) are exported for push.test.mjs.
import { createECDH, createCipheriv, createPrivateKey, generateKeyPairSync, hkdfSync, randomBytes, randomUUID, sign } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { open } from './store.mjs'
import { KINDS } from './contracts.mjs'

const b64u = (b) => Buffer.from(b).toString('base64url')
const unb64u = (s) => Buffer.from(String(s), 'base64url')

// Kinds a new device gets: the same defaults as the macOS "Native" column (notifyGate.ts DEFAULT_PREFS.native).
export const defaultKinds = () => Object.fromEntries(KINDS.map((k) => [k, !['room-suggestion', 'server'].includes(k)]))
export const RATE_MS = 30_000 // ~1 push per target per device per 30 s, as the native gate
export const MAX_DEVICES = 20

// The push services the browsers' endpoints live on. The server POSTs to a client-supplied URL, so anything else is
// refused (SSRF): https only, no credentials, default port, host under one of these. `extra` is for tests/self-hosting.
const SERVICES = ['fcm.googleapis.com', 'push.services.mozilla.com', 'push.apple.com', 'notify.windows.com']
export function endpointOk(endpoint, extra = []) {
  let u
  try { u = new URL(endpoint) } catch { return false }
  if (u.username || u.password || String(endpoint).length > 700) return false
  if (extra.includes(u.host)) return true
  return u.protocol === 'https:' && !u.port && SERVICES.some((s) => u.hostname === s || u.hostname.endsWith(`.${s}`))
}

// A PushSubscription.toJSON(): endpoint + keys.p256dh (65-byte uncompressed P-256 point) + keys.auth (16 bytes).
export function validSubscription(s, extra = []) {
  if (typeof s?.endpoint !== 'string' || !endpointOk(s.endpoint, extra)) return null
  const p256dh = unb64u(s.keys?.p256dh ?? ''), auth = unb64u(s.keys?.auth ?? '')
  if (p256dh.length !== 65 || p256dh[0] !== 4 || auth.length !== 16) return null
  return { endpoint: s.endpoint, p256dh: b64u(p256dh), auth: b64u(auth) }
}

export function loadVapid(dir) {
  const f = join(dir, 'vapid.json')
  if (existsSync(f)) {
    try { const v = JSON.parse(readFileSync(f, 'utf8')); if (v.privateJwk && v.publicKey) return v } catch { /* regenerate below */ }
  }
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const jwk = privateKey.export({ format: 'jwk' })
  const v = { publicKey: b64u(Buffer.concat([Buffer.from([4]), unb64u(jwk.x), unb64u(jwk.y)])), privateJwk: jwk }
  writeFileSync(f, JSON.stringify(v), { mode: 0o600 })
  chmodSync(f, 0o600)
  return v
}

// ES256 JWT for the Authorization header; aud = the push service's origin, exp ≤ 24 h.
export function vapidJwt(endpoint, subject, privateJwk, now = Date.now()) {
  const part = (o) => b64u(JSON.stringify(o))
  const head = `${part({ typ: 'JWT', alg: 'ES256' })}.${part({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })}`
  const sig = sign('sha256', Buffer.from(head), { key: createPrivateKey({ key: privateJwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' })
  return `${head}.${b64u(sig)}`
}

// RFC 8291 §3 + RFC 8188: one aes128gcm record. `as` (the app server's ephemeral ECDH key) and `salt` are injectable
// so the RFC's own example reproduces byte for byte.
export function encrypt(plaintext, p256dh, auth, { as, salt = randomBytes(16) } = {}) {
  const ua = unb64u(p256dh), authSecret = unb64u(auth)
  const ecdh = createECDH('prime256v1')
  if (as) ecdh.setPrivateKey(unb64u(as)); else ecdh.generateKeys()
  const asPublic = ecdh.getPublicKey()
  const ikm = Buffer.from(hkdfSync('sha256', ecdh.computeSecret(ua), authSecret, Buffer.concat([Buffer.from('WebPush: info\0'), ua, asPublic]), 32))
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, 'Content-Encoding: aes128gcm\0', 16))
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, 'Content-Encoding: nonce\0', 12))
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096)
  const data = Buffer.concat([Buffer.from(plaintext), Buffer.from([2])]) // 0x02: last record's delimiter, no padding
  if (data.length > 4096 - 16) throw new Error('push payload too large')
  const c = createCipheriv('aes-128-gcm', cek, nonce)
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, c.update(data), c.final(), c.getAuthTag()])
}

// Per-device decision: not a quiet (baseline) item, the kind is on for this device, once per item key, ~1 per target per
// 30 s. `s` = { seen: Set, lastAt: Map, now }; marks the item as sent when it returns true. Same rule as notifyGate.ts.
export function gate(it, device, s) {
  if (it.quiet || !device.kinds[it.kind]) return false
  const sk = `${device.id}|${it.key}`
  if (s.seen.has(sk)) return false
  const target = it.target?.agent ?? (it.target?.room ? `room:${it.target.room}` : it.key)
  const rk = `${device.id}|${target}`
  if (s.now - (s.lastAt.get(rk) ?? -Infinity) < RATE_MS) return false
  if (s.seen.size > 5000) s.seen.clear() // bounded; a repeat after that is the inbox's own 60 s key dedupe's job
  s.seen.add(sk); s.lastAt.set(rk, s.now)
  return true
}

// What the service worker shows, and where a click goes (hash routes of the web app).
export const payloadOf = (it) => JSON.stringify({
  title: String(it.title ?? 'wt-dashboard').slice(0, 120), body: String(it.body ?? '').slice(0, 200),
  tag: String(it.key ?? it.id ?? '').slice(0, 100), url: it.target?.room ? `/#rooms/${encodeURIComponent(it.target.room)}` : '/#inbox',
})

const cleanKinds = (k) => Object.fromEntries(KINDS.map((x) => [x, typeof k?.[x] === 'boolean' ? k[x] : defaultKinds()[x]]))
const cleanLabel = (s) => String(s ?? '').replace(/[^\w .:@+()-]/g, '').trim().slice(0, 60) || 'Phone'

export class Push {
  constructor(dir, { fetchImpl = fetch, extraHosts = [], subject = 'mailto:wt-dashboard@example.com', log = console.error } = {}) {
    Object.assign(this, { dir, file: join(dir, 'wt.db'), fetchImpl, extraHosts, subject, log, seen: new Set(), lastAt: new Map(), vapid: null })
  }
  get db() { return open(this.file) }
  get publicKey() { return (this.vapid ??= loadVapid(this.dir)).publicKey }
  // Rows as the Settings page sees them: never the endpoint or the keys.
  list() {
    return this.db.prepare('SELECT id, label, kinds, created, last_ok FROM push_subscriptions ORDER BY created').all()
      .map((r) => ({ id: r.id, label: r.label, kinds: JSON.parse(r.kinds), created: r.created, lastOk: r.last_ok }))
  }
  rows() { return this.db.prepare('SELECT * FROM push_subscriptions').all().map((r) => ({ ...r, kinds: JSON.parse(r.kinds) })) }
  // One row per endpoint: re-subscribing the same browser updates it (and keeps its id).
  upsert(sub, { label, kinds } = {}) {
    const s = validSubscription(sub, this.extraHosts)
    if (!s) throw Object.assign(new Error('not a valid push subscription'), { status: 400 })
    const old = this.db.prepare('SELECT id, kinds FROM push_subscriptions WHERE endpoint = ?').get(s.endpoint)
    if (!old && this.db.prepare('SELECT COUNT(*) n FROM push_subscriptions').get().n >= MAX_DEVICES) throw Object.assign(new Error(`at most ${MAX_DEVICES} devices`), { status: 400 })
    const id = old?.id ?? randomUUID()
    const k = JSON.stringify(cleanKinds(kinds ?? (old ? JSON.parse(old.kinds) : undefined)))
    this.db.prepare('INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, label, kinds, created) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, label = excluded.label, kinds = excluded.kinds')
      .run(id, s.endpoint, s.p256dh, s.auth, cleanLabel(label), k, new Date().toISOString())
    return id
  }
  setKinds(id, kinds) {
    const r = this.db.prepare('UPDATE push_subscriptions SET kinds = ? WHERE id = ?').run(JSON.stringify(cleanKinds(kinds)), id)
    return r.changes > 0
  }
  remove(id) { return this.db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(id).changes > 0 }

  // POST one payload to one device; 404/410 = the browser dropped the subscription → prune. Returns the HTTP status.
  async send(device, payload) {
    const body = encrypt(payload, device.p256dh, device.auth)
    const r = await this.fetchImpl(device.endpoint, {
      method: 'POST', body, signal: AbortSignal.timeout(10_000),
      headers: {
        authorization: `vapid t=${vapidJwt(device.endpoint, this.subject, (this.vapid ??= loadVapid(this.dir)).privateJwk)}, k=${this.publicKey}`,
        'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream', ttl: '3600', urgency: 'normal',
      },
    })
    if (r.status === 404 || r.status === 410) this.remove(device.id)
    else if (r.ok) this.db.prepare('UPDATE push_subscriptions SET last_ok = ? WHERE id = ?').run(new Date().toISOString(), device.id)
    return r.status
  }
  // A new inbox item → every device whose gate passes. Never throws into the inbox.
  async notify(it, now = Date.now()) {
    const devices = this.rows().filter((d) => gate(it, d, { seen: this.seen, lastAt: this.lastAt, now }))
    const payload = payloadOf(it)
    await Promise.allSettled(devices.map((d) => this.send(d, payload).then((st) => { if (st >= 400) this.log(`push: ${d.label} → HTTP ${st}`) }, (e) => this.log(`push: ${d.label}: ${e.message}`))))
    return devices.length
  }
  testPayload() { return JSON.stringify({ title: 'wt-dashboard', body: 'Phone notifications work.', tag: 'push-test', url: '/#inbox' }) }
}
