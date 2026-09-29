import test from 'node:test'
import assert from 'node:assert/strict'
import { menuWidth, fitMenu } from './triggerMenuFix.ts'

test('menuWidth: caps at 320px, shrinks on a narrow viewport, never below 120px', () => {
  assert.equal(menuWidth({ width: 1280, height: 800 }), 320)
  assert.equal(menuWidth({ width: 300, height: 800 }), 284) // 300 - 8*2
  assert.equal(menuWidth({ width: 50, height: 800 }), 120) // floor
})

test('fitMenu: opens above the anchor when there is room, right at the anchor\'s left edge', () => {
  // WP-181 repro: composer near the bottom-right of a 1280x800 viewport (matches the real dock capture).
  const anchor = { left: 908, top: 453, bottom: 470 }
  const box = fitMenu(anchor, 240, { width: 1280, height: 800 }, 320)
  assert.deepEqual(box, { left: 908, top: 209, width: 320, maxHeight: 441 })
})

test('fitMenu: clamps left so a right-edge anchor never pushes the menu off-screen', () => {
  const anchor = { left: 1200, top: 300, bottom: 320 }
  const box = fitMenu(anchor, 100, { width: 1280, height: 800 }, 320)
  assert.equal(box.left, 1280 - 320 - 8) // 952, not 1200
})

test('fitMenu: falls back below the anchor when there is no room above', () => {
  const anchor = { left: 20, top: 20, bottom: 40 }
  const box = fitMenu(anchor, 240, { width: 1280, height: 800 }, 320)
  assert.equal(box.top, 44) // anchor.bottom + gap(4)
  assert.equal(box.maxHeight, 800 - 44 - 8)
})

test('fitMenu: a left-edge anchor never pushes the menu off-screen to the left', () => {
  const anchor = { left: 2, top: 300, bottom: 320 }
  const box = fitMenu(anchor, 100, { width: 1280, height: 800 }, 320)
  assert.equal(box.left, 8) // margin, not 2
})
