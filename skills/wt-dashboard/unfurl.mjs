// Link previews for chat messages. Fetches a public http(s) page server-side and extracts its OpenGraph card.
// SSRF guards: http/https only; every hop's host is resolved first and refused if ANY address is private,
// loopback, link-local, CGNAT/tailnet, multicast or reserved; the connection is then pinned to the checked
// address (a custom `lookup`), so DNS rebinding between check and connect cannot swap it; redirects are
// followed by hand (max 3), each re-checked. 5s timeout, 1MB cap, no cookies or credentials ever sent.
import http from 'node:http'
import https from 'node:https'
import { lookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'

const BLOCK = new BlockList()
for (const [a, p] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]])
  BLOCK.addSubnet(a, p, 'ipv4')
for (const [a, p] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['2001:db8::', 32], ['64:ff9b::', 96], ['100::', 64], ['fd7a:115c:a1e0::', 48]])
  BLOCK.addSubnet(a, p, 'ipv6')

export function isBlockedAddress(ip) {
  const v = isIP(ip)
  if (!v) return true
  if (v === 6) {
    const m = ip.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/) // IPv4-mapped
    if (m) return isBlockedAddress(m[1])
  }
  return BLOCK.check(ip, v === 4 ? 'ipv4' : 'ipv6')
}
const LOCAL_NAME = /(^|\.)(localhost|local|internal|lan|home|ts\.net)$/i

// → the address to connect to, or throws. `resolve` is injectable for tests.
export async function checkUrl(raw, resolve = (h) => lookup(h, { all: true, verbatim: true })) {
  let u
  try { u = new URL(raw) } catch { throw new Error('bad url') }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('only http/https')
  if (u.username || u.password) throw new Error('credentials in url')
  const host = u.hostname.replace(/^\[|\]$/g, '')
  if (LOCAL_NAME.test(host) || !host.includes('.') && !isIP(host)) throw new Error('local host name')
  const addrs = isIP(host) ? [{ address: host, family: isIP(host) }] : await resolve(host)
  if (!addrs.length || addrs.some((a) => isBlockedAddress(a.address))) throw new Error('private address')
  return { url: u, address: addrs[0].address, family: addrs[0].family }
}

const MAX = 1_000_000
function get(target, accept, resolve) {
  return new Promise((ok, fail) => {
    const { url, address, family } = target
    const lib = url.protocol === 'https:' ? https : http
    const req = lib.request(url, {
      method: 'GET', timeout: 5000, agent: false,
      lookup: (_h, opts, cb) => (opts?.all ? cb(null, [{ address, family }]) : cb(null, address, family)), // pinned
      headers: { 'user-agent': 'wt-dashboard link preview', accept, 'accept-language': 'en' },
    }, (res) => {
      const chunks = []
      let n = 0
      res.on('data', (c) => { n += c.length; if (n > MAX) { req.destroy(); fail(new Error('too large')) } else chunks.push(c) })
      res.on('end', () => ok({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
      res.on('error', fail)
    })
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', fail)
    req.end()
  })
}
export async function safeFetch(raw, accept, resolve, check = checkUrl) {
  let target = await check(raw, resolve)
  for (let hop = 0; hop < 4; hop++) {
    const r = await get(target, accept, resolve)
    if (r.status >= 300 && r.status < 400 && r.headers.location) {
      target = await check(new URL(r.headers.location, target.url).href, resolve) // every hop re-checked
      continue
    }
    return { ...r, url: target.url.href }
  }
  throw new Error('too many redirects')
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", nbsp: ' ' }
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENT[e.toLowerCase()] ?? m)
const clean = (s, n) => { const t = s && decode(s).replace(/\s+/g, ' ').trim(); return t ? (t.length > n ? t.slice(0, n - 1) + '…' : t) : null }

// HTML → {title, description, image, siteName, icon}, URLs made absolute against `base`.
export function parseHtml(html, base) {
  const head = html.slice(0, 300_000)
  const meta = {}
  for (const tag of head.match(/<meta\b[^>]*>/gi) ?? []) {
    const attr = (n) => tag.match(new RegExp(`\\b${n}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'))?.slice(2).find((x) => x != null)
    const k = (attr('property') ?? attr('name'))?.toLowerCase()
    const v = attr('content')
    if (k && v != null && !(k in meta)) meta[k] = v
  }
  const abs = (u) => { try { const x = new URL(decode(u), base); return /^https?:$/.test(x.protocol) ? x.href : null } catch { return null } }
  const iconTag = (head.match(/<link\b[^>]*rel\s*=\s*["']?[^"'>]*icon[^>]*>/i) ?? [])[0]
  const iconHref = iconTag?.match(/\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i)?.slice(2).find((x) => x != null)
  return {
    title: clean(meta['og:title'] ?? meta['twitter:title'] ?? head.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1], 200),
    description: clean(meta['og:description'] ?? meta['twitter:description'] ?? meta.description, 300),
    image: meta['og:image'] || meta['twitter:image'] ? abs(meta['og:image'] ?? meta['twitter:image']) : null,
    siteName: clean(meta['og:site_name'], 80) ?? new URL(base).hostname.replace(/^www\./, ''),
    icon: abs(iconHref ?? '/favicon.ico'),
  }
}

// Links we can describe from data we already have, instead of fetching.
export function classifyUrl(raw, repo /* "owner/name" or null */) {
  let u
  try { u = new URL(raw) } catch { return null }
  const gh = u.hostname === 'github.com' && u.pathname.match(/^\/([^/]+\/[^/]+)\/(pull|issues)\/(\d+)/)
  if (gh && repo && gh[1].toLowerCase() === repo.toLowerCase()) return { kind: gh[2] === 'pull' ? 'pr' : 'issue', number: Number(gh[3]) }
  const lin = u.hostname === 'linear.app' && u.pathname.match(/^\/[^/]+\/issue\/([A-Z][A-Z0-9]*-\d+)/i)
  if (lin) return { kind: 'linear', identifier: lin[1].toUpperCase() }
  if (u.hostname === 'claude.ai' && /\/artifact\//.test(u.pathname)) return { kind: 'artifact' }
  return null
}
