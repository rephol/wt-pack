import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EMPTY, openChat, minimise, close, unread, load, save, dockKind, type DockState } from './dock.ts'

const open4 = () => ['local/w1:pa', 'local/w1:pb', 'room:c', 'local/w1:pd'].reduce((s, k, i) => openChat(s, k, i + 1), EMPTY)
const wins = (s: DockState) => s.items.filter((i) => !i.min).map((i) => i.key)

test('a 4th open collapses the oldest window', () => {
  const s = open4()
  assert.deepEqual(wins(s), ['local/w1:pb', 'room:c', 'local/w1:pd'])
  assert.equal(s.items.find((i) => i.key === 'local/w1:pa')?.min, true)
})

test('re-opening a tab raises it (and the now-oldest window becomes a tab)', () => {
  const s = openChat(open4(), 'local/w1:pa', 10)
  assert.deepEqual(wins(s).sort(), ['local/w1:pa', 'local/w1:pd', 'room:c'])
  assert.equal(s.items.length, 4)
})

test('close removes the item and its seen entry; terminals are not docked', () => {
  const s = close(open4(), 'room:c')
  assert.equal(s.items.some((i) => i.key === 'room:c'), false)
  assert.equal('room:c' in s.seen, false)
  assert.equal(openChat(EMPTY, 'term:w1:p2', 1), EMPTY)
  assert.equal(dockKind('room:x'), 'room')
})

test('unread: room lastAt after seen, room needs-you, agent needs-you; open windows never', () => {
  let s = openChat(openChat(EMPTY, 'room:c', 1000), 'local/w1:pa', 1000)
  const roster = (lastAt: string, needs: unknown[], asks: boolean) => ({
    rooms: [{ slug: 'c', lastAt, needsYou: needs }], agents: [{ key: 'local/w1:pa', asks, status: 'idle', statusSince: 0, lastActivity: 500 }],
  })
  assert.deepEqual(unread(s, roster(new Date(5000).toISOString(), [], true)), {}) // both are windows
  s = minimise(minimise(s, 'room:c', 2000), 'local/w1:pa', 2000)
  assert.deepEqual(unread(s, roster(new Date(1500).toISOString(), [], false)), {})
  assert.deepEqual(unread(s, roster(new Date(5000).toISOString(), [], false)), { 'room:c': 'dot' })
  assert.deepEqual(unread(s, roster(new Date(0).toISOString(), [{}], true)), { 'room:c': '!', 'local/w1:pa': '!' })
})

test('load tolerates garbage and a throwing localStorage', () => {
  const g = globalThis as unknown as { localStorage?: unknown }
  const store = new Map<string, string>()
  g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v) } }
  store.set('chat-dock', '{not json')
  assert.deepEqual(load(), EMPTY)
  store.set('chat-dock', JSON.stringify({ items: [{ key: 'room:x', kind: 'agent', openedAt: 1 }, null, { key: 'room:y', kind: 'room', openedAt: 2 }], seen: { 'room:y': 'x' } }))
  assert.deepEqual(load(), { items: [{ key: 'room:y', kind: 'room', min: false, openedAt: 2 }], seen: {} })
  save(open4())
  assert.equal(load().items.length, 4)
  g.localStorage = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') } }
  assert.deepEqual(load(), EMPTY)
  save(open4()) // no throw
  delete g.localStorage
})
