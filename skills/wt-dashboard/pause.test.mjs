import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { AgentTable } from './agents-table.mjs'
import { ProjectStore } from './project-store.mjs'
import { pauseAgent, resumeAgent, pauseProject, resumeProject } from './pause.mjs'

const pane = (name, status = 'idle', o = {}) => ({ local: true, project: 'p', name, id: `%${name}`, status, cwd: `/tmp/${name}`, session: `s-${name}`, pool: 'worker',
  paneTokens: { role: 'worker', ticket: 'WP-1', model: 'sonnet', task: 'WP-1 secret', handoff_from: 'o', dnd: '1' }, ...o })
const hl = (name, status = 'working') => ({ local: true, project: 'p', name, id: `hl-${name}`, headless: true, status, session: `s-${name}`, tags: { role: 'worker' } })
const mk = (agents) => {
  const calls = [], marks = [], db = new DatabaseSync(':memory:'), open = () => db
  const table = new AgentTable(open), projects = new ProjectStore(open)
  const d = {
    agents: async () => [...agents, { ...pane('other'), project: 'q' }],
    rm: async (id) => calls.push(['rm', id]), stopHeadless: async (id) => calls.push(['stop', id]), mark: async (n, v) => marks.push([n, v]),
    spawn: async (r) => (calls.push(['spawn', r.name, r.session, r.tags.ticket, r.tags.model]), { pane: `%new-${r.name}` }),
    resumeHeadless: async (id, t) => calls.push(['resume', id, t]), send: async (p, t) => calls.push(['send', p, t]),
  }
  return { d, calls, marks, table, projects }
}

test('pauseAgent: row saved as paused first with mirrored tags only (never task/handoff/dnd), then despawned; the row survives', async () => {
  const { d, calls, table } = mk([pane('a', 'working')])
  const r = await pauseAgent('a', table, d, 5)
  assert.deepEqual(r, { name: 'a', midTurn: true })
  assert.deepEqual(calls, [['rm', '%a']])
  const row = table.get('a')
  assert.deepEqual([row.state, row.paused_at, row.mid_turn, row.session], ['paused', 5, true, 's-a'])
  assert.deepEqual(row.tags, { role: 'worker', ticket: 'WP-1', model: 'sonnet' })
  await assert.rejects(pauseAgent('a', table, d), /already paused/)
})

test('pauseAgent: a failed despawn leaves the agent running (not paused)', async () => {
  const { d, table } = mk([pane('a')])
  d.rm = async () => { throw new Error('busy') }
  await assert.rejects(pauseAgent('a', table, d), /busy/)
  assert.equal(table.get('a').state, 'idle')
})

test('resumeAgent: respawns with the session and tags, row ends idle on the new pane; mid-turn gets one continue', async () => {
  const { d, calls, table } = mk([pane('a', 'working')])
  await pauseAgent('a', table, d); calls.length = 0
  const r = await resumeAgent('a', table, d)
  assert.equal(r.fallback, null)
  assert.deepEqual(calls, [['spawn', 'a', 's-a', 'WP-1', 'sonnet'], ['send', '%new-a', 'continue']])
  const row = table.get('a')
  assert.deepEqual([row.state, row.pane, row.paused_at, row.mid_turn], ['idle', '%new-a', null, false])
  await assert.rejects(resumeAgent('a', table, d), /not paused/)
})

test('project pause pauses every live agent and flags the project; resume brings them back and reports fallbacks', async () => {
  const { d, calls, marks, table, projects } = mk([pane('a'), pane('b', 'working'), hl('h')])
  const r = await pauseProject('p', table, projects, d, 9)
  assert.deepEqual([r.agents, r.midTurn, r.failed], [3, 2, []])
  assert.deepEqual(calls, [['rm', '%a'], ['rm', '%b'], ['stop', 'hl-h']])
  assert.ok(projects.isPaused('p') && !projects.isPaused('q'))
  await assert.rejects(pauseProject('p', table, projects, d), /already paused/)
  calls.length = 0
  d.spawn = async (r) => ({ pane: `%new-${r.name}`, fallback: { from: r.cwd, to: '/repo' } })
  const x = await resumeProject('p', table, projects, d)
  assert.equal(x.resumed, 3); assert.deepEqual(x.fallbacks.map((f) => f.name), ['a', 'b'])
  assert.deepEqual(calls.at(-1), ['resume', 'hl-h', 'continue'])
  assert.ok(!projects.isPaused('p'))
  assert.deepEqual(marks.at(-1), [['h'], false])
})

test('a partial resume failure keeps only the failed agent (and the project) paused; retry resumes the rest', async () => {
  const { d, calls, table, projects } = mk([pane('a'), pane('b')])
  await pauseProject('p', table, projects, d)
  const spawn = d.spawn; let fail = true
  d.spawn = async (r) => { if (fail && r.name === 'b') throw new Error('boom'); return spawn(r) }
  const x = await resumeProject('p', table, projects, d)
  assert.deepEqual([x.resumed, x.failed.map((f) => f.name)], [1, ['b']])
  assert.ok(projects.isPaused('p')); assert.equal(table.get('b').state, 'paused')
  fail = false; calls.length = 0
  await resumeProject('p', table, projects, d)
  assert.deepEqual(calls, [['spawn', 'b', 's-b', 'WP-1', 'sonnet']])
  assert.ok(!projects.isPaused('p'))
})

test('a failed continue after a successful respawn does not strand the row as paused', async () => {
  const { d, table } = mk([pane('a', 'working')])
  await pauseAgent('a', table, d)
  d.send = async () => { throw new Error('pane not ready') }
  const r = await resumeAgent('a', table, d)
  assert.equal(r.sendFailed, 'pane not ready')
  assert.deepEqual([table.get('a').state, table.get('a').pane], ['idle', '%new-a'])
})
