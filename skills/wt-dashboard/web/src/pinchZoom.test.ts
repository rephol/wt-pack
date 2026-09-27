import test from 'node:test'
import assert from 'node:assert/strict'
import { zoomAt, clampPan, MAX } from './pinchZoom.ts'

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

test('clampPan: a zoomed image may fill the viewport but never leave it (WP-95)', () => {
  // 400x300 picture centred in a 1000x800 viewport, zoomed 2x → 800x600: fits, so it stays fully on screen.
  const fit = { w: 400, h: 300, vw: 1000, vh: 800, ox: 0, oy: 0 }
  assert.deepEqual(clampPan({ s: 2, x: 500, y: -500 }, fit), { s: 2, x: 100, y: -100 })
  // 4x → 1600x1200: larger than the viewport, so its edges can't come inside the screen.
  assert.deepEqual(clampPan({ s: 4, x: 900, y: 50 }, fit), { s: 4, x: 300, y: 50 })
  assert.deepEqual(clampPan({ s: 4, x: -301, y: -201 }, fit), { s: 4, x: -300, y: -200 })
  // A picture whose box sits 100px right of the viewport centre is clamped around the viewport, not its box.
  assert.deepEqual(clampPan({ s: 2, x: 500, y: 0 }, { ...fit, ox: 100 }), { s: 2, x: 0, y: 0 })
  assert.deepEqual(clampPan({ s: 1, x: 0, y: 0 }, fit), { s: 1, x: 0, y: 0 })
})
