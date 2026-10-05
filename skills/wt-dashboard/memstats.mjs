// WP-236: wt-memory analytics from the entry list (`wt-memory list --json`) and the read log
// (~/.local/share/wt-memory/reads.jsonl, lines {at, session, kind: 'inject'|'recall', ids}). Pure; days are UTC like the trailers' `at`.
const DAY = 86_400_000
const day = (t) => new Date(t).toISOString().slice(0, 10)

export function memStats(entries, readsText, { days = 30, now = Date.now() } = {}) {
  const n = Math.min(Math.max(Math.floor(days) || 30, 1), 365)
  const series = new Map()
  for (let i = n - 1; i >= 0; i--) series.set(day(now - i * DAY), { day: day(now - i * DAY), written: { global: 0, role: 0, project: 0 }, inject: 0, recall: 0 })
  const live = entries.filter((e) => !e.pending)
  const byAgent = new Map()
  for (const e of live) {
    const d = series.get(e.at)
    if (!d) continue
    d.written[e.scope] = (d.written[e.scope] ?? 0) + 1
    byAgent.set(e.by, (byAgent.get(e.by) ?? 0) + 1)
  }
  const recalls = new Map() // id -> { n, lastAt }
  for (const line of String(readsText ?? '').split('\n')) {
    let r
    try { r = JSON.parse(line) } catch { continue }
    if (!r || typeof r.at !== 'string' || !Number.isFinite(Date.parse(r.at))) continue
    const d = series.get(day(r.at))
    if (r.kind === 'inject') { if (d) d.inject++ }
    else if (r.kind === 'recall' && Array.isArray(r.ids)) {
      if (d) d.recall++
      for (const id of r.ids) { const x = recalls.get(id) ?? { n: 0, lastAt: '' }; x.n++; if (r.at > x.lastAt) x.lastAt = r.at; recalls.set(id, x) }
    }
  }
  const brief = (e) => ({ id: e.id, text: e.text, scope: e.scope, name: e.name ?? null })
  const cutoff = day(now - 7 * DAY)
  return {
    days: [...series.values()],
    byAgent: [...byAgent].map(([by, count]) => ({ by, count })).sort((a, b) => b.count - a.count || a.by.localeCompare(b.by)),
    top: live.filter((e) => recalls.has(e.id)).map((e) => ({ ...brief(e), recalls: recalls.get(e.id).n, lastAt: recalls.get(e.id).lastAt }))
      .sort((a, b) => b.recalls - a.recalls || (a.lastAt < b.lastAt ? 1 : -1)).slice(0, 10),
    never: live.filter((e) => !recalls.has(e.id) && e.at <= cutoff).map((e) => ({ ...brief(e), by: e.by, at: e.at })),
    pending: entries.length - live.length,
    logPresent: readsText != null,
  }
}
