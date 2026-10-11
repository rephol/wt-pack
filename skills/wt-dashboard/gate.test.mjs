// Run: node --test gate.test.mjs — WP-332 grants: one-shot, per (pane, hash), 10 minutes.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Gate, GRANT_MS, replyMayAct } from './gate.mjs'

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

test('replyMayAct: orchestrator receiver + it handed the ticket off + sender is the current assignee, all three', () => {
  const ok = { receiverRole: 'orchestrator', handedByReceiver: true, assigneePane: 'w1:p1', senderPane: 'w1:p1' }
  assert.equal(replyMayAct(ok), true)
  assert.equal(replyMayAct({ ...ok, receiverRole: 'worker' }), false) // a reply to a non-orchestrator
  assert.equal(replyMayAct({ ...ok, handedByReceiver: false }), false) // this orchestrator did not hand it off
  assert.equal(replyMayAct({ ...ok, senderPane: 'w1:p9' }), false) // not (or no longer) the assignee
  assert.equal(replyMayAct({ ...ok, assigneePane: null }), false) // unassigned card
})
