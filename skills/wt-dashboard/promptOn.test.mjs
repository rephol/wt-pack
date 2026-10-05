import test from 'node:test'
import assert from 'node:assert/strict'
import { promptOn } from './promptOn.mjs'

const rec = (fail) => { const c = []; return [c, async (m, ...a) => { c.push(a.join(' ')); if (fail && a[1] === 'send-text') throw new Error('x') }] }

test('WP-240: a one-line slash command is typed, not pasted', async () => {
  const [c, h] = rec()
  await promptOn(h, {}, 'p1', '/goal <wt-message kind=routine>do it</wt-message>')
  assert.deepEqual(c, ['pane send-text p1 /goal <wt-message kind=routine>do it</wt-message>', 'pane send-keys p1 enter'])
})
test('WP-240: plain text and multi-line slash text paste; a failed send-text falls back to paste', async () => {
  let [c, h] = rec()
  await promptOn(h, {}, 'p1', 'hello'); await promptOn(h, {}, 'p1', '/goal a\nb')
  assert.deepEqual(c, ['agent prompt p1 hello', 'agent prompt p1 /goal a\nb'])
  ;[c, h] = rec(true)
  await promptOn(h, {}, 'p1', '/wt-audit')
  assert.deepEqual(c, ['pane send-text p1 /wt-audit', 'agent prompt p1 /wt-audit'])
})
