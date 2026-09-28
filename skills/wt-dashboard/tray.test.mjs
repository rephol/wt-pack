// Run: node --test tray.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { traySame, sendTrayIfChanged } from './server.mjs'

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
