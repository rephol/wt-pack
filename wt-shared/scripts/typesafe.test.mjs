import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'jev-'))
process.env.WT_JEV_LOG = join(dir, 'calls.jsonl')
process.env.WT_DASHBOARD_ENV = join(dir, 'env')
delete process.env.TYPESAFE_API_KEY
const { judge, enabled, minFor } = await import('./typesafe.mjs')
const lines = () => readFileSync(process.env.WT_JEV_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
const ok = (answers) => async () => ({ ok: true, json: async () => ({ answers }) })
const Q = { q: { type: 'noul', instructions: 'x' } }

test('timeout → null, logged as timeout', async () => {
  // AbortSignal.timeout's timer is unref'd; keep the loop alive while waiting for it.
  const hang = (_u, o) => new Promise((_r, rej) => { const t = setTimeout(() => {}, 5000); o.signal.addEventListener('abort', () => { clearTimeout(t); rej(o.signal.reason) }) })
  assert.equal(await judge('t', { a: 1 }, Q, { key: 'k', fetchImpl: hang, timeoutMs: 30 }), null)
  assert.equal(lines().at(-1).err, 'timeout')
})

test('HTTP 500 → null', async () => {
  assert.equal(await judge('t', { a: 2 }, Q, { key: 'k', fetchImpl: async () => ({ ok: false, status: 500 }) }), null)
  assert.deepEqual([lines().at(-1).err, lines().at(-1).outcome], ['http_500', 'failopen'])
})

test('no key → null without fetching', async () => {
  let called = false
  const r = await judge('t', { a: 3 }, Q, { key: '', fetchImpl: async () => { called = true } })
  // key '' falls back to keyFor(); only assert when this machine has no key anywhere
  if (r === null) assert.equal(called, false)
})

test('cache hit makes no second fetch; record never holds the key', async () => {
  let n = 0
  const f = async () => { n++; return ok({ q: { noul: 0.9 } })() }
  const a = await judge('c', { a: 4 }, Q, { key: 'SECRETKEY', fetchImpl: f, pick: (x) => x.q.noul >= 0.7 })
  const b = await judge('c', { a: 4 }, Q, { key: 'SECRETKEY', fetchImpl: f })
  assert.deepEqual(a, b)
  assert.equal(n, 1)
  const [x, y] = lines().slice(-2)
  assert.deepEqual([x.outcome, x.p, x.cache, y.cache], ['picked', 0.9, false, true])
  assert.equal(x.in.length, 12)
  assert.ok(!readFileSync(process.env.WT_JEV_LOG, 'utf8').includes('SECRETKEY'))
  assert.equal(x.snippet, undefined)
})

test('rotates past 5 MB', async () => {
  writeFileSync(process.env.WT_JEV_LOG, 'x'.repeat(5 * 1024 * 1024 + 1))
  await judge('r', { a: 5 }, Q, { key: 'k', fetchImpl: async () => ({ ok: false, status: 503 }) })
  assert.ok(existsSync(process.env.WT_JEV_LOG + '.1'))
  assert.ok(statSync(process.env.WT_JEV_LOG).size < 1000)
})

test('enabled/minFor read env then the dashboard env file', () => {
  writeFileSync(process.env.WT_DASHBOARD_ENV, 'WT_JEV_FOO=on\nWT_JEV_FOO_MIN=0.8\n')
  assert.equal(enabled('foo'), true)
  assert.equal(enabled('bar', true), true)
  assert.equal(minFor('foo'), 0.8)
  process.env.WT_JEV_FOO = 'off'
  assert.equal(enabled('foo'), false)
})
