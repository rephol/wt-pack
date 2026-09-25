// Agents page ordering, applied within each pool group.
export type AgentSort = 'attention' | 'activity' | 'name'
export const SORTS: AgentSort[] = ['attention', 'activity', 'name']
type A = { name: string; status: 'working' | 'idle' | 'blocked' | 'done' | 'unknown'; asks: boolean; statusSince: number; lastActivity?: number }

const needsYou = (a: A) => a.asks && a.status !== 'working'
export const rank = (a: A) => (needsYou(a) ? 0 : ({ working: 1, blocked: 2, idle: 3, unknown: 3, done: 4 } as const)[a.status])
const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
export const activityOf = (a: A) => a.lastActivity || a.statusSince

export function sortAgents<T extends A>(list: T[], by: AgentSort): T[] {
  const byName = (x: T, y: T) => natural.compare(x.name, y.name)
  const cmp = by === 'name' ? byName
    : by === 'activity' ? (x: T, y: T) => activityOf(y) - activityOf(x) || byName(x, y)
    : (x: T, y: T) => rank(x) - rank(y) || byName(x, y)
  return [...list].sort(cmp)
}

// ?sort= wins, then localStorage, else attention.
export function initialSort(search: string, stored: string | null): AgentSort {
  const q = new URLSearchParams(search).get('sort')
  return (SORTS as string[]).includes(q ?? '') ? (q as AgentSort) : (SORTS as string[]).includes(stored ?? '') ? (stored as AgentSort) : 'attention'
}
