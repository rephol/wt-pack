import test from 'node:test'
import assert from 'node:assert/strict'
import { roomRows } from './roomRows.ts'

const msg = (id: string, extra = {}) => ({ id, mentions: [] as string[], deliveredTo: [] as string[], author: { kind: 'user' as const }, ...extra })

test('delivery state becomes one status row per agent after its message, consecutive duplicates collapsed', () => {
  const rows = roomRows([
    msg('a', { mentions: ['p-06', 'w-01', 'me'], deliveredTo: ['p-06'] }),
    msg('b', { author: { kind: 'agent' }, mentions: ['me'], notified: true }),
    msg('c', { author: { kind: 'system' }, mentions: ['x'] }),
  ], 'Me', new Map([['a', ['p-06']]]))
  assert.deepEqual(rows.map((r) => r.kind === 'msg' ? r.id : r.text), [
    'a', 'p-06 is replying…', 'w-01 will be notified when idle', 'b', 'you were notified', 'c'])
  const dup = roomRows([msg('a', { deliveredTo: ['x', 'y'] }), msg('b', { deliveredTo: ['x', 'y'] })], 'me', new Map())
  assert.deepEqual(dup.map((r) => r.kind === 'msg' ? r.id : r.text), ['a', 'b', 'x was notified', 'y was notified'])
  const other = roomRows([msg('a', { deliveredTo: ['x'] }), msg('b', { author: { kind: 'agent', name: 'z' }, deliveredTo: ['x'] })], 'me', new Map())
  assert.equal(other.length, 4) // a different author breaks the run
})
test('an agent keeps one row per mention round that updates in place: queued → notified → replying… → replied', () => {
  const ask = (extra = {}) => msg('a', { mentions: ['w', 'p'], ...extra })
  const ids = (rows: ReturnType<typeof roomRows>) => rows.filter((r) => r.kind === 'status').map((r) => `${r.id} ${r.kind === 'status' ? r.text : ''}`)
  assert.deepEqual(ids(roomRows([ask()], 'me', new Map())), ['a~w w will be notified when idle', 'a~p p will be notified when idle'])
  assert.deepEqual(ids(roomRows([ask({ deliveredTo: ['w'], blocked: [{ name: 'p', reason: 'not a member' }] })], 'me', new Map())),
    ['a~w w was notified', 'a~p p: not a member'])
  assert.deepEqual(ids(roomRows([ask({ deliveredTo: ['w', 'p'] })], 'me', new Map([['a', ['w']]]))), ['a~w w is replying…', 'a~p p was notified'])
  const done = roomRows([ask({ deliveredTo: ['w', 'p'] }), msg('r', { author: { kind: 'agent', name: 'w' } })], 'me', new Map())
  assert.deepEqual(ids(done), ['a~w w replied', 'a~p p was notified'])
})

import { membersFirst } from './roomRows.ts'
test('membersFirst: room members lead the @ menu, the rest keep their order', () => {
  const A = ['umkmall-worker-01', 'umkmall-worker-02', 'wt-pack-worker-01', 'x'].map((name) => ({ name }))
  assert.deepEqual(membersFirst(A, ['wt-pack-worker-01', 'x']).map((a) => a.name), ['wt-pack-worker-01', 'x', 'umkmall-worker-01', 'umkmall-worker-02'])
  assert.deepEqual(membersFirst(A, []).map((a) => a.name), A.map((a) => a.name))
})

import { attMarker, orphanedAtts, numberMarkers } from './roomRows.ts'
test('attachment markers: a deleted marker orphans its image; send numbers markers by sent order', () => {
  const a = 'aaaaaaaa-1', b = 'bbbbbbbb-2', c = 'cccccccc-3'
  const text = `see ${attMarker(b)} then ${attMarker(a)}`
  assert.deepEqual(orphanedAtts(text, [a, b, c]), [c])
  assert.equal(numberMarkers(text, [a, b]), 'see [image 2] then [image 1]')
  // a marker whose image failed to upload (not sent) is dropped from the text
  assert.equal(numberMarkers(`x ${attMarker(c)} ${attMarker(a)}`, [a]), 'x  [image 1]')
})
