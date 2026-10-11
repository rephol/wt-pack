// Run: node --test gate.test.mjs — WP-332 grants: one-shot, per (pane, hash), 10 minutes.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Gate, GRANT_MS } from './gate.mjs'

test('a grant is consumed once, only for its own pane and command, and expires', () => {
  let t = 1_000_000
  const g = new Gate({ dir: mkdtempSync(join(tmpdir(), 'wt-gate-')), now: () => t })
  g.grant('w1:p1', 'aaaaaaaaaaaaaaaa')
  assert.equal(g.consume('w1:p2', 'aaaaaaaaaaaaaaaa'), false) // another pane
  assert.equal(g.consume('w1:p1', 'bbbbbbbbbbbbbbbb'), false) // another command
  assert.equal(g.consume('w1:p1', 'aaaaaaaaaaaaaaaa'), true)
  assert.equal(g.consume('w1:p1', 'aaaaaaaaaaaaaaaa'), false) // used up
  g.grant('w1:p1', 'cccccccccccccccc'); t += GRANT_MS + 1
  assert.equal(g.consume('w1:p1', 'cccccccccccccccc'), false) // expired
})
