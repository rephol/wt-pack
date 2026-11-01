// Run: node --test blockedq.test.mjs — WP-378: a send to a blocked agent waits behind it (never forced), in order, and is not lost silently.
import test from 'node:test'
import assert from 'node:assert/strict'
import { BlockedQueue } from './blockedq.mjs'

const mk = () => { let t = 1000; const q = new BlockedQueue({ now: () => t, maxAgeMs: 100 }); return { q, tick: (ms) => { t += ms } } }

test('held while the agent is blocked, typed in order once it is not', async () => {
  const { q } = mk(), typed = []
  q.add('t1', { id: 'a', run: async () => typed.push('a') }); q.add('t1', { id: 'b', run: async () => typed.push('b') })
  assert.equal(q.has('a'), true)
  await q.flush(() => 'blocked')
  assert.deepEqual(typed, []); assert.equal(q.size(), 2)
  await q.flush(() => 'idle')
  assert.deepEqual(typed, ['a', 'b']); assert.equal(q.size(), 0); assert.equal(q.has('a'), false)
})

test('a send that meets a block again stays queued (and holds back the ones behind it)', async () => {
  const { q } = mk(), typed = []
  let n = 0
  q.add('t1', { id: 'a', run: async () => { if (n++ === 0) throw Object.assign(new Error('blocked'), { kind: 'blocked' }); typed.push('a') } })
  q.add('t1', { id: 'b', run: async () => typed.push('b') })
  await q.flush(() => 'done')
  assert.deepEqual(typed, []); assert.equal(q.size(), 2)
  await q.flush(() => 'done')
  assert.deepEqual(typed, ['a', 'b'])
})

test('a gone agent, a hard error and an old entry are reported once, never retried', async () => {
  const { q, tick } = mk(), gone = []
  q.add('t1', { id: 'g', run: async () => { throw new Error('boom') } })
  await q.flush(() => 'idle', (e, why) => gone.push([e.id, why]))
  assert.deepEqual(gone, [['g', 'boom']])
  q.add('t2', { id: 'x', run: async () => {} })
  await q.flush((p) => (p === 't2' ? undefined : 'idle'), (e, why) => gone.push([e.id, why]))
  assert.deepEqual(gone.at(-1), ['x', 'the agent is gone'])
  q.add('t3', { id: 'o', run: async () => {} }); tick(500)
  await q.flush(() => 'blocked', (e, why) => gone.push([e.id, why]))
  assert.deepEqual(gone.at(-1), ['o', 'blocked too long']); assert.equal(q.size(), 0)
})

test('an unreadable status counts as blocked, not as free', async () => {
  const { q } = mk(), typed = []
  q.add('t1', { run: async () => typed.push(1) })
  await q.flush(() => { throw new Error('hc down') })
  assert.deepEqual(typed, []); assert.equal(q.size(), 1)
})
