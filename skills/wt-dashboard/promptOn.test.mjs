import test from 'node:test'
import assert from 'node:assert/strict'
import { promptOn } from './promptOn.mjs'

// WP-378: the io is hc: send(pane, text) pastes and presses Enter, keys(pane, ...k), read(pane) the plain screen.
const rec = (screen = async () => '') => { const c = []; return [c, { send: async (p, t) => { c.push(`send ${p} ${t}`) }, keys: async (p, ...k) => { c.push(`keys ${p} ${k.join(' ')}`) }, read: screen }] }

test('WP-378: every prompt, slash command or not, is ONE send (hc send pastes and presses Enter; a pasted slash command still runs)', async () => {
  const [c, io] = rec()
  await promptOn(io, 't1', 'hello'); await promptOn(io, 't1', '/wt-audit'); await promptOn(io, 't1', '/goal a\nb')
  assert.deepEqual(c, ['send t1 hello', 'send t1 /wt-audit', 'send t1 /goal a\nb'])
})
test('WP-378: a refusal from hc (blocked, not idle) reaches the caller untouched; nothing else is pressed', async () => {
  const c = [], io = { send: async () => { throw Object.assign(new Error('t1 is blocked'), { kind: 'blocked' }) }, keys: async (...a) => c.push(a), read: async () => '' }
  await assert.rejects(promptOn(io, 't1', '/wt-audit', { confirm: true, settleMs: 0 }), (e) => e.kind === 'blocked')
  assert.deepEqual(c, [])
})
test('WP-352: a long /goal envelope is sent as its short pointer, never "do the task in <file>"', async () => {
  const msg = '<wt-message id=abc123 kind=dispatch from="x" ticket=WP-9>' + 'y'.repeat(900) + '</wt-message>'
  const ptr = '<wt-message id=abc123 kind=dispatch from="x" ticket=WP-9>Read it with: wt-message show abc123, do what it asks, then report as it says</wt-message>'
  let [c, io] = rec()
  await promptOn(io, 't1', '/goal ' + msg)
  assert.deepEqual(c, [`send t1 /goal ${ptr}`])
  ;[c, io] = rec()
  await promptOn(io, 't1', '/goal ' + ptr) // deliver() already passes the pointer
  assert.deepEqual(c, [`send t1 /goal ${ptr}`])
})
test('WP-248: with confirm, a line left in the input box gets Enter again (bounded), else the send fails', async () => {
  const rule = '─'.repeat(30); let box = 'still here'
  const [c, io] = rec(async () => `${rule}\n❯ ${box}\n${rule}`)
  const keys = io.keys
  io.keys = async (...a) => { await keys(...a); if (c.filter((x) => x.startsWith('keys')).length === 1) box = '' }
  await promptOn(io, 't1', '/wt-audit', { confirm: true, settleMs: 0 })
  assert.deepEqual(c.filter((x) => x.startsWith('keys')), ['keys t1 enter']) // one Enter that cleared it
  box = 'stuck'
  const [c2, io2] = rec(async () => `${rule}\n❯ ${box}\n${rule}`)
  await assert.rejects(promptOn(io2, 't1', '/wt-audit', { confirm: true, settleMs: 0 }), /not submitted/)
  assert.ok(c2.filter((x) => x.startsWith('keys')).length >= 1)
})
