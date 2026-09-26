// Run: node --test ticketJev.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Tickets } from './tickets.mjs'
import { candidates, ticketTriage, ticketType, triageTicket } from './ticketJev.mjs'

const user = { name: 'Rep' }
const answers = {
  type: { choice: 'bug', confidence: 0.9 }, size: { choice: 'S', confidence: 0.4 },
  priority: { score: 1.2, confidence: 0.7 }, plan: { noul: 0.9 }, dup_WP1: { noul: 0.85 }, dup_WP2: { noul: 0.3 },
}

test('decide maps answers, thresholds per field', () => {
  assert.deepEqual(ticketTriage.decide(answers), { type: 'bug', size: null, priority: 2, owner: 'planner', dupes: ['WP1'] })
  assert.equal(ticketTriage.decide(answers, 0.6, 0.95).owner, 'worker')
  assert.deepEqual(ticketTriage.decide(null), { type: null, size: null, priority: null, owner: null, dupes: [] })
  assert.equal(ticketType.decide(answers), 'bug')
  const q = ticketTriage.questions({ title: 't', body: '', candidates: [{ id: 'WP-3', title: 'x' }] })
  assert.deepEqual(Object.keys(q), ['type', 'size', 'priority', 'plan', 'dup_WP-3'])
})

test('candidates: overlap order, skips done and self', () => {
  const t = { id: 'WP-9', title: 'Inbox badge count wrong', body: '' }
  const open = [
    { id: 'WP-1', title: 'Inbox badge count', body: '', column: 'ready' },
    { id: 'WP-2', title: 'Inbox badge count wrong', body: '', column: 'done' },
    { id: 'WP-3', title: 'Unrelated thing', body: '', column: 'backlog' },
    { id: 'WP-4', title: 'badge', body: '', column: 'backlog' }, t,
  ]
  assert.deepEqual(candidates(t, open).map((c) => c.id), ['WP-1', 'WP-4'])
})

test('triageTicket: fail-open leaves the ticket as created; answers fill only empty fields', async () => {
  const tickets = new Tickets({ dir: await mkdtemp(join(tmpdir(), 'tj-')) })
  const t = await tickets.create('wt-pack', { title: 'Badge wrong', size: 'M' }, user)
  assert.equal(await triageTicket('wt-pack', t, ['type', 'priority'], { ask: async () => null, tickets }), null)
  assert.deepEqual(await tickets.get(t.id), t)
  const out = await triageTicket('wt-pack', t, ['type', 'priority'], { ask: async () => ({ ...answers, size: { choice: 'L', confidence: 1 } }), tickets, log: () => {} })
  assert.deepEqual([out.type, out.size, out.priority], ['bug', 'M', 2])
  assert.deepEqual(Object.keys(out.jev.applied), ['type', 'priority'])
  assert.equal(await triageTicket('wt-pack', t, [], { ask: async () => { throw new Error('boom') }, tickets, log: () => {} }), null)
})
