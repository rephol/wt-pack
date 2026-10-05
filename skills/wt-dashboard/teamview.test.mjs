import { test } from 'node:test'
import assert from 'node:assert/strict'
import { teamView, teamsNeedingRefill } from './teamview.mjs'

const team = { name: 'web', description: 'd', members: [{ persona: 'planner', count: 1 }, { persona: 'worker', count: 2 }, { persona: 'auditor', count: 1 }],
  stages: [{ stage: 'plan', persona: 'planner' }, { stage: 'build', persona: 'worker' }, { stage: 'qa', persona: 'auditor' }] }
const ag = (name, persona, status, ticket, t = 'web', project = 'demo') => ({ name, status, tags: { team: t, project, persona, ...(ticket ? { ticket } : {}) } })
const col = { 'WP-1': 'building', 'WP-2': 'review', 'WP-3': 'planning' }

test('members are filled by team-tagged agents of the project; load and stages follow their tickets', () => {
  const v = teamView(team, 'demo', [ag('p1', 'planner', 'working', 'WP-3'), ag('w1', 'worker', 'working', 'WP-1'), ag('w2', 'worker', 'idle'),
    ag('q1', 'auditor', 'working', 'WP-2'), ag('other', 'worker', 'working', 'WP-1', 'api'), ag('elsewhere', 'worker', 'working', 'WP-1', 'web', 'other-repo'), { name: 'untagged', status: 'idle', tags: { team: 'web', persona: 'worker' } }], (id) => col[id])
  assert.deepEqual(v.members.map((m) => [m.persona, m.agents.map((a) => a.name)]), [['planner', ['p1']], ['worker', ['w1', 'w2']], ['auditor', ['q1']]])
  assert.deepEqual(v.load, { agents: 4, of: 4, working: 3, tickets: 3, other: 0 })
  assert.deepEqual(v.tickets, [{ id: 'WP-3', stage: 'plan' }, { id: 'WP-1', stage: 'build' }, { id: 'WP-2', stage: 'qa' }]) // review held by the qa persona = qa
  assert.deepEqual(v.active.sort(), ['build', 'plan', 'qa'])
})
test('no agents up: empty members, zero load; unknown ticket column has no stage', () => {
  const v = teamView(team, 'demo', [ag('w1', 'worker', 'idle', 'WP-9')], () => undefined)
  assert.equal(v.load.agents, 1)
  assert.deepEqual(v.tickets, [])
  assert.deepEqual(teamView(team, 'demo', [], () => undefined).load, { agents: 0, of: 4, working: 0, tickets: 0, other: 0 })
})
test('WP-246: a persona-less agent fills the member its name or role says; the rest are "other", with their tickets counted', () => {
  const noPersona = (name, role, status, ticket) => ({ name, status, tags: { team: 'web', project: 'demo', ...(role ? { role } : {}), ...(ticket ? { ticket } : {}) } })
  const v = teamView(team, 'demo', [noPersona('demo-planner-01', 'planner', 'idle'), noPersona('hand-started', 'worker', 'working', 'WP-1'),
    noPersona('demo-auditor-02', undefined, 'idle'), noPersona('demo-designer-01', 'designer', 'working', 'WP-3'), ag('w9', 'ghost', 'idle')], (id) => col[id])
  assert.deepEqual(v.members.map((m) => [m.persona, m.agents.map((a) => a.name)]), [['planner', ['demo-planner-01']], ['worker', ['hand-started']], ['auditor', ['demo-auditor-02']]])
  assert.deepEqual(v.other.map((a) => a.name), ['demo-designer-01', 'w9']) // a persona token no member names stays "other" even if its role would fit
  assert.deepEqual(v.load, { agents: 3, of: 4, working: 2, tickets: 2, other: 2 })
})

test('WP-247: an agent on a ticket of another team, or a teamless one, is flagged offTeam; unknown tickets are not', () => {
  const teamOf = (id) => ({ 'WP-1': 'web', 'WP-2': 'api', 'WP-3': null })[id]
  const v = teamView(team, 'demo', [ag('a', 'worker', 'working', 'WP-1'), ag('b', 'worker', 'working', 'WP-2'), ag('c', 'planner', 'working', 'WP-3'), ag('d', 'auditor', 'working', 'WP-9'), ag('e', 'worker', 'idle')], (id) => col[id], teamOf)
  assert.deepEqual(v.members.flatMap((m) => m.agents).map((a) => [a.name, !!a.offTeam]), [['c', true], ['a', false], ['b', true], ['e', false], ['d', false]])
})
test('WP-247: refill = an open card, fewer agents than the roster, and not within 10 minutes of the last refill', () => {
  const view = (name, agents, of = 4, project = 'demo') => ({ name, project, load: { agents, of } })
  const open = new Set(['demo/web', 'demo/api', 'demo/full', 'demo/recent'])
  const last = new Map([['demo/recent', 1_000_000]])
  const now = 1_000_000 + 9 * 60_000
  const names = (vs) => vs.map((v) => v.name)
  assert.deepEqual(names(teamsNeedingRefill([view('web', 1), view('api', 0), view('full', 4), view('idle', 1), view('recent', 1), view('web', 1, 4, 'other')], open, last, now)), ['web', 'api'])
  assert.deepEqual(names(teamsNeedingRefill([view('recent', 1)], open, last, 1_000_000 + 10 * 60_000)), ['recent']) // exactly 10 minutes later
})
