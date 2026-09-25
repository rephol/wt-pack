import test from 'node:test'
import assert from 'node:assert/strict'
import { isUserSkip } from './pickerGuard.ts'

test('Esc only skips from a focused, idle card, never from a text field', () => {
  const ok = { key: 'Escape', cardHasFocus: true, inFlight: false, targetIsTextField: false }
  assert.equal(isUserSkip(ok), true)
  assert.equal(isUserSkip({ ...ok, inFlight: true }), false)
  assert.equal(isUserSkip({ ...ok, cardHasFocus: false }), false)
  assert.equal(isUserSkip({ ...ok, targetIsTextField: true }), false)
  assert.equal(isUserSkip({ ...ok, key: 'Enter' }), false)
})
