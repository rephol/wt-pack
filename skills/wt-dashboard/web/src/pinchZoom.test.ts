import test from 'node:test'
import assert from 'node:assert/strict'
import { zoomAt, MAX } from './pinchZoom.ts'

test('zoomAt keeps the point under the pointer fixed', () => {
  const z = zoomAt({ s: 1, x: 0, y: 0 }, 2, 100, -50)
  assert.deepEqual(z, { s: 2, x: -100, y: 50 })
  // image point under (100,-50) before: (100-0)/1 = 100; after: (100-(-100))/2 = 100
  assert.equal((100 - z.x) / z.s, 100)
})

test('zoomAt clamps to 1x..5x, and 1x recentres', () => {
  assert.deepEqual(zoomAt({ s: 2, x: 40, y: 10 }, 0.1, 0, 0), { s: 1, x: 0, y: 0 })
  assert.equal(zoomAt({ s: 4, x: 0, y: 0 }, 10, 0, 0).s, MAX)
})
