import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
process.env.WT_RECEIPTS_DIR = mkdtempSync(join(tmpdir(), 'rcpt-'))
const { once, get } = await import('./receipts.mjs')

test('same id twice sends once; different ids both send', async () => {
  let n = 0
  const send = async () => `sent ${++n}`
  assert.equal(await once('a', send), 'sent 1')
  assert.equal(await once('a', send), 'sent 1')
  assert.equal(await once('b', send), 'sent 2')
  assert.equal(n, 2)
})
test('concurrent repeats share one send; a failed send leaves no receipt', async () => {
  let n = 0
  const slow = async () => { n++; await new Promise((r) => setTimeout(r, 20)); return 'ok' }
  await Promise.all([once('c', slow), once('c', slow)])
  assert.equal(n, 1)
  await assert.rejects(once('d', async () => { throw new Error('x') }))
  assert.equal(get('d'), null)
})
