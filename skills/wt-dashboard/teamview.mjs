// WP-237: what the Teams page shows for one team: its members with the agents that fill them, its load, and the
// stage each of its current tickets is in. Pure; the server supplies agents and each ticket's board column.
// A ticket's stage follows its card's column (planning → plan, building → build, review → review); a review card held
// by the agent that fills the team's `qa` stage is in qa.
const STAGE_OF = { planning: 'plan', building: 'build', review: 'review' }

// team: {name, members:[{persona,count}], stages:[{stage,persona}]}; agents: [{name, status, tags:{team,project,persona,role,ticket}}];
// columnOf(ticketId) → card column | undefined. teamOf(ticketId) → the card's team name | null (teamless) | undefined
// (not on a board); WP-247: an agent whose ticket belongs to another team (or none) is flagged offTeam.
export function teamView(team, project, agents, columnOf, teamOf = () => undefined) {
  const mine = agents.filter((a) => a.tags?.team === team.name && a.tags.project === project)
  const qa = team.stages.find((s) => s.stage === 'qa')?.persona
  const tickets = []
  // WP-246: an agent fills the member its persona token names; with no token, the one its name says
  // (<project>-<persona>-NN, as wt-agents names them), else the one its role is. Any other team agent is "other".
  const slot = (a) => {
    const t = a.tags, ps = team.members.map((m) => m.persona)
    if (t.persona) return ps.find((p) => p === t.persona)
    return ps.find((p) => new RegExp(`^${project.replace(/[^\w-]/g, '\\$&')}-${p.replace(/[^\w-]/g, '\\$&')}-\\d+$`).test(a.name)) ?? ps.find((p) => p === t.role)
  }
  const place = (a, persona) => {
    const id = a.tags.ticket || null
    const column = id ? columnOf(id) : undefined
    let stage = STAGE_OF[column] ?? null
    if (stage === 'review' && qa === persona) stage = 'qa'
    if (id && stage && !tickets.some((t) => t.id === id)) tickets.push({ id, stage })
    const ct = id ? teamOf(id) : undefined
    return { name: a.name, status: a.status, ticket: id, stage, ...(ct !== undefined && (ct || null) !== team.name ? { offTeam: true } : {}) }
  }
  const placed = mine.map((a) => [a, slot(a)])
  const members = team.members.map((m) => ({ persona: m.persona, count: m.count, agents: placed.filter(([, p]) => p === m.persona).map(([a]) => place(a, m.persona)) }))
  const other = placed.filter(([, p]) => !p).map(([a]) => place(a, null))
  const up = members.reduce((n, m) => n + m.agents.length, 0)
  const busy = mine.filter((a) => a.status === 'working').length
  return { name: team.name, project, description: team.description, members, other, stages: team.stages, tickets,
    load: { agents: up, of: team.members.reduce((n, m) => n + m.count, 0), working: busy, tickets: tickets.length, other: other.length },
    active: [...new Set(tickets.map((t) => t.stage))] }
}

// WP-247: which teams the dashboard should refill. A team is refilled when it has an open card (`openTeams`: the team
// names of every card not done), fewer agents up than its roster, and was not refilled within `throttleMs` (`lastAt`:
// key → ms). Pure; `views` are teamView() results with a `project`, the key is `<project>/<team>`.
export const REFILL_THROTTLE_MS = 10 * 60_000
export function teamsNeedingRefill(views, openTeams, lastAt, now, throttleMs = REFILL_THROTTLE_MS) {
  return views.filter((v) => openTeams.has(`${v.project}/${v.name}`) && v.load.agents < v.load.of && now - (lastAt.get(`${v.project}/${v.name}`) ?? -Infinity) >= throttleMs)
}
