// Claude usage for the Overview: plan limits from ccstatusline's cache file, and token spend aggregated from
// Claude Code transcripts (~/.claude/projects/*/*.jsonl). No API calls; the cache file's tokenHash is never read out.
import { readFile, readdir, stat, open as fopen } from 'node:fs/promises'
import { join } from 'node:path'

// $ per million tokens: [input, output, cache write (5m), cache read]. NOTIONAL — on a Claude subscription these
// tokens are not billed per token; this is what the same traffic would cost at API list prices. Input/output
// and the stated cache reads (Opus 5.5 $0.20, Fable 5.1 $0.25) are list prices; the other cache columns use
// the standard multipliers (write 1.25x input, read 0.1x input). A model not listed shows tokens only.
export const PRICES = {
  'claude-opus-5-5': [4, 20, 5, 0.2],
  'claude-opus-5': [5, 25, 6.25, 0.5],
  'claude-opus-4-8': [5, 25, 6.25, 0.5],
  'claude-opus-4-7': [5, 25, 6.25, 0.5],
  'claude-opus-4-6': [5, 25, 6.25, 0.5],
  'claude-fable-5-1': [10, 50, 12.5, 0.25],
  'claude-fable-5': [10, 50, 12.5, 1],
  'claude-sonnet-5': [2, 10, 2.5, 0.2],
  'claude-sonnet-4-6': [3, 15, 3.75, 0.3],
  'claude-haiku-4-5': [1, 5, 1.25, 0.1],
}
const priceOf = (model) => PRICES[model] ?? PRICES[String(model).replace(/-\d{8}$/, '').replace(/\[.*\]$/, '')] ?? null
export function costOf(r) {
  const p = priceOf(r.model)
  return p ? (r.in * p[0] + r.out * p[1] + r.cw * p[2] + r.cr * p[3]) / 1e6 : null
}

// ---- plan limits (ccstatusline) ----
export async function readLimits(file, now = Date.now()) {
  let st
  try { st = await stat(file) } catch { return null }
  let d
  try { d = JSON.parse(await readFile(file, 'utf8')) } catch { return null }
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  const iso = (v) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : null)
  const ageSec = Math.round((now - st.mtimeMs) / 1000)
  // Only named fields leave this function: never tokenHash, never anything unknown.
  return {
    session: num(d.sessionUsage), sessionResetAt: iso(d.sessionResetAt),
    weekly: num(d.weeklyUsage), weeklyResetAt: iso(d.weeklyResetAt),
    weeklySonnet: num(d.weeklySonnetUsage), weeklyOpus: num(d.weeklyOpusUsage),
    fable: num(d.fableUsage), fableResetAt: iso(d.fableResetAt),
    extraUsage: d.extraUsageEnabled === true,
    ageSec, stale: ageSec > 600,
  }
}

// ---- spend from transcripts ----
// One record per assistant message id: streaming writes the same message once per content block with identical
// usage, so the last write wins. Files are read incrementally from a remembered byte offset.
export class UsageAgg {
  constructor({ keepMs = 30 * 86400_000 } = {}) {
    this.files = new Map() // path -> byte offset of the first unread complete line
    this.recs = new Map() // message id -> { ts, session, cwd, model, kind, in, out, cw, cr }
    this.names = new Map() // session id -> the `--name` it ran under (the transcript's agent-name line), so ended agents stay attributed
    this.keepMs = keepMs
  }
  ingest(text, session, kind) {
    for (const l of text.split('\n')) {
      if (l.startsWith('{"type":"agent-name"')) {
        try { const e = JSON.parse(l); if (e.agentName) this.names.set(e.sessionId ?? session, e.agentName) } catch {}
        continue
      }
      if (!l.includes('"usage"') || !l.includes('"assistant"')) continue
      let e
      try { e = JSON.parse(l) } catch { continue }
      const u = e.type === 'assistant' ? e.message?.usage : null
      if (!u) continue
      const id = e.message.id ?? e.requestId ?? e.uuid
      this.recs.set(id, {
        ts: Date.parse(e.timestamp) || 0, session: e.sessionId ?? session, cwd: e.cwd ?? null, model: e.message.model ?? 'unknown', kind,
        in: u.input_tokens ?? 0, out: u.output_tokens ?? 0, cw: u.cache_creation_input_tokens ?? 0, cr: u.cache_read_input_tokens ?? 0,
      })
    }
  }
  // Read what was appended to one file since last time (only complete lines; a partial tail waits).
  // `session` is the id to fall back to when a record carries none of its own (the owning session's uuid,
  // for both a session's own transcript and any subagent transcript under it — not the subagent file's name).
  async readFile(path, size, session, kind) {
    let off = this.files.get(path) ?? 0
    if (size < off) off = 0 // truncated or replaced: start over (records dedupe by id)
    if (size === off) return
    const fh = await fopen(path, 'r')
    try {
      const buf = Buffer.alloc(size - off)
      await fh.read(buf, 0, buf.length, off)
      const end = buf.lastIndexOf(0x0a)
      if (end < 0) return
      this.ingest(buf.subarray(0, end).toString('utf8'), session, kind)
      this.files.set(path, off + end + 1)
    } finally { await fh.close() }
  }
  // Every project transcript touched within the keep window: a session's own <uuid>.jsonl, plus any subagent
  // transcripts it spawned under <uuid>/subagents/*.jsonl (only for a session directory touched since — new
  // subagent files bump their parent directory's mtime, so a directory untouched since stays unread).
  async refresh(root, now = Date.now()) {
    const since = now - this.keepMs
    const fresh = async (p) => { const st = await stat(p).catch(() => null); return st && st.mtimeMs >= since ? st : null }
    for (const d of await readdir(root).catch(() => [])) {
      const dir = join(root, d)
      for (const f of await readdir(dir).catch(() => [])) {
        const p = join(dir, f)
        if (f.endsWith('.jsonl')) {
          const st = await fresh(p)
          if (st) await this.readFile(p, st.size, f.replace(/\.jsonl$/, ''), 'session').catch(() => {})
          continue
        }
        if (!(await fresh(p))) continue // session directory untouched in the keep window: skip its subagents too
        for (const sf of await readdir(join(p, 'subagents')).catch(() => [])) {
          if (!sf.endsWith('.jsonl')) continue
          const sp = join(p, 'subagents', sf)
          const st = await fresh(sp)
          if (st) await this.readFile(sp, st.size, f, 'subagent').catch(() => {})
        }
      }
    }
    for (const [id, r] of this.recs) if (r.ts < since) this.recs.delete(id)
  }
  // Totals since `from` (ms), grouped by `keyOf(record)` → [{key, tokens, cost, n}], largest first.
  summary(from, keyOf) {
    let tokens = 0, cost = 0, priced = true
    const groups = new Map()
    for (const r of this.recs.values()) {
      if (r.ts < from) continue
      const t = r.in + r.out + r.cw + r.cr
      if (!t) continue // e.g. "<synthetic>" placeholder messages
      const c = costOf(r)
      tokens += t
      if (c == null) priced = false; else cost += c
      const k = keyOf(r)
      const g = groups.get(k) ?? { key: k, tokens: 0, cost: 0, n: 0 }
      g.tokens += t; g.cost += c ?? 0; g.n++
      groups.set(k, g)
    }
    return { tokens, cost, priced, groups: [...groups.values()].sort((a, b) => b.tokens - a.tokens) }
  }
}
