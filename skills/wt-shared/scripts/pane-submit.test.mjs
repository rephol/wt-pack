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

// WP-378: hc reports `status` (idle|working|done|blocked); a finished turn RESTS at `done`.
test('waitReady: the hc status shape (status, not agent_status); a terminal that reports none yet is waited on', async () => {
  const seq = [{ status: null }, { status: 'working' }, { status: 'done' }]
  let n = 0
  assert.equal(await waitReady(async () => seq[Math.min(n++, 2)], { timeoutMs: 1000, intervalMs: 1 }), true)
  assert.equal(n, 3)
  assert.equal(await waitReady(async () => ({ status: 'blocked' }), { timeoutMs: 20, intervalMs: 5 }), false)
})
test('confirmSubmitted: an agent resting at `done` is not evidence the prompt went in; only working/blocked (or an echoed prompt) is', async () => {
  // empty box + status done and no echo: not confirmed (the old code treated any non-idle status as busy, so `done` confirmed it)
  assert.equal(await confirmSubmitted(async () => fx('idle-fresh'), async () => {}, { settleMs: 0, retries: 2, status: async () => 'done' }), false)
  assert.equal(await confirmSubmitted(async () => fx('pasted-not-rendered'), async () => {}, { settleMs: 0, retries: 2, status: async () => 'working' }), true)
})

// The CLI on the fake hc (get for the status, read for the screen, keys for Enter).
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { installFakeHc } from './fake-hc.mjs'
const sh = promisify(execFile)
const cli = async (fake, args) => { try { await sh('node', [new URL('./pane-submit.mjs', import.meta.url).pathname, ...args], { env: fake.env }); return 0 } catch (e) { return e.code } }
const getRow = (state) => ({ stdout: JSON.stringify({ address: 't3', state: 'live', status: state ? { app: 'claude-code', state } : null, labels: {}, argv: ['claude'] }) })
test('CLI ready: exit 0 once hc get reports idle or done, 1 on timeout; confirm reads with hc read and presses Enter with hc keys', async () => {
  let fake = installFakeHc({ cases: { get: getRow('done') } })
  assert.equal(await cli(fake, ['ready', 't3', '--timeout', '1']), 0)
  assert.deepEqual(fake.calls().map((c) => c.args), [['get', '--json', 't3']])
  fake.cleanup()
  fake = installFakeHc({ cases: { get: getRow(null) } })
  assert.equal(await cli(fake, ['ready', 't3', '--timeout', '0']), 1)
  fake.cleanup()
  // confirm: the box still holds the text on poll 0 → Enter via `hc keys`, then the submitted screen
  fake = installFakeHc({ cases: { get: getRow('working'), read: [{ stdout: fx('pasted-placeholder') }, { stdout: fx('submitted') }] } })
  assert.equal(await cli(fake, ['confirm', 't3', '--settle', '0']), 0)
  const verbs = fake.calls().map((c) => c.args.join(' '))
  assert.ok(verbs.includes('keys --json t3 enter'), verbs.join('\n'))
  assert.ok(verbs.includes('read t3 --lines 0'), verbs.join('\n'))
  assert.ok(!verbs.some((v) => /herdr/.test(v)))
  fake.cleanup()
})
