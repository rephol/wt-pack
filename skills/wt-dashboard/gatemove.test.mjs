// WP-239: the PATCH guard against a real Tickets store, with the gate evaluation of wt-shared/gates.mjs over a fake repo.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Tickets } from './tickets.mjs'
import { guardMove } from './gatemove.mjs'
import { evaluate, crossed, origin } from '../wt-shared/scripts/gates.mjs'

const user = { name: 'Rep' }
const setup = async (enabled = ['plan', 'build', 'review']) => {
  const tickets = new Tickets({ dir: await mkdtemp(join(tmpdir(), 'gatemove-')) })
  const t = await tickets.create('demo', { title: 'x', column: 'building' }, user)
  const state = async (cur) => ({ gates: evaluate(cur, enabled, { plan: 'docs/plans/x.md' }), crossed: (to) => crossed(enabled, origin(cur), to) })
  // the route: guard, then the patch, then the override comment
  const move = async (to, force) => {
    const cur = await tickets.get(t.id)
    const gm = await guardMove({ tickets, state }, cur, to, force, user)
    if (!gm.ok) return { status: gm.status, body: gm.body }
    await tickets.patch(t.id, { column: to }, user)
    await gm.afterMove?.()
    return { status: 200 }
  }
  const gateNotes = async () => (await tickets.get(t.id)).history.filter((h) => h.author === 'gates').map((h) => h.text)
  return { tickets, t, move, gateNotes, col: async () => (await tickets.get(t.id)).column }
}

test('a refused move → 409 with the reasons, the card stays, exactly one gates comment (a retry adds none)', async () => {
  const { move, gateNotes, col } = await setup()
  const r = await move('review')
  assert.equal(r.status, 409)
  assert.match(r.body.error, /gate blocked building → review: build: no "tests: green" comment/)
  assert.deepEqual(r.body.gates.map((g) => g.stage), ['build'])
  assert.equal(await col(), 'building')
  assert.equal((await gateNotes()).length, 1)
  assert.equal((await move('review')).status, 409)
  assert.equal((await gateNotes()).length, 1)
})
test('--force → the move lands and one override comment names who and which gates', async () => {
  const { move, gateNotes, col } = await setup()
  assert.equal((await move('review', true)).status, 200)
  assert.equal(await col(), 'review')
  assert.deepEqual(await gateNotes(), ['gate overridden by Rep: build'])
})
test('evidence on the card lets the move through with no gates comment; ungated and backward moves are never guarded', async () => {
  const { tickets, t, move, gateNotes, col } = await setup()
  await tickets.comment(t.id, 'tests: green 10/10', user)
  await tickets.comment(t.id, 'tip: 055e165', user)
  assert.equal((await move('review')).status, 200)
  assert.equal(await col(), 'review')
  assert.deepEqual(await gateNotes(), [])
  assert.equal((await move('building')).status, 200) // backward
  const none = await setup([])
  assert.equal((await none.move('done')).status, 200) // no gates on
})
test('a gate that cannot be evaluated fails open', async () => {
  const { tickets, t } = await setup()
  const gm = await guardMove({ tickets, state: async () => { throw new Error('git exploded') } }, await tickets.get(t.id), 'done', undefined, user)
  assert.deepEqual(gm, { ok: true })
})
