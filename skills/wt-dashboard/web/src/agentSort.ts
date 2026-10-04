// Agents page ordering, applied within each pool group.
export type AgentSort = 'attention' | 'activity' | 'name'
export const SORTS: AgentSort[] = ['attention', 'activity', 'name']
type A = { name: string; status: 'working' | 'idle' | 'blocked' | 'done' | 'unknown' | 'exited'; asks: boolean; statusSince: number; lastActivity?: number }

const needsYou = (a: A) => a.asks && a.status !== 'working'
export const rank = (a: A) => (needsYou(a) ? 0 : ({ working: 1, blocked: 2, idle: 3, unknown: 3, done: 4, exited: 5 } as const)[a.status])
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

// Sidebar project counts: AGENTS only (the same agent list and `project` field the Agents page uses, local and
// remote), plus how many are working and how many need you. Tasks are not counted. `known` keeps a project that
// has tasks but no agents listed (with 0) so it can still be picked as the scope.
export interface ProjectCount { agents: number; working: number; needs: number }
type CA = A & { project: string | null }
export function projectCounts(agents: CA[], known: string[] = []) {
  const zero = (): ProjectCount => ({ agents: 0, working: 0, needs: 0 })
  const all = zero()
  const by = new Map<string, ProjectCount>(known.map((p) => [p, zero()]))
  for (const a of agents) {
    const slots = [all, ...(a.project ? [by.get(a.project) ?? by.set(a.project, zero()).get(a.project)!] : [])]
    for (const c of slots) { c.agents++; if (a.status === 'working') c.working++; if (needsYou(a)) c.needs++ }
  }
  return { all, by: [...by].sort((x, y) => y[1].agents - x[1].agents || x[0].localeCompare(y[0])) }
}
export const countTooltip = (c: ProjectCount) =>
  [`${c.agents} agent${c.agents === 1 ? '' : 's'}`, c.working ? `${c.working} working` : '', c.needs ? `${c.needs} need${c.needs === 1 ? 's' : ''} you` : ''].filter(Boolean).join(' · ')
