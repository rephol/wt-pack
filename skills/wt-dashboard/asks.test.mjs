// Run: node --test asks.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Asks, clean } from './asks.mjs'

const tmp = () => mkdtemp(join(tmpdir(), 'asks-'))
const author = { pane: 'w1:p2', name: 'wt-pack-worker-01' }
const q = (over = {}) => ({ questions: [{ question: 'Which?', header: 'Pick one', options: [{ label: 'A' }, { label: 'B' }] }], room: 'wt-pack', ...over })

test('clean: rejects bad shapes', () => {
  assert.throws(() => clean({ questions: [] }), /questions: 1-4/)
  assert.throws(() => clean({ questions: [{ question: '', header: 'h', options: [{ label: 'A' }] }] }), /question/)
  assert.throws(() => clean({ questions: [{ question: 'q', header: 'h', options: [] }] }), /options/)
  assert.throws(() => clean({ questions: [{ question: 'q', header: 'h', options: [{ label: 'A' }], recommended: 'Z' }] }), /recommended/)
  assert.doesNotThrow(() => clean(q()))
})

test('create: notifies and stores an open ask', async () => {
  const dir = await tmp()
  const a = new Asks({ dir, notify: async (d) => ({ id: 'n1', ...d }) })
  const created = await a.create(q(), author)
  assert.equal(created.status, 'open')
  assert.equal(created.pane, author.pane)
  assert.equal((await a.get(created.id)).status, 'open')
})

test('answer: delivers, closes, and resolves the inbox item', async () => {
  const dir = await tmp()
  const delivered = []
  let resolvedKey
  const a = new Asks({ dir, notify: async (d) => ({ id: 'n1', ...d }), resolveNotify: async (k) => { resolvedKey = k }, deliver: async (pane, text) => delivered.push([pane, text]) })
  const created = await a.create(q(), author)
  const out = await a.answer(created.id, { selected: [['A']] }, { name: 'Rep' })
  assert.equal(out.status, 'answered')
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0][0], author.pane)
  assert.equal(resolvedKey, `ask:${created.id}`)
})

test('answer on a closed ask → 409', async () => {
  const dir = await tmp()
  const a = new Asks({ dir, notify: async (d) => ({ id: 'n1', ...d }) })
  const created = await a.create(q(), author)
  await a.answer(created.id, { selected: [['A']] }, { name: 'Rep' })
  await assert.rejects(a.answer(created.id, { selected: [['B']] }, { name: 'Rep' }), (e) => e.status === 409)
})

// WP-169: a second answer (e.g. one from the room chip, one from the Inbox, both reading status='open')
// must be rejected before it reaches `deliver` — otherwise the pane gets two conflicting replies even
// though only the first answer is ever saved.
test('answer on a closed ask → does not deliver a second time', async () => {
  const dir = await tmp()
  const delivered = []
  const a = new Asks({ dir, notify: async (d) => ({ id: 'n1', ...d }), deliver: async (pane, text) => delivered.push([pane, text]) })
  const created = await a.create(q(), author)
  await a.answer(created.id, { selected: [['A']] }, { name: 'Rep' })
  await assert.rejects(a.answer(created.id, { selected: [['B']] }, { name: 'Rep' }), (e) => e.status === 409)
  assert.equal(delivered.length, 1)
  assert.match(delivered[0][1], /A/)
})

test('resolve by a different pane → 403', async () => {
  const dir = await tmp()
  const a = new Asks({ dir, notify: async (d) => ({ id: 'n1', ...d }) })
  const created = await a.create(q(), author)
  await assert.rejects(a.resolve(created.id, 'w9:p9'), (e) => e.status === 403)
  const out = await a.resolve(created.id, author.pane)
  assert.equal(out.status, 'resolved')
})

test('answer: a gone pane → undeliverable, keeps the answer', async () => {
  const dir = await tmp()
  const a = new Asks({ dir, notify: async (d) => ({ id: 'n1', ...d }), deliver: async () => { throw new Error('unknown pane') } })
  const created = await a.create(q(), author)
  const out = await a.answer(created.id, { selected: [['A']] }, { name: 'Rep' })
  assert.equal(out.status, 'undeliverable')
  assert.deepEqual(out.answer.selected, [['A']])
})

// WP-206: the plugin mod waits on the ask and returns the answer as the tool result, so no wt-message goes out.
test('noDeliver: answer closes the ask without delivering', async () => {
  const dir = await tmp()
  const delivered = []
  const a = new Asks({ dir, notify: async (d) => ({ id: 'n1', ...d }), deliver: async (p, t) => delivered.push([p, t]) })
  const created = await a.create(q({ noDeliver: true }), author)
  const out = await a.answer(created.id, { selected: [['A']] }, { name: 'Rep' })
  assert.equal(out.status, 'answered')
  assert.equal(delivered.length, 0)
})

test('get by another pane → 403; by the asking pane → the ask', async () => {
  const dir = await tmp()
  const a = new Asks({ dir, notify: async (d) => ({ id: 'n1', ...d }) })
  const created = await a.create(q(), author)
  await assert.rejects(a.get(created.id, 'w9:p9'), (e) => e.status === 403)
  assert.equal((await a.get(created.id, author.pane)).id, created.id)
})
