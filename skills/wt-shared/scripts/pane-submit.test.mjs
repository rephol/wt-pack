import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inputText, inputState, waitReady, confirmSubmitted } from './pane-submit.mjs'

const rule = '─'.repeat(40)
const box = (input) => `⏺ done\n\n${rule}\n❯ ${input}\n${rule}\n   ⎇ main\n  ⏵⏵ bypass permissions on`

test('inputText: the box content, the Try placeholder and an empty box', () => {
  assert.equal(inputText(box('/goal WP-1: do the task in /x.md')), '/goal WP-1: do the task in /x.md')
  assert.equal(inputText(box('Try "write a test for foo"')), '')
  assert.equal(inputText(box('')), '')
  assert.equal(inputText(`${rule}\n❯ first line\n  wrapped part\n${rule}\nfooter`), 'first line\n  wrapped part')
})
test('inputText: a ❯ outside the input box (a trust or picker menu) is never input, so Enter is not pressed on it', () => {
  assert.equal(inputText('Quick safety check\n\n ❯ No, exit\n   Yes, I trust this folder\n\n Enter to confirm'), '')
  assert.equal(inputText('❯ No, exit\n  Yes'), '')
})
test('waitReady: waits for registration and an idle, interactive session; times out', async () => {
  const seq = [null, { agent_status: 'working', interactive_ready: false }, { agent_status: 'idle', interactive_ready: true }]
  let n = 0
  assert.equal(await waitReady(async () => seq[Math.min(n++, 2)], { timeoutMs: 1000, intervalMs: 1 }), true)
  assert.equal(n, 3)
  assert.equal(await waitReady(async () => null, { timeoutMs: 20, intervalMs: 5 }), false)
})
test('confirmSubmitted: presses Enter again while the text is still in the box, bounded', async () => {
  let presses = 0, full = 2
  const read = async () => box(full > 0 ? 'task' : '')
  assert.equal(await confirmSubmitted(read, async () => { presses++; full-- }, { settleMs: 0 }), true)
  assert.equal(presses, 2)
  presses = 0
  assert.equal(await confirmSubmitted(async () => box('task'), async () => { presses++ }, { settleMs: 0, retries: 3 }), false)
  assert.equal(presses, 3)
})

// WP-267: real captures of a fresh claude session (throwaway agent in a temp repo), herdr pane read --source visible.
import { readFileSync } from 'node:fs'
const fx = (n) => readFileSync(new URL(`./fixtures/pane-submit-${n}.txt`, import.meta.url), 'utf8')
test('inputState: real captures — no box is null, an unrendered paste reads empty, the placeholder is the text', () => {
  assert.equal(inputState(fx('trust-menu')), null)
  assert.equal(inputState(fx('idle-fresh')), '')
  assert.equal(inputState(fx('pasted-not-rendered')), '')
  assert.equal(inputState(fx('pasted-placeholder')), '[Pasted text #1 +12 lines]')
  assert.equal(inputState(fx('submitted')), '')
})
test('confirmSubmitted: an empty box right after the paste (not rendered yet) is not a confirmation', async () => {
  // poll 0 sees the pre-render screen (empty, agent idle), poll 1 the placeholder (Enter again), poll 2 the submitted screen
  const screens = ['pasted-not-rendered', 'pasted-placeholder', 'submitted'].map(fx)
  const status = ['idle', 'idle', 'working']
  let n = 0, presses = 0
  assert.equal(await confirmSubmitted(async () => screens[Math.min(n, 2)], async () => { presses++ }, { settleMs: 0, status: async () => status[Math.min(n++, 2)] }), true)
  assert.equal(n, 3)
  assert.equal(presses, 1)
})
test('confirmSubmitted: a screen with no input box is never confirmed and never gets Enter', async () => {
  let presses = 0
  assert.equal(await confirmSubmitted(async () => fx('trust-menu'), async () => { presses++ }, { settleMs: 0, retries: 2, status: async () => 'blocked' }), false)
  assert.equal(presses, 0)
})
test('confirmSubmitted: a fresh idle box with nothing submitted stays unconfirmed', async () => {
  assert.equal(await confirmSubmitted(async () => fx('idle-fresh'), async () => {}, { settleMs: 0, retries: 2, status: async () => 'idle' }), false)
})
