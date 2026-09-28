// Run: node --test tray.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { traySame } from './server.mjs'

test('traySame: identical tray states match regardless of object identity; any change does not', () => {
  const a = { needs: [{ key: 'w1', name: 'Worker', question: 'ok?' }], working: [{ key: 'w2', name: 'Other' }] }
  const b = { needs: [{ key: 'w1', name: 'Worker', question: 'ok?' }], working: [{ key: 'w2', name: 'Other' }] }
  assert.equal(traySame(a, b), true)
  assert.equal(traySame(a, null), false)
  assert.equal(traySame(a, { ...a, needs: [] }), false) // count change (WP-146 belt-and-braces: title must still update)
  assert.equal(traySame(a, { ...a, working: [] }), false)
})
