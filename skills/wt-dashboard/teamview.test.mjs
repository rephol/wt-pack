import { test } from 'node:test'
import assert from 'node:assert/strict'
import { teamView } from './teamview.mjs'

const team = { name: 'web', description: 'd', members: [{ persona: 'planner', count: 1 }, { persona: 'worker', count: 2 }, { persona: 'auditor', count: 1 }],
  stages: [{ stage: 'plan', persona: 'planner' }, { stage: 'build', persona: 'worker' }, { stage: 'qa', persona: 'auditor' }] }
const ag = (name, persona, status, ticket, t = 'web', project = 'demo') => ({ name, status, tags: { team: t, project, persona, ...(ticket ? { ticket } : {}) } })
const col = { 'WP-1': 'building', 'WP-2': 'review', 'WP-3': 'planning' }

test('members are filled by team-tagged agents of the project; load and stages follow their tickets', () => {
  const v = teamView(team, 'demo', [ag('p1', 'planner', 'working', 'WP-3'), ag('w1', 'worker', 'working', 'WP-1'), ag('w2', 'worker', 'idle'),
    ag('q1', 'auditor', 'working', 'WP-2'), ag('other', 'worker', 'working', 'WP-1', 'api'), ag('elsewhere', 'worker', 'working', 'WP-1', 'web', 'other-repo'), { name: 'untagged', status: 'idle', tags: { team: 'web', persona: 'worker' } }], (id) => col[id])
  assert.deepEqual(v.members.map((m) => [m.persona, m.agents.map((a) => a.name)]), [['planner', ['p1']], ['worker', ['w1', 'w2']], ['auditor', ['q1']]])
  assert.deepEqual(v.load, { agents: 4, of: 4, working: 3, tickets: 3 })
  assert.deepEqual(v.tickets, [{ id: 'WP-3', stage: 'plan' }, { id: 'WP-1', stage: 'build' }, { id: 'WP-2', stage: 'qa' }]) // review held by the qa persona = qa
  assert.deepEqual(v.active.sort(), ['build', 'plan', 'qa'])
})
test('no agents up: empty members, zero load; unknown ticket column has no stage', () => {
  const v = teamView(team, 'demo', [ag('w1', 'worker', 'idle', 'WP-9')], () => undefined)
  assert.equal(v.load.agents, 1)
  assert.deepEqual(v.tickets, [])
  assert.deepEqual(teamView(team, 'demo', [], () => undefined).load, { agents: 0, of: 4, working: 0, tickets: 0 })
})
