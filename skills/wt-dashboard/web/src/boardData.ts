// The local ticket board (docs/plans/local-kanban-plan.md, API contract). Pure, so it is unit-tested.
// WP-254: the enums and the API shapes live in skills/wt-dashboard/contracts.mjs (+ contracts.d.mts); re-exported here.
import { COLUMNS, TYPES, SIZES } from '../../contracts.mjs'
import type { Column, HistoryEntry, TicketPair, Ticket, TicketMessages, TicketDispatch, DispatchStatus, TicketJev, Board } from '../../contracts.mjs'
export { COLUMNS, TYPES, SIZES }
export type { Column, HistoryEntry, TicketPair, Ticket, TicketMessages, TicketDispatch, DispatchStatus, TicketJev, Board }
// The card's message badge, if any: [label, variant, tooltip]. Answered/acknowledged stay quiet-blue, a lost one is an error.
export function messageBadge(m?: TicketMessages | null): [string, 'info' | 'warning' | 'error', string] | null {
  if (!m?.last) return null
  const { kind, state, attempts, target } = m.last
  const tip = `${kind} → ${target}${attempts > 1 ? `, sent ${attempts}×` : ''}`
  if (state === 'expired') return ['No ack', 'error', `${tip}: never acknowledged`]
  if (state === 'failed') return ['Msg failed', 'error', tip]
  if (state === 'queued') return ['Msg queued', 'info', tip]
  if (state === 'delivered') return [attempts > 1 ? `Resent ×${attempts - 1}` : 'Msg sent', attempts > 1 ? 'warning' : 'info', `${tip}: waiting for an ack`]
  return [state === 'answered' ? 'Answered' : 'Acked', 'info', tip]
}
// The card's dispatch badge, if any: [label, variant, tooltip].
export function dispatchBadge(d?: TicketDispatch | null): [string, 'info' | 'warning' | 'error', string] | null {
  if (!d) return null
  if (d.undelivered) return ['Stalled', 'error', d.undelivered]
  if (d.stalled) return ['Stalled', 'warning', d.stalled]
  if (d.state === 'dispatching') return ['Dispatching…', 'info', 'Handing off to a free agent']
  if (d.state === 'held') return ['Dispatch held', 'error', `Failed ${d.fails ?? 3} times: ${d.reason ?? ''}`]
  if (d.state === 'interrupted') return ['Interrupted', 'warning', d.reason ?? 'Interrupted by a restart']
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
export const jevChip = (t: Ticket) => !!t.jev && (Object.keys(t.jev.applied).length > 0 || t.jev.dupes.length > 0)

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
