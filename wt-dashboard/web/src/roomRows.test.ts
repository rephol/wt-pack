import test from 'node:test'
import assert from 'node:assert/strict'
import { roomRows } from './roomRows.ts'

const msg = (id: string, extra = {}) => ({ id, mentions: [] as string[], deliveredTo: [] as string[], author: { kind: 'user' as const }, ...extra })

test('delivery state becomes status rows after its message, consecutive duplicates collapsed', () => {
  const rows = roomRows([
    msg('a', { mentions: ['p-06', 'w-01', 'me'], deliveredTo: ['p-06'] }),
    msg('b', { author: { kind: 'agent' }, mentions: ['me'], notified: true }),
    msg('c', { author: { kind: 'system' }, mentions: ['x'] }),
  ], 'Me', new Map([['a', ['p-06']]]))
  assert.deepEqual(rows.map((r) => r.kind === 'msg' ? r.id : r.text), [
    'a', 'p-06 was notified', 'w-01 will be notified when idle', 'p-06 is replying…', 'b', 'you were notified', 'c'])
  const dup = roomRows([msg('a', { deliveredTo: ['x', 'y'] }), msg('b', { deliveredTo: ['x', 'y'] })], 'me', new Map())
  assert.deepEqual(dup.map((r) => r.kind === 'msg' ? r.id : r.text), ['a', 'b', 'x and y were notified'])
  const other = roomRows([msg('a', { deliveredTo: ['x'] }), msg('b', { author: { kind: 'agent', name: 'z' }, deliveredTo: ['x'] })], 'me', new Map())
  assert.equal(other.length, 4) // a different author breaks the run
})

import { membersFirst } from './roomRows.ts'
test('membersFirst: room members lead the @ menu, the rest keep their order', () => {
  const A = ['umkmall-worker-01', 'umkmall-worker-02', 'wt-pack-worker-01', 'x'].map((name) => ({ name }))
  assert.deepEqual(membersFirst(A, ['wt-pack-worker-01', 'x']).map((a) => a.name), ['wt-pack-worker-01', 'x', 'umkmall-worker-01', 'umkmall-worker-02'])
  assert.deepEqual(membersFirst(A, []).map((a) => a.name), A.map((a) => a.name))
})
