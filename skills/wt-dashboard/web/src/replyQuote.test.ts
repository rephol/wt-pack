import test from 'node:test'
import assert from 'node:assert/strict'
import { excerpt, withReply } from './replyQuote.ts'

test('withReply: quotes the first non-empty line ahead of the text; no reply leaves it alone', () => {
  assert.equal(withReply({ name: 'w-01', text: '\n  Done: merged.\nmore' }, 'thanks'), 'replying to w-01: "Done: merged."\n\nthanks')
  assert.equal(withReply(null, 'hi'), 'hi')
  assert.equal(excerpt('x'.repeat(300)).length, 200)
})
