// Agents page ordering, applied within each pool group.
export type AgentSort = 'attention' | 'activity' | 'name'
export const SORTS: AgentSort[] = ['attention', 'activity', 'name']
type A = { name: string; status: 'working' | 'idle' | 'blocked' | 'done' | 'unknown' | 'exited' | 'paused' | 'missing'; asks: boolean; statusSince: number; lastActivity?: number }

// WP-349: a paused/missing/exited row has no pane: it never works and never needs you.
export const isLive = (a: { status: string }) => !['paused', 'missing', 'exited'].includes(a.status)
const needsYou = (a: A) => isLive(a) && a.asks && a.status !== 'working'
export const rank = (a: A) => (needsYou(a) ? 0 : ({ working: 1, blocked: 2, idle: 3, unknown: 3, done: 4, exited: 5, paused: 6, missing: 7 } as const)[a.status])
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
export interface ProjectCount { agents: number; working: number; needs: number; notLive: number }
type CA = A & { project: string | null }
export function projectCounts(agents: CA[], known: string[] = []) {
  const zero = (): ProjectCount => ({ agents: 0, working: 0, needs: 0, notLive: 0 })
  const all = zero()
  const by = new Map<string, ProjectCount>(known.map((p) => [p, zero()]))
  for (const a of agents) {
    const slots = [all, ...(a.project ? [by.get(a.project) ?? by.set(a.project, zero()).get(a.project)!] : [])]
    for (const c of slots) { if (isLive(a)) c.agents++; else c.notLive++; if (a.status === 'working') c.working++; if (needsYou(a)) c.needs++ }
  }
  return { all, by: [...by].sort((x, y) => y[1].agents - x[1].agents || x[0].localeCompare(y[0])) }
}
export const countTooltip = (c: ProjectCount) =>
  [`${c.agents} agent${c.agents === 1 ? '' : 's'}`, c.working ? `${c.working} working` : '', c.needs ? `${c.needs} need${c.needs === 1 ? 's' : ''} you` : '', c.notLive ? `${c.notLive} not running` : ''].filter(Boolean).join(' · ')
// WP-349: /api/agents rows /api/overview lacks: headless runs and the agents table's stored (paused/missing/exited) rows.
export const extraAgent = (a: { headless?: boolean; status: string }) => Boolean(a.headless) || !isLive(a)
// Overview agents + those extras, deduped by key, and a stored row never shadows a live pane of the same name.
export function mergeAgents<T extends { key: string; name: string; status: string }>(live: T[], extra: T[]): T[] {
  const keys = new Set(live.map((a) => a.key)), names = new Set(live.map((a) => a.name))
  return [...live, ...extra.filter((a) => !keys.has(a.key) && (isLive(a) || !names.has(a.name)))]
}
// One project list for every picker: stored projects ∪ projects with agents ∪ projects with active cards.
export interface ProjectItem { name: string; paused: boolean; counts: ProjectCount }
export function projectList(stored: { name: string; paused?: boolean }[], agents: CA[], taskProjects: string[]) {
  const c = projectCounts(agents, [...stored.map((p) => p.name), ...taskProjects])
  const paused = new Set(stored.filter((p) => p.paused).map((p) => p.name))
  // paused projects sort to the bottom (stable: the by-agents order holds within each group)
  const by = c.by.map(([name, counts]): ProjectItem => ({ name, paused: paused.has(name), counts })).sort((x, y) => Number(x.paused) - Number(y.paused))
  return { all: c.all, by }
}
