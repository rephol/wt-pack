// Run: node --test recovery.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Tickets } from './tickets.mjs'
import { sweep } from './recovery.mjs'

async function setup(agents, extra = {}) {
  const tickets = new Tickets({ dir: await mkdtemp(join(tmpdir(), 'recovery-')) })
  await tickets.board('wt-pack')
  const mk = async (title, column, assignee) => {
    const t = await tickets.create('wt-pack', { title, column }, { name: 'Rep' })
    return assignee ? tickets.mutate(t.id, (c) => ({ ...c, assignee })) : t
  }
  const notes = [], keys = []
  const deps = { agents: async () => agents, notify: (i) => notes.push(i), redispatch: async (t, { key }) => (keys.push(key), true), ...extra }
  return { tickets, mk, notes, keys, deps }
}
const live = { name: 'w-1', id: 'p1', local: true, status: 'working' }

test('a card whose agent is gone is re-dispatched through the seam, with a key', async () => {
  const { tickets, mk, notes, keys, deps } = await setup([live])
  const t = await mk('a', 'building', { name: 'w-2', pane: 'p2' })
  const r = await sweep({ tickets, deps })
  assert.deepEqual(r, [{ id: t.id, redispatched: true }])
  assert.equal(keys.length, 1)
  assert.match(notes[0].title, /interrupted/)
})

test('without a re-dispatch the card is flagged interrupted, once', async () => {
  const { tickets, mk, notes, deps } = await setup([live], { redispatch: async () => false })
  const t = await mk('a', 'planning', { name: 'w-2', pane: 'p2' })
  await sweep({ tickets, deps })
  const c = await tickets.get(t.id)
  assert.equal(c.dispatch.state, 'interrupted')
  assert.match(c.history.at(-1).text, /^interrupted: .*w-2 is gone/)
  assert.deepEqual(await sweep({ tickets, deps }), []) // already flagged
  assert.equal(notes.length, 1)
})

test('live agents, human assignees, other columns and a herdr outage are left alone', async () => {
  const { tickets, mk, deps } = await setup([live])
  await mk('live', 'building', { name: 'w-1', pane: 'p1' })
  await mk('human', 'building', { name: 'Rep' }) // no pane
  await mk('ready', 'ready', { name: 'w-2', pane: 'p2' })
  assert.deepEqual(await sweep({ tickets, deps }), [])
  await mk('gone', 'building', { name: 'w-3', pane: 'p3' })
  assert.deepEqual(await sweep({ tickets, deps: { ...deps, agents: async () => [] } }), [])
})

test('a paired card is flagged, never re-dispatched', async () => {
  const { tickets, mk, keys, deps } = await setup([live])
  const t = await mk('p', 'building', { name: 'w-2', pane: 'p2' })
  await tickets.mutate(t.id, (c) => ({ ...c, pair: { worker: { name: 'w-2', pane: 'p2' }, buddy: { name: 'b', pane: 'p9' } } }))
  const r = await sweep({ tickets, deps })
  assert.equal(r[0].redispatched, false)
  assert.equal(keys.length, 0)
})
