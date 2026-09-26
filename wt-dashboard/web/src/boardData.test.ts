import test from 'node:test'
import assert from 'node:assert/strict'
import { COLUMNS, dispatchBadge, dispatchLine, group, jevChip, moveTicket, type Ticket } from './boardData.ts'

const t = (id: string, column: Ticket['column'], priority?: number): Ticket => ({ id, title: id, column, priority })

test('group: every column in board order, priority then id', () => {
  const g = group([t('WP-3', 'ready', 3), t('WP-10', 'ready', 1), t('WP-2', 'ready', 0), t('WP-1', 'ready', 3), t('WP-4', 'done')])
  assert.deepEqual(Object.keys(g), [...COLUMNS])
  assert.deepEqual(g.ready.map((x) => x.id), ['WP-10', 'WP-1', 'WP-3', 'WP-2'])
  assert.deepEqual(g.done.map((x) => x.id), ['WP-4'])
  assert.deepEqual(g.backlog, [])
})

test('group: an unknown column falls into backlog', () => {
  assert.deepEqual(group([t('WP-1', 'weird' as Ticket['column'])]).backlog.map((x) => x.id), ['WP-1'])
})

test('moveTicket: moves one card, leaves the input untouched; no-op for same column or unknown id', () => {
  const b = { key: 'WP', tickets: [t('WP-1', 'backlog'), t('WP-2', 'backlog')] }
  const m = moveTicket(b, 'WP-1', 'ready')
  assert.deepEqual(m.tickets.map((x) => x.column), ['ready', 'backlog'])
  assert.equal(b.tickets[0].column, 'backlog')
  assert.equal(moveTicket(b, 'WP-1', 'backlog'), b)
  assert.equal(moveTicket(b, 'WP-9', 'ready'), b)
})

test('jevChip: shown for applied fields or duplicates, not for an owner hint alone', () => {
  const t = { id: 'WP-1', title: 'x', column: 'backlog' as const }
  const jev = { at: '', applied: {}, owner: 'worker' as const, dupes: [] as string[] }
  assert.equal(jevChip(t), false)
  assert.equal(jevChip({ ...t, jev }), false)
  assert.equal(jevChip({ ...t, jev: { ...jev, dupes: ['WP-2'] } }), true)
  assert.equal(jevChip({ ...t, jev: { ...jev, applied: { type: { from: 'feature', to: 'bug' } } } }), true)
})

test('dispatch badge and status line (WP-52)', () => {
  assert.equal(dispatchBadge(null), null)
  assert.equal(dispatchBadge({ state: 'sent', agent: 'w' }), null)
  assert.equal(dispatchBadge({ state: 'dispatching' })?.[0], 'Dispatching…')
  assert.equal(dispatchBadge({ state: 'held', fails: 3 })?.[1], 'error')
  assert.equal(dispatchBadge({ state: 'sent', stalled: 'w idle 50m' })?.[0], 'Stalled')
  assert.equal(dispatchLine({ last: null, waiting: 'cap: 4 working ≥ 4', inflight: 0 }), 'waiting: cap: 4 working ≥ 4')
  assert.equal(dispatchLine({ last: { at: 0, text: 'WP-9 → w2' }, waiting: null, inflight: 0 }, 180_000), 'last: WP-9 → w2 3m ago')
  assert.equal(dispatchLine({ last: null, waiting: null, inflight: 1 }), 'Dispatching 1…')
})
