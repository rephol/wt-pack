import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { Pauses, pauseProject, resumeProject, snapshotAgent } from './pause.mjs'

const pane = (name, status = 'idle') => ({ local: true, project: 'p', name, id: `%${name}`, status, cwd: `/tmp/${name}`, session: `s-${name}`, tags: { role: 'worker' }, paneTokens: { role: 'worker', ticket: 'WP-1', model: 'sonnet' } })
const hl = (name, status = 'working') => ({ local: true, project: 'p', name, id: `hl-${name}`, headless: true, status, session: `s-${name}` })
const mk = (agents) => {
  const calls = [], marks = []
  const d = {
    agents: async () => [...agents, { ...pane('other'), project: 'q' }],
    rm: async (id) => calls.push(['rm', id]), stopHeadless: async (id) => calls.push(['stop', id]),
    mark: async (n, v) => marks.push([n, v]),
    spawn: async (a) => (calls.push(['spawn', a.name, a.session, a.tokens?.ticket]), `%new-${a.name}`),
    resumeHeadless: async (id, t) => calls.push(['resume', id, t]), send: async (p, t) => calls.push(['send', p, t]),
  }
  return { d, calls, marks, pauses: new Pauses(() => new DatabaseSync(':memory:')) }
}

test('pause saves then despawns only this project, marking mid-turn agents', async () => {
  const { d, calls, marks, pauses } = mk([pane('a'), pane('b', 'working'), hl('h')])
  const r = await pauseProject('p', pauses, d)
  assert.deepEqual([r.agents, r.midTurn, r.failed], [3, 2, []])
  assert.deepEqual(calls, [['rm', '%a'], ['rm', '%b'], ['stop', 'hl-h']])
  assert.deepEqual(marks, [[['a', 'b', 'h'], true]])
  assert.ok(pauses.has('p') && !pauses.has('q'))
  assert.equal(pauses.get('p').agents[0].tokens.ticket, 'WP-1')
  await assert.rejects(pauseProject('p', pauses, d), /already paused/)
})

test('resume respawns panes with their session and tokens, resumes runs, sends continue only mid-turn', async () => {
  const { d, calls, marks, pauses } = mk([pane('a'), pane('b', 'working'), hl('h')])
  await pauseProject('p', pauses, d); calls.length = 0
  const r = await resumeProject('p', pauses, d)
  assert.equal(r.resumed, 3)
  assert.deepEqual(calls, [['spawn', 'a', 's-a', 'WP-1'], ['spawn', 'b', 's-b', 'WP-1'], ['send', '%new-b', 'continue'], ['resume', 'hl-h', 'continue']])
  assert.deepEqual(marks.at(-1), [['a', 'b', 'h'], false])
  assert.ok(!pauses.has('p'))
  await assert.rejects(resumeProject('p', pauses, d), /not paused/)
})

test('a failed despawn is reported and not respawned; a failed respawn stays paused for a retry', async () => {
  const { d, calls, pauses } = mk([pane('a'), pane('b')])
  d.rm = async (id) => { if (id === '%a') throw new Error('busy'); calls.push(['rm', id]) }
  const r = await pauseProject('p', pauses, d)
  assert.deepEqual(r.failed, [{ name: 'a', error: 'busy' }])
  calls.length = 0
  let fail = true
  const spawn = d.spawn; d.spawn = async (a) => { if (fail) throw new Error('boom'); return spawn(a) }
  const r2 = await resumeProject('p', pauses, d)
  assert.equal(r2.failed[0].name, 'b'); assert.ok(pauses.has('p'))
  fail = false; await resumeProject('p', pauses, d)
  assert.deepEqual(calls, [['spawn', 'b', 's-b', 'WP-1']])
  assert.ok(!pauses.has('p'))
})

test('snapshotAgent keeps headless runs by id', () => {
  assert.deepEqual(snapshotAgent(hl('h')), { kind: 'headless', id: 'hl-h', name: 'h', session: 's-h', midTurn: true })
})
