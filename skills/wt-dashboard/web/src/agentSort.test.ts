import test from 'node:test'
import assert from 'node:assert/strict'
import { sortAgents, initialSort } from './agentSort.ts'

const a = (name: string, status: 'working' | 'idle' | 'blocked' | 'done', extra = {}) => ({ name, status, asks: false, statusSince: 0, ...extra })
const L = [a('planner-10', 'idle', { lastActivity: 50 }), a('planner-02', 'working', { lastActivity: 10 }), a('planner-3', 'idle', { asks: true, statusSince: 99 }), a('planner-1', 'done', { lastActivity: 70 })]
const names = (x: { name: string }[]) => x.map((y) => y.name)

test('sortAgents: attention, activity (fallback statusSince), natural name', () => {
  assert.deepEqual(names(sortAgents(L, 'attention')), ['planner-3', 'planner-02', 'planner-10', 'planner-1'])
  assert.deepEqual(names(sortAgents(L, 'activity')), ['planner-3', 'planner-1', 'planner-10', 'planner-02'])
  assert.deepEqual(names(sortAgents(L, 'name')), ['planner-1', 'planner-02', 'planner-3', 'planner-10'])
})

test('initialSort: ?sort= over storage, invalid ignored', () => {
  assert.equal(initialSort('?sort=name', 'activity'), 'name')
  assert.equal(initialSort('?sort=bogus', 'activity'), 'activity')
  assert.equal(initialSort('', null), 'attention')
})

import { projectCounts, countTooltip, rank } from './agentSort.ts'
test('projectCounts: agents only, working and needs-you, tasks-only projects kept at 0', () => {
  const ag = (project: string | null, status: 'working' | 'idle', asks = false) => ({ name: 'x', status, asks, statusSince: 0, project })
  const r = projectCounts([ag('acmeapp', 'working'), ag('acmeapp', 'idle', true), ag('acmeapp', 'idle'), ag('ops', 'idle'), ag(null, 'working')], ['acmeapp', 'tasks-only'])
  assert.deepEqual(r.all, { agents: 5, working: 2, needs: 1, notLive: 0 })
  assert.deepEqual(r.by, [['acmeapp', { agents: 3, working: 1, needs: 1, notLive: 0 }], ['ops', { agents: 1, working: 0, needs: 0, notLive: 0 }], ['tasks-only', { agents: 0, working: 0, needs: 0, notLive: 0 }]])
  assert.equal(countTooltip(r.by[0][1]), '3 agents · 1 working · 1 needs you')
})

import { extraAgent, mergeAgents, projectList } from './agentSort.ts'
const row = (name: string, status: string, project: string | null = 'p', asks = false) => ({ key: `k-${name}-${status}`, name, status: status as 'idle', asks, statusSince: 0, project })
test('extraAgent keeps headless and stored rows, drops live panes', () => {
  assert.deepEqual(['paused', 'missing', 'exited', 'working', 'idle'].map((status) => extraAgent({ status })), [true, true, true, false, false])
  assert.equal(extraAgent({ status: 'idle', headless: true }), true)
})
test('mergeAgents: stored row added, live pane wins over a stored row of the same name', () => {
  const m = mergeAgents([row('a', 'idle')], [row('a', 'paused'), row('b', 'paused')])
  assert.deepEqual(m.map((x) => `${x.name}:${x.status}`), ['a:idle', 'b:paused'])
})
test('a paused or missing row is not working and never needs you', () => {
  const r = projectCounts([row('a', 'paused', 'p', true), row('b', 'missing', 'p', true), row('c', 'idle', 'p', true)])
  assert.deepEqual(r.all, { agents: 1, working: 0, needs: 1, notLive: 2 })
  assert.equal(countTooltip(r.all), '1 agent · 1 needs you · 2 not running')
  assert.ok(rank(row('a', 'paused', 'p', true)) > rank(row('c', 'idle')))
})
test('projectList: stored-only paused, agents-only, cards-only, deduped', () => {
  const l = projectList([{ name: 'porto', paused: true }, { name: 'both' }], [row('x', 'idle', 'agentsonly'), row('y', 'idle', 'both')], ['cardsonly', 'both'])
  assert.deepEqual(l.by.map((p) => `${p.name}${p.paused ? '*' : ''}`).slice().sort(), ['agentsonly', 'both', 'cardsonly', 'porto*'])
  assert.equal(l.by.at(-1)?.name, 'porto') // paused sorts last
})
