// WP-237: what the Teams page shows for one team: its members with the agents that fill them, its load, and the
// stage each of its current tickets is in. Pure; the server supplies agents and each ticket's board column.
// A ticket's stage follows its card's column (planning → plan, building → build, review → review); a review card held
// by the agent that fills the team's `qa` stage is in qa.
const STAGE_OF = { planning: 'plan', building: 'build', review: 'review' }

// team: {name, members:[{persona,count}], stages:[{stage,persona}]}; agents: [{name, status, tags:{team,project,persona,role,ticket}}];
// columnOf(ticketId) → card column | undefined.
export function teamView(team, project, agents, columnOf) {
  const mine = agents.filter((a) => a.tags?.team === team.name && a.tags.project === project)
  const qa = team.stages.find((s) => s.stage === 'qa')?.persona
  const tickets = []
  const members = team.members.map((m) => {
    const filled = mine.filter((a) => (a.tags.persona ?? a.tags.role) === m.persona)
    return { persona: m.persona, count: m.count, agents: filled.map((a) => {
      const id = a.tags.ticket || null
      const column = id ? columnOf(id) : undefined
      let stage = STAGE_OF[column] ?? null
      if (stage === 'review' && qa === m.persona) stage = 'qa'
      if (id && stage && !tickets.some((t) => t.id === id)) tickets.push({ id, stage })
      return { name: a.name, status: a.status, ticket: id, stage }
    }) }
  })
  const up = members.reduce((n, m) => n + m.agents.length, 0)
  const busy = mine.filter((a) => a.status === 'working').length
  return { name: team.name, project, description: team.description, members, stages: team.stages, tickets,
    load: { agents: up, of: team.members.reduce((n, m) => n + m.count, 0), working: busy, tickets: tickets.length },
    active: [...new Set(tickets.map((t) => t.stage))] }
}
