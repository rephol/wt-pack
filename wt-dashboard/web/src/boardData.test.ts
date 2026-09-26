import test from 'node:test'
import assert from 'node:assert/strict'
import { COLUMNS, group, moveTicket, type Ticket } from './boardData.ts'

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
