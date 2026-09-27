// Pure gate for native notifications of inbox items: per-kind toggle, never for quiet (baseline) items,
// suppressed while the user is looking at that agent (side panel or an open dock window), once per item key, ~1 per target per 30s.
export const KINDS = ['question', 'mention-user', 'needs-you', 'room-suggestion', 'agent-done', 'agent-stalled', 'ci-failed', 'server', 'usage', 'room-created', 'memory', 'memory-proposal', 'watchdog'] as const
export type Kind = (typeof KINDS)[number]
export interface InboxItem {
  id: string; ts: string; kind: Kind; key: string; title: string; body: string; read: boolean; resolvedAt: string | null; quiet?: boolean
  urgency?: number // 0-3 from Jev (WT_JEV_INBOX_RANK); absent sorts as 1
  target: { agent?: string; room?: string; task?: string; pr?: string; url?: string | null; memory?: string; watchdog?: string; check?: string }
}
export type KindPrefs = Record<Kind, boolean>
export interface Prefs { inbox: KindPrefs; native: KindPrefs }
const all = (v: boolean, off: Kind[] = []) => Object.fromEntries(KINDS.map((k) => [k, off.includes(k) ? !v : v])) as KindPrefs
export const DEFAULT_PREFS: Prefs = { inbox: all(true), native: all(true, ['room-suggestion', 'server']) }
export const RATE_MS = 30_000

export function gate(e: InboxItem, s: { prefs: Prefs; focused: boolean; openKeys: string[]; seen: Set<string>; lastAt: Map<string, number>; now: number }): boolean {
  if (e.quiet || !s.prefs.native[e.kind] || !s.prefs.inbox[e.kind]) return false
  const target = e.target.agent ?? (e.target.room ? `room:${e.target.room}` : null)
  if (s.focused && target && s.openKeys.includes(target)) return false
  if (s.seen.has(e.key)) return false
  const rk = target ?? e.key
  if (s.now - (s.lastAt.get(rk) ?? -Infinity) < RATE_MS) return false
  s.seen.add(e.key)
  s.lastAt.set(rk, s.now)
  return true
}
export const ACTIONABLE_KINDS: Kind[] = ['question', 'mention-user', 'needs-you', 'room-suggestion', 'memory-proposal']
// "Needs you" everywhere (badge, Inbox section, Overview tile): unresolved and actionable. Read/unread does not matter.
export const needsYou = (it: InboxItem) => !it.resolvedAt && ACTIONABLE_KINDS.includes(it.kind)

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

// Inbox auto-grouping (after collapseRepeats): rows from the same agent, room, task or memory store become one
// expandable group, in order of their newest row. A group of one stays a plain row. Groups then sort by their
// most urgent row (Jev urgency, absent = 1) — a stable sort, so with no urgencies the order is unchanged.
export type Source = 'agent' | 'room' | 'task' | 'memory' | 'other'
export interface InboxGroup { key: string; source: Source; label: string; rows: InboxRow[]; ids: string[]; unread: number }
export function groupOf(it: InboxItem): { key: string; source: Source; label: string } {
  if (it.kind === 'memory' || it.kind === 'memory-proposal') return { key: 'memory', source: 'memory', label: 'Memory' }
  if (it.target.room) return { key: `room:${it.target.room}`, source: 'room', label: `#${it.target.room}` }
  if (it.target.agent) return { key: `agent:${it.target.agent}`, source: 'agent', label: it.title.split(' ')[0] || it.target.agent }
  if (it.target.task || it.target.pr) { const t = it.target.task ?? it.target.pr!; return { key: `task:${t}`, source: 'task', label: t } }
  return { key: `kind:${it.kind}`, source: 'other', label: it.kind === 'server' ? 'Server' : it.kind === 'usage' ? 'Usage' : it.kind }
}
export function groupInbox(rows: InboxRow[]): InboxGroup[] {
  const out: InboxGroup[] = []
  const at = new Map<string, InboxGroup>()
  for (const r of rows) {
    const g0 = groupOf(r)
    let g = at.get(g0.key)
    if (!g) { g = { ...g0, rows: [], ids: [], unread: 0 }; at.set(g0.key, g); out.push(g) }
    g.rows.push(r); g.ids.push(...r.ids); if (r.anyUnread) g.unread++
  }
  const top = (g: InboxGroup) => Math.max(...g.rows.map((r) => r.urgency ?? 1))
  return out.map((g) => [top(g), g] as const).sort((a, b) => b[0] - a[0]).map(([, g]) => g)
}
