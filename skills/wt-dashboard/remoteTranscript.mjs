// WP-97: a remote agent's Claude transcript, read over SSH (read-only). herdr reports no session id for remote
// panes, so the transcript is *matched*: among the jsonl files of the pane's project dir changed in the last week,
// the one whose recent user prompts contain the pane's last prompt. Everything here is pure or takes an injected
// `ssh`, so it is tested without a network. Nothing from a request reaches a script: the host comes from
// `herdr machine list`, the dir is re-encoded from the cwd to [A-Za-z0-9-], ids are UUID-checked, sizes are ints.
import { execFile } from 'node:child_process'

export const WINDOW = 4 * 1024 * 1024 // first load and each pull read at most this many bytes
const HOST = /^[A-Za-z0-9._@-]+$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export const hostOk = (h) => typeof h === 'string' && HOST.test(h) && !h.startsWith('-')

// ssh <host> <script> → stdout (Buffer). BatchMode: never prompts; ConnectTimeout + timeout bound a dead host.
export function ssh(host, script, { signal } = {}) {
  if (!hostOk(host)) return Promise.reject(Object.assign(new Error(`refused ssh host ${JSON.stringify(host)}`), { code: 'EHOST' }))
  return new Promise((resolve, reject) => execFile('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '--', host, script],
    { timeout: 10_000, maxBuffer: WINDOW + 65_536, encoding: 'buffer', signal }, (e, out) => (e ? reject(e) : resolve(out))))
}

// Claude's project dir name for a cwd: every non-alphanumeric → '-'. The cwd is remote-controlled; the result is
// only [A-Za-z0-9-] or null.
export function projectDir(cwd) {
  if (typeof cwd !== 'string' || !cwd.startsWith('/')) return null
  const d = cwd.replace(/[^A-Za-z0-9]/g, '-')
  return /^-[A-Za-z0-9-]+$/.test(d) ? d : null
}

const dirOk = (d) => typeof d === 'string' && /^-[A-Za-z0-9-]+$/.test(d)
const int = (n) => { if (!Number.isSafeInteger(n) || n < 0) throw new Error(`bad size ${n}`); return n }
const file = (dir, id) => {
  if (!dirOk(dir) || !UUID.test(id)) throw new Error('refused transcript path')
  return `"$HOME/.claude/projects/${dir}/${id}.jsonl"`
}

export const candidatesScript = (dir) => {
  if (!dirOk(dir)) throw new Error('refused project dir')
  return `cd "$HOME/.claude/projects/${dir}" 2>/dev/null && find . -maxdepth 1 -name '*.jsonl' -mmin -10080 -printf '%T@ %s %f\\n'`
}
export const tailScript = (dir, id, bytes) => `tail -c ${int(bytes)} ${file(dir, id)}`
export const readScript = (dir, id, from, len) => `tail -c +${int(from) + 1} ${file(dir, id)} | head -c ${int(len)}`

// `find -printf '%T@ %s %f\n'` → [{id, mtime, size}], newest first; anything not a UUID.jsonl is dropped.
export function parseCandidates(out) {
  return String(out).split('\n').map((l) => l.trim().split(' ')).filter((p) => p.length === 3)
    .map(([t, s, f]) => ({ id: f.replace(/\.jsonl$/, ''), mtime: Number(t), size: Number(s) }))
    .filter((c) => UUID.test(c.id) && Number.isFinite(c.mtime) && Number.isSafeInteger(c.size))
    .sort((a, b) => b.mtime - a.mtime)
}

const MIN = 12 // shorter lines ("Done.", "Yes") are in every transcript
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 40)
// The text of user prompts and assistant replies in a tail (its first line is usually cut, so it is skipped).
export function userTexts(tail) {
  const out = []
  for (const l of String(tail ?? '').split('\n').slice(1)) {
    let e
    try { e = JSON.parse(l) } catch { continue }
    const c = e?.type === 'user' || e?.type === 'assistant' ? e.message?.content : null
    if (typeof c === 'string') out.push(c)
    else if (Array.isArray(c)) for (const b of c) if (b?.type === 'text' && typeof b.text === 'string') out.push(b.text)
  }
  return out
}

// The pane's transcript among `cands`: the one file whose recent prompts/replies start like the pane's `prompt` hint
// (its last prompt, or paragraphs of its tail — any of them, each ≥12 chars, compared on their first 40, so a bare "Done." never matches);
// with no prompt or no hit, a lone candidate; otherwise null (unmatched — never guess between panes).
export function matchCandidate(cands, tails, prompt) {
  const ps = (Array.isArray(prompt) ? prompt : [prompt]).map(norm).filter((p) => p.length >= MIN)
  const hits = ps.length ? cands.filter((c) => userTexts(tails.get(c.id)).some((t) => { const n = norm(t); return n.length >= MIN && ps.some((p) => n.startsWith(p) || p.startsWith(n)) })) : []
  if (hits.length === 1) return hits[0]
  if (!hits.length && cands.length === 1) return cands[0]
  return null
}

// Match hints from a pane's tail when it shows no prompt: each `● ` paragraph (wrapped lines joined), not tool calls.
export function paneHints(tail) {
  const out = []
  for (const block of String(tail ?? '').split(/\n(?=\S)/)) {
    const m = block.match(/^● ([\s\S]*)/)
    if (!m || /^\w+\(/.test(m[1])) continue
    out.push(m[1].split('\n').filter((l) => !/^\s*[⎿✔]/.test(l)).join(' ').replace(/\s+/g, ' ').trim())
  }
  return out.slice(-4)
}

// Byte-safe line cutting: `left` (the Buffer leftover, just before `from`) + `buf` (bytes read at offset `from`); returns the complete lines as
// text, the new leftover, and the absolute byte offset just past the last complete line (null: none yet).
export function cutLines(left, buf, from) {
  const all = left.length ? Buffer.concat([left, buf]) : buf
  const at = from - left.length
  const cut = all.lastIndexOf(0x0a)
  if (cut < 0) return { text: '', left: all, end: null }
  return { text: all.subarray(0, cut + 1).toString('utf8'), left: Buffer.from(all.subarray(cut + 1)), end: at + cut + 1 }
}

// One in-flight SSH call per pane, at most `perHost` per host. run() → fn()'s result, or null when skipped.
export class Limiter {
  constructor(perHost = 4) { this.perHost = perHost; this.panes = new Set(); this.hosts = new Map() }
  async run(host, pane, fn) {
    const k = `${host}|${pane}`, n = this.hosts.get(host) ?? 0
    if (this.panes.has(k) || n >= this.perHost) return null
    this.panes.add(k); this.hosts.set(host, n + 1)
    try { return await fn() } finally { this.panes.delete(k); this.hosts.set(host, (this.hosts.get(host) ?? 1) - 1) }
  }
}

// Find the pane's transcript: list candidates, tail each (64 KB), match on the prompt. Throws when unreachable.
export async function locate({ host, cwd, prompt, run = ssh, signal }) {
  const dir = projectDir(cwd)
  if (!dir) return null
  const cands = parseCandidates(await run(host, candidatesScript(dir), { signal }))
  if (!cands.length) return null
  const tails = new Map()
  for (const c of cands.slice(0, 8)) { // ponytail: newest 8 of the week; a busier dir would need a smarter prefilter
    if (signal?.aborted) return null
    tails.set(c.id, String(await run(host, tailScript(dir, c.id, 65_536), { signal })))
  }
  const hit = matchCandidate(cands.slice(0, 8), tails, prompt)
  return hit && { dir, ...hit }
}
