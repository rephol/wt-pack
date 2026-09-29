import test from 'node:test'
import assert from 'node:assert/strict'
import { planVariant } from './planUsage.ts'

test('planVariant: >95 danger, >80 warn, otherwise accent', () => {
  assert.equal(planVariant(0), 'accent')
  assert.equal(planVariant(80), 'accent') // boundary: not yet warn
  assert.equal(planVariant(81), 'warning')
  assert.equal(planVariant(95), 'warning') // boundary: not yet danger
  assert.equal(planVariant(96), 'error')
  assert.equal(planVariant(100), 'error')
})
