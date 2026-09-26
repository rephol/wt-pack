// Run: node --test ticketJev.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Tickets } from './tickets.mjs'
import { candidates, readyBatcher, readyToNotify, shouldPromote, ticketTriage, ticketType, triageTicket } from './ticketJev.mjs'

const user = { name: 'Rep' }
const answers = {
  type: { choice: 'bug', confidence: 0.9 }, size: { choice: 'S', confidence: 0.4 },
  priority: { score: 1.2, confidence: 0.7 }, plan: { noul: 0.9 }, dup_WP1: { noul: 0.85 }, dup_WP2: { noul: 0.3 },
}

test('decide maps answers, thresholds per field', () => {
  assert.deepEqual(ticketTriage.decide(answers), { type: 'bug', size: null, priority: 2, owner: 'planner', ready: null, dupes: ['WP1'] })
  assert.equal(ticketTriage.decide(answers, 0.6, 0.95).owner, 'worker')
  assert.deepEqual(ticketTriage.decide(null), { type: null, size: null, priority: null, owner: null, ready: null, dupes: [] })
  assert.equal(ticketType.decide(answers), 'bug')
  const q = ticketTriage.questions({ title: 't', body: '', candidates: [{ id: 'WP-3', title: 'x' }] })
  assert.deepEqual(Object.keys(q), ['type', 'size', 'priority', 'plan', 'ready', 'dup_WP-3'])
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
  assert.deepEqual(Object.keys(out.jev.applied), ['type', 'priority', 'labels']) // Jev said planner → needs-plan
  assert.equal(await triageTicket('wt-pack', t, [], { ask: async () => { throw new Error('boom') }, tickets, log: () => {} }), null)
})

test('shouldPromote: Backlog, priority ≥ High, S/M at p ≥ 0.6; L or planner-hinted only at p ≥ 0.8', () => {
  const t = { column: 'backlog', priority: 2, size: 'S' }
  const d = { ready: 0.7, owner: 'worker' }
  assert.equal(shouldPromote(t, d), 0.7)
  assert.equal(shouldPromote(t, { ...d, ready: 0.5 }), null)
  assert.equal(shouldPromote({ ...t, priority: 3 }, d), null) // medium
  assert.equal(shouldPromote({ ...t, priority: 0 }, d), null) // unset
  assert.equal(shouldPromote({ ...t, column: 'ready' }, d), null)
  assert.equal(shouldPromote({ ...t, size: 'L' }, d), null)
  assert.equal(shouldPromote({ ...t, size: 'L' }, { ...d, ready: 0.85 }), 0.85)
  assert.equal(shouldPromote({ ...t, size: null }, d), null) // unsized counts as not small
  assert.equal(shouldPromote(t, { ...d, owner: 'planner' }), null)
  assert.equal(shouldPromote(t, { ...d, owner: 'planner', ready: 0.9 }), 0.9)
  assert.equal(shouldPromote(t, { ...d, ready: null }), null) // fail-open: no move
})

test('readyBatcher: one send per project per flush, deduped by id; a failing send is dropped', async () => {
  const sent = []
  const b = readyBatcher(async (p, ts) => { if (p === 'bad') throw new Error('x'); sent.push([p, ts.map((t) => t.id)]) }, () => {})
  b.add('wt-pack', { id: 'WP-1' }); b.add('wt-pack', { id: 'WP-2' }); b.add('wt-pack', { id: 'WP-1' }); b.add('bad', { id: 'B-1' }); b.add(null, { id: 'X-1' })
  await b.flush()
  assert.deepEqual(sent, [['wt-pack', ['WP-1', 'WP-2']]])
  await b.flush()
  assert.equal(sent.length, 1)
})

test('triageTicket with Auto: promotes, notifies onReady once, undo moves back', async () => {
  const ready = []
  const tickets = new Tickets({ dir: await mkdtemp(join(tmpdir(), 'tj-')), onReady: (p, t) => ready.push([p, t.id]) })
  const t = await tickets.create('wt-pack', { title: 'Fix it', size: 'S', priority: 2 }, user)
  await tickets.setAuto('wt-pack', true)
  assert.equal((await tickets.list('wt-pack')).auto, true)
  const a = { ...answers, ready: { noul: 0.9 }, plan: { noul: 0.1 } }
  const off = await triageTicket('wt-pack', t, [], { ask: async () => a, tickets, auto: false })
  assert.equal(off.column, 'backlog')
  const on = await triageTicket('wt-pack', t, [], { ask: async () => a, tickets, auto: true })
  assert.deepEqual([on.column, on.history.at(-1).text, ready], ['ready', 'Jev auto-promoted (p=0.90)', [['wt-pack', t.id]]])
  const u = await tickets.jevUndo(t.id, 'column', user)
  assert.equal(u.column, 'backlog')
  await tickets.patch(t.id, { column: 'ready' }, user) // by hand: notifies again
  assert.equal(ready.length, 2)
})

test('shouldPromote honours the board minimum priority (WP-46)', () => {
  const d = { ready: 0.7, owner: 'worker' }
  const t = (priority) => ({ column: 'backlog', size: 'S', priority })
  assert.equal(shouldPromote(t(3), d), null) // default High
  assert.equal(shouldPromote(t(3), d, { minPriority: 3 }), 0.7) // Medium
  assert.equal(shouldPromote(t(4), d, { minPriority: 3 }), null)
  assert.equal(shouldPromote(t(0), d, { minPriority: 4 }), null) // unprioritised stays unless 'any'
  assert.equal(shouldPromote(t(0), d, { minPriority: 0 }), 0.7)
  assert.equal(shouldPromote(t(1), d, { minPriority: 1 }), 0.7)
})

test('readyToNotify: skips tickets the prompted agent moved, assigned ones, and ones gone from Ready (WP-43)', () => {
  const t = (id, author, extra = {}) => ({ id, column: 'ready', history: [{ kind: 'create', author: 'u', to: 'backlog' }, { kind: 'move', author, to: 'ready' }], ...extra })
  const ts = [t('A', 'orch'), t('B', 'jev'), t('C', 'jev', { assignee: { name: 'w' } }), t('D', 'jev', { column: 'building' }), null,
    { id: 'E', column: 'ready', history: [{ kind: 'create', author: 'orch', to: 'ready' }] }]
  assert.deepEqual(readyToNotify(ts, 'orch').map((x) => x.id), ['B'])
  // WP-49: only a live assignee working this ticket holds it back
  assert.deepEqual(readyToNotify(ts, 'orch', () => false).map((x) => x.id), ['B', 'C'])
})
