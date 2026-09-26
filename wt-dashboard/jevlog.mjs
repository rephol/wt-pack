// Reads the Jev call log that wt-shared/scripts/typesafe.mjs judge() appends (CLIs and server alike):
// one {ts, feature, outcome, p, ms, cache, err, in} per line, plus the rotated `.1` file.
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const JEV_LOG = process.env.WT_JEV_LOG || join(homedir(), '.local', 'share', 'wt-dashboard', 'jev-calls.jsonl')

export async function readCalls(file = JEV_LOG) {
  const texts = await Promise.all([file + '.1', file].map((f) => readFile(f, 'utf8').catch(() => '')))
  const out = []
  for (const l of texts.join('\n').split('\n')) {
    if (!l) continue
    try { const r = JSON.parse(l); if (r?.ts && r.feature) out.push(r) } catch {}
  }
  return out
}

// /api/health: a summary only; the full stats are in Settings › Observability.
export function healthSummary(calls, now = Date.now()) {
  const day = calls.filter((c) => now - Date.parse(c.ts) < 86_400_000)
  return { today: day.length, errors: day.filter((c) => c.err).length }
}

const pctl = (xs, f) => (xs.length ? xs[Math.min(xs.length - 1, Math.floor(f * xs.length))] : null)

// Per feature over the window: calls, cache hits, fail-opens, error/timeout rate, p50/p95 of real (uncached) calls.
export function featureStats(calls, windowMs, now = Date.now()) {
  const by = {}
  for (const c of calls) if (now - Date.parse(c.ts) < windowMs) (by[c.feature] ??= []).push(c)
  return Object.entries(by).map(([feature, cs]) => {
    const live = cs.filter((c) => !c.cache)
    const ms = live.map((c) => c.ms).filter((n) => typeof n === 'number').sort((a, b) => a - b)
    const rate = (n) => (live.length ? Math.round((n / live.length) * 100) / 100 : 0)
    return {
      feature, calls: cs.length, cacheHits: cs.length - live.length,
      failOpen: cs.filter((c) => c.outcome === 'failopen').length,
      picked: cs.filter((c) => c.outcome === 'picked').length,
      errorRate: rate(live.filter((c) => c.err).length), timeoutRate: rate(live.filter((c) => c.err === 'timeout').length),
      p50ms: pctl(ms, 0.5), p95ms: pctl(ms, 0.95),
    }
  }).sort((a, b) => b.calls - a.calls)
}

// Newest first, filtered by exact feature / outcome / err ('none' = no error).
export function recentCalls(calls, { feature, outcome, err } = {}, n = 200) {
  return calls.filter((c) => (!feature || c.feature === feature) && (!outcome || c.outcome === outcome)
    && (!err || (err === 'none' ? !c.err : c.err === err))).slice(-n).reverse()
}

// Last n lines of a text, n clamped to 1..2000.
export function tailLines(text, n) {
  const k = Math.min(2000, Math.max(1, Number(n) || 500))
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines.slice(-k)
}
