import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inputText, waitReady, confirmSubmitted } from './pane-submit.mjs'

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
