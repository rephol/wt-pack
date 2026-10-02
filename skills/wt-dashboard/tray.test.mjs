// Run: node --test tray.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { traySame, sendTrayIfChanged, trayOf } from './server.mjs'

test('traySame: identical tray states match regardless of object identity; any change does not', () => {
  const a = { needs: [{ key: 'w1', name: 'Worker', question: 'ok?' }], working: [{ key: 'w2', name: 'Other' }] }
  const b = { needs: [{ key: 'w1', name: 'Worker', question: 'ok?' }], working: [{ key: 'w2', name: 'Other' }] }
  assert.equal(traySame(a, b), true)
  assert.equal(traySame(a, null), false)
  assert.equal(traySame(a, { ...a, needs: [] }), false) // count change (WP-146 belt-and-braces: title must still update)
  assert.equal(traySame(a, { ...a, working: [] }), false)
})

test('sendTrayIfChanged: two unchanged ticks broadcast once; a real change broadcasts again', () => {
  const a = { needs: [{ key: 'w1', name: 'Worker', question: 'ok?' }], working: [] }
  assert.equal(sendTrayIfChanged(a), true) // first send (or a change from whatever an earlier test left behind)
  assert.equal(sendTrayIfChanged({ ...a }), false) // same content, new object: tick() calls this every 4s
  assert.equal(sendTrayIfChanged({ ...a }), false)
  assert.equal(sendTrayIfChanged({ ...a, needs: [] }), true) // needs count changed: must broadcast
  assert.equal(sendTrayIfChanged({ ...a, needs: [] }), false) // settled at the new state
})

test('trayOf: needs and working carry the agent project so the app can open that project window (WP-166)', () => {
  const agents = new Map([
    ['w1', { key: 'w1', name: 'Worker', project: 'wt-pack', state: 'needs_you' }],
    ['w2', { key: 'w2', name: 'Other', project: 'umkmall', state: 'working' }],
  ])
  const items = [
    { title: 'Worker asks you', body: 'ok?', target: { agent: 'w1' } },
    { title: 'Room mention', body: '', target: { room: 'wt-pack' } },
  ]
  const t = trayOf(items, agents)
  assert.equal(t.needs[0].project, 'wt-pack')
  assert.equal(t.needs[1].key, 'room:wt-pack')
  assert.equal(t.needs[1].project, undefined) // rooms have no agent project: the app falls back to main
  assert.deepEqual(t.working, [{ key: 'w2', name: 'Other', project: 'umkmall' }])
  assert.deepEqual(trayOf(items, null).working, []) // before the first poll
})
