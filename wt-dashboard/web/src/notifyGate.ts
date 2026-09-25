// Pure gate for native notifications of inbox items: per-kind toggle, never for quiet (baseline) items,
// suppressed while the user is looking at that agent, once per item key, ~1 per target per 30s.
export const KINDS = ['question', 'mention-user', 'needs-you', 'room-suggestion', 'agent-done', 'agent-stalled', 'ci-failed', 'server', 'usage'] as const
export type Kind = (typeof KINDS)[number]
export interface InboxItem {
  id: string; ts: string; kind: Kind; key: string; title: string; body: string; read: boolean; resolvedAt: string | null; quiet?: boolean
  target: { agent?: string; room?: string; task?: string; pr?: string; url?: string | null }
}
export type KindPrefs = Record<Kind, boolean>
export interface Prefs { inbox: KindPrefs; native: KindPrefs }
const all = (v: boolean, off: Kind[] = []) => Object.fromEntries(KINDS.map((k) => [k, off.includes(k) ? !v : v])) as KindPrefs
export const DEFAULT_PREFS: Prefs = { inbox: all(true), native: all(true, ['room-suggestion', 'server']) }
export const RATE_MS = 30_000

export function gate(e: InboxItem, s: { prefs: Prefs; focused: boolean; openKey: string | null; seen: Set<string>; lastAt: Map<string, number>; now: number }): boolean {
  if (e.quiet || !s.prefs.native[e.kind] || !s.prefs.inbox[e.kind]) return false
  const target = e.target.agent ?? (e.target.room ? `room:${e.target.room}` : null)
  if (s.focused && target && target === s.openKey) return false
  if (s.seen.has(e.key)) return false
  const rk = target ?? e.key
  if (s.now - (s.lastAt.get(rk) ?? -Infinity) < RATE_MS) return false
  s.seen.add(e.key)
  s.lastAt.set(rk, s.now)
  return true
}
export const ACTIONABLE_KINDS: Kind[] = ['question', 'mention-user', 'needs-you', 'room-suggestion']

// Repeats of the same non-actionable event (an agent "is done" three times) show as one row with a count.
// The newest item stands for the group; `ids` carries every member so read/clear act on all of them.
export type InboxRow = InboxItem & { ids: string[]; count: number; anyUnread: boolean }
export function collapseRepeats(items: InboxItem[]): InboxRow[] {
  const out: InboxRow[] = []
  const at = new Map<string, InboxRow>()
  for (const it of items) {
    const k = ACTIONABLE_KINDS.includes(it.kind) ? null : `${it.kind}\u0000${it.title}`
    const g = k ? at.get(k) : undefined
    if (g) { g.ids.push(it.id); g.count++; g.anyUnread ||= !it.read; continue }
    const row = { ...it, ids: [it.id], count: 1, anyUnread: !it.read }
    out.push(row)
    if (k) at.set(k, row)
  }
  return out
}
// "now", "1m", "10m", "3h", "2d".
export function shortAgo(ts: string, now = Date.now()) {
  const s = Math.max(0, (now - Date.parse(ts)) / 1000)
  return s < 45 ? 'now' : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`
}
