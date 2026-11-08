import test from 'node:test'
import assert from 'node:assert/strict'
import { promptOn } from './promptOn.mjs'

const rec = (fail) => { const c = []; return [c, async (m, ...a) => { c.push(a.join(' ')); if (fail && a[1] === 'send-text') throw new Error('x') }] }

test('WP-240: a one-line slash command is typed, not pasted', async () => {
  const [c, h] = rec()
  await promptOn(h, {}, 'p1', '/goal <wt-message kind=routine>do it</wt-message>')
  assert.deepEqual(c, ['pane send-text p1 /goal <wt-message kind=routine>do it</wt-message>', 'pane send-keys p1 enter']) // short: whole line typed
})
test('WP-240: plain text and multi-line slash text paste; a failed send-text falls back to paste', async () => {
  let [c, h] = rec()
  await promptOn(h, {}, 'p1', 'hello'); await promptOn(h, {}, 'p1', '/goal a\nb')
  assert.deepEqual(c, ['agent prompt p1 hello', 'agent prompt p1 /goal a\nb'])
  ;[c, h] = rec(true)
  await promptOn(h, {}, 'p1', '/wt-audit')
  assert.deepEqual(c, ['pane send-text p1 /wt-audit', 'agent prompt p1 /wt-audit'])
})
test('WP-352: a long /goal envelope is typed as its short pointer, never "do the task in <file>" (paste of the pointer if send-text fails)', async () => {
  const msg = '<wt-message id=abc123 kind=dispatch from="x" ticket=WP-9>' + 'y'.repeat(900) + '</wt-message>'
  const ptr = '<wt-message id=abc123 kind=dispatch from="x" ticket=WP-9>Read it with: wt-message show abc123, do what it asks, then report as it says</wt-message>'
  let [c, h] = rec()
  await promptOn(h, {}, 'p1', '/goal ' + msg)
  assert.deepEqual(c, [`pane send-text p1 /goal ${ptr}`, 'pane send-keys p1 enter'])
  ;[c, h] = rec()
  await promptOn(h, {}, 'p1', '/goal ' + ptr) // deliver() already passes the pointer
  assert.deepEqual(c, [`pane send-text p1 /goal ${ptr}`, 'pane send-keys p1 enter'])
  ;[c, h] = rec(true)
  await promptOn(h, {}, 'p1', '/goal ' + msg)
  assert.equal(c[1], `agent prompt p1 /goal ${ptr}`)
})
test('WP-248: with confirm, a typed line left in the input box gets Enter again (bounded), else the send fails', async () => {
  const rule = '─'.repeat(30); let box = 'still here', c = [], clears = true
  const h = async (m, ...a) => { c.push(a.join(' ')); if (a[1] === 'read') return `${rule}\n❯ ${box}\n${rule}`; if (a[1] === 'send-keys' && clears && c.filter((x) => x.includes('send-keys')).length === 2) box = '' }
  await promptOn(h, {}, 'p1', '/wt-audit', { confirm: true, settleMs: 0 })
  assert.deepEqual(c.filter((x) => x.includes('send-keys')).length, 2) // typed Enter + one retry that cleared it
  box = 'stuck'; c = []; clears = false
  await assert.rejects(promptOn(h, {}, 'p1', '/wt-audit', { confirm: true, settleMs: 0 }), /not submitted/)
})
