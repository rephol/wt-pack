// Pure helpers for the Overview tiles (tested in overviewData.test.ts).
export type ProjectAgents = { project: string; working: number; idle: number; blocked: number }

// Agents per project by state, busiest first; agents without a project group under "other".
export function agentsByProject(agents: { project: string | null; status: string }[]): ProjectAgents[] {
  const m = new Map<string, ProjectAgents>()
  for (const a of agents) {
    const p = a.project ?? 'other'
    const g = m.get(p) ?? { project: p, working: 0, idle: 0, blocked: 0 }
    if (a.status === 'working' || a.status === 'idle' || a.status === 'blocked') g[a.status]++
    m.set(p, g)
  }
  return [...m.values()].sort((a, b) => b.working - a.working || b.blocked - a.blocked || a.project.localeCompare(b.project))
}

// The rooms with the most recent message, newest first.
export function recentRooms<R extends { lastAt?: string | null; archived?: boolean }>(rooms: R[], n = 3): R[] {
  return rooms.filter((r) => r.lastAt && !r.archived).sort((a, b) => b.lastAt!.localeCompare(a.lastAt!)).slice(0, n)
}

// Headline tiles count what Tasks shows by default ("Mine"), so a tile and the page it links to agree.
export function tileCounts(tasks: { state: string; mine?: boolean }[]) {
  const mine = tasks.filter((t) => t.mine !== false)
  const n = (s: string) => mine.filter((t) => t.state === s).length
  return { needsYou: n('needs_you'), stalled: n('stalled'), inReview: n('in_review') }
}
