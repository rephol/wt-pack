import test from 'node:test'
import assert from 'node:assert/strict'
import { termInput } from './termKeys.ts'
test('termInput: special keys, text, paste, and nothing else', () => {
  assert.deepEqual(termInput('\r'), { keys: ['Enter'] })
  assert.deepEqual(termInput('\x03'), { keys: ['C-c'] })
  assert.deepEqual(termInput('\x1b[A'), { keys: ['Up'] })
  assert.deepEqual(termInput('ls -la'), { text: 'ls -la' })
  assert.deepEqual(termInput('echo a\recho b'), { text: 'echo a\necho b' })
  assert.equal(termInput('\x1b[15~'), null) // F5
  assert.equal(termInput('\x1bx'), null) // alt-x
})
