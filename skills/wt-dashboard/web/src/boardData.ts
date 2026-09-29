// The local ticket board (docs/plans/local-kanban-plan.md, API contract). Pure, so it is unit-tested.
export const COLUMNS = ['backlog', 'ready', 'planning', 'building', 'review', 'done', 'blocked'] as const
export type Column = (typeof COLUMNS)[number]
export const TYPES = ['bug', 'ux', 'gap', 'debt', 'feature'] as const
export const SIZES = ['S', 'M', 'L'] as const
export interface HistoryEntry { at: string; author: string; kind: 'create' | 'move' | 'comment' | 'edit' | 'assign' | 'pair'; from?: unknown; to?: unknown; text?: string }
// WP-147: worker + buddy pairing. `buddy` is optional (the worker may pair alone); a gone member without a
// replacement leaves that side null but the pairing itself stays until the ticket is Done.
export interface TicketPair { worker: { name: string; pane: string } | null; buddy?: { name: string; pane: string; role: string } | null }
export interface Ticket {
  id: string
  title: string
  body?: string
  type?: string | null
  size?: string | null
  priority?: number | null
  labels?: string[]
  links?: string[]
  column: Column
  assignee?: { name: string; pane?: string } | null
  pair?: TicketPair | null
  created?: string
  updated?: string
  history?: HistoryEntry[]
  jev?: TicketJev | null
  dispatch?: TicketDispatch | null
}
// Board Dispatch (WP-52, dispatch.mjs): claim state, failures, and reconcile's stall flag. `undelivered`
// (WP-177) is distinct from `stalled`: a handoff that never reached the agent at all (resend already tried),
// not a long-idle one that did.
export interface TicketDispatch { state?: 'dispatching' | 'sent' | 'failed' | 'held'; at?: string; agent?: string; fails?: number; reason?: string; stalled?: string; undelivered?: string }
export interface DispatchStatus { last: { at: number; text: string } | null; waiting: string | null; inflight: number }
// The card's dispatch badge, if any: [label, variant, tooltip].
export function dispatchBadge(d?: TicketDispatch | null): [string, 'info' | 'warning' | 'error', string] | null {
  if (!d) return null
  if (d.undelivered) return ['Stalled', 'error', d.undelivered]
  if (d.stalled) return ['Stalled', 'warning', d.stalled]
  if (d.state === 'dispatching') return ['Dispatching…', 'info', 'Handing off to a free agent']
  if (d.state === 'held') return ['Dispatch held', 'error', `Failed ${d.fails ?? 3} times: ${d.reason ?? ''}`]
  if (d.state === 'failed') return ['Dispatch failed', 'warning', `${d.reason ?? ''} (retries in 2 min)`]
  return null
}
// The Board header's status line; null when there is nothing to say.
export function dispatchLine(s?: DispatchStatus | null, now = Date.now()): string | null {
  if (!s) return null
  if (s.inflight) return `Dispatching ${s.inflight}…`
  if (s.waiting) return s.waiting.startsWith('waiting') ? s.waiting : `waiting: ${s.waiting}`
  if (s.last) return `last: ${s.last.text} ${Math.max(0, Math.round((now - s.last.at) / 60_000))}m ago`
  return 'idle'
}
// Server-owned Jev triage (ticketJev.mjs): fields it filled (undoable), advisory owner role, likely duplicates.
export interface TicketJev { at: string; applied: Record<string, { from: unknown; to: unknown }>; owner: 'planner' | 'worker' | null; dupes: string[] }
export const jevChip = (t: Ticket) => !!t.jev && (Object.keys(t.jev.applied).length > 0 || t.jev.dupes.length > 0)
export interface Board { key: string | null; auto?: boolean; minPriority?: number; dispatch?: boolean; stallMin?: number; reportRoom?: string | null; reportOrch?: boolean; dispatchStatus?: DispatchStatus; tickets: Ticket[] }

export const columnLabel = (c: string) => c[0].toUpperCase() + c.slice(1)
// Linear's scale: 0 none, 1 urgent … 4 low.
export const PRIORITY = ['None', 'Urgent', 'High', 'Medium', 'Low']

// WP-90 board search — a copy of tickets.mjs ticketMatches (the web cannot import it: it opens node:sqlite);
// boardData.test.ts runs both over one fixture table so they cannot drift.
export function ticketMatches(t: Ticket, q: string): boolean {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length) return true
  const notes = (t.history ?? []).filter((h) => (h.kind === 'comment' || h.kind === 'move') && h.text).map((h) => h.text as string)
  const hay = [t.id, t.title, t.body ?? '', (t.labels ?? []).join(' '), ...notes].join('\n').toLowerCase()
  return terms.every((w) => hay.includes(w))
}

// Every column present (empty ones too), in board order; within a column, most urgent first, then oldest id.
export function group(tickets: Ticket[]): Record<Column, Ticket[]> {
  const out = Object.fromEntries(COLUMNS.map((c) => [c, [] as Ticket[]])) as Record<Column, Ticket[]>
  const num = (id: string) => Number(id.split('-').pop()) || 0
  const pri = (p?: number | null) => (p ? p : 5) // 0/none sorts last
  for (const t of tickets) (out[t.column] ?? out.backlog).push(t)
  for (const c of COLUMNS) out[c].sort((a, b) => pri(a.priority) - pri(b.priority) || num(a.id) - num(b.id))
  return out
}

// Optimistic move: the board as it will look once the PATCH lands. Unknown id or same column → unchanged.
export function moveTicket(board: Board, id: string, to: Column): Board {
  const t = board.tickets.find((x) => x.id === id)
  if (!t || t.column === to) return board
  return { ...board, tickets: board.tickets.map((x) => (x.id === id ? { ...x, column: to } : x)) }
}
