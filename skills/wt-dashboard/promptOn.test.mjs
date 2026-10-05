import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
test('WP-243: a long /goal types a short line naming a mode-600 message file (paste if the file cannot be written)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'po-')); process.env.WT_MESSAGES_DIR = dir
  const msg = '<wt-message id=abc123 kind=dispatch from="x" ticket=WP-9>' + 'y'.repeat(900) + '</wt-message>'
  let [c, h] = rec()
  await promptOn(h, {}, 'p1', '/goal ' + msg)
  const file = join(dir, 'abc123.md')
  assert.deepEqual(c, [`pane send-text p1 /goal WP-9: do the task in ${file}; reporting what it asks for is the goal`, 'pane send-keys p1 enter'])
  assert.equal(readFileSync(file, 'utf8'), msg + '\n'); assert.equal(statSync(file).mode & 0o777, 0o600)
  ;[c, h] = rec(true)
  await promptOn(h, {}, 'p1', '/goal ' + msg)
  assert.equal(c[1], 'agent prompt p1 /goal ' + msg) // could not type: whole thing pasted
  process.env.WT_MESSAGES_DIR = join(file, 'nope') // unwritable
  ;[c, h] = rec()
  await promptOn(h, {}, 'p1', '/goal ' + msg)
  assert.deepEqual(c, ['agent prompt p1 /goal ' + msg])
  delete process.env.WT_MESSAGES_DIR
})
test('WP-248: with confirm, a typed line left in the input box gets Enter again (bounded), else the send fails', async () => {
  const rule = '─'.repeat(30); let box = 'still here', c = [], clears = true
  const h = async (m, ...a) => { c.push(a.join(' ')); if (a[1] === 'read') return `${rule}\n❯ ${box}\n${rule}`; if (a[1] === 'send-keys' && clears && c.filter((x) => x.includes('send-keys')).length === 2) box = '' }
  await promptOn(h, {}, 'p1', '/wt-audit', { confirm: true, settleMs: 0 })
  assert.deepEqual(c.filter((x) => x.includes('send-keys')).length, 2) // typed Enter + one retry that cleared it
  box = 'stuck'; c = []; clears = false
  await assert.rejects(promptOn(h, {}, 'p1', '/wt-audit', { confirm: true, settleMs: 0 }), /not submitted/)
})
