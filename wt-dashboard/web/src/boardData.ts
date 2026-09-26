// The local ticket board (docs/plans/local-kanban-plan.md, API contract). Pure, so it is unit-tested.
export const COLUMNS = ['backlog', 'ready', 'planning', 'building', 'review', 'done', 'blocked'] as const
export type Column = (typeof COLUMNS)[number]
export const TYPES = ['bug', 'ux', 'gap', 'debt', 'feature'] as const
export const SIZES = ['S', 'M', 'L'] as const
export interface HistoryEntry { at: string; author: string; kind: 'create' | 'move' | 'comment' | 'edit' | 'assign'; from?: string; to?: string; text?: string }
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
  created?: string
  updated?: string
  history?: HistoryEntry[]
}
export interface Board { key: string | null; tickets: Ticket[] }

export const columnLabel = (c: string) => c[0].toUpperCase() + c.slice(1)
// Linear's scale: 0 none, 1 urgent … 4 low.
export const PRIORITY = ['None', 'Urgent', 'High', 'Medium', 'Low']

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
