import test from 'node:test'
import assert from 'node:assert/strict'
import { WINDOW_HOURS, toBody } from './keepwarmData.ts'

test('the window choices are exactly 1..12 whole hours', () => {
  assert.deepEqual(WINDOW_HOURS, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
})
test('toBody turns the draft strings into numbers and keeps a bad field visibly bad (NaN) for the server to refuse', () => {
  const d = { enabled: true, roles: ['planner'], minContext: '50000', intervalMin: '50', windowH: '3', dailyCap: '15' }
  assert.deepEqual(toBody(d), { enabled: true, roles: ['planner'], minContext: 50000, intervalMin: 50, windowH: 3, dailyCap: 15 })
  assert.ok(Number.isNaN(toBody({ ...d, windowH: '' }).windowH) || toBody({ ...d, windowH: '' }).windowH === 0)
  assert.ok(Number.isNaN(toBody({ ...d, dailyCap: 'abc' }).dailyCap))
})
