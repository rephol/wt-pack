import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, statSync, mkdirSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'jev-'))
process.env.WT_JEV_LOG = join(dir, 'calls.jsonl')
process.env.WT_DASHBOARD_ENV = join(dir, 'env')
delete process.env.TYPESAFE_API_KEY
const { judge, enabled, minFor, apiKey } = await import('./typesafe.mjs')
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

// WP-136: a 401/403 is the key itself being rejected, not an ordinary fail-open — logged distinctly so it isn't
// read as normal Jev noise (Observability, routing tuning).
test('HTTP 401 → null, logged as auth_error not failopen', async () => {
  assert.equal(await judge('t', { a: 2.1 }, Q, { key: 'k', fetchImpl: async () => ({ ok: false, status: 401 }) }), null)
  assert.deepEqual([lines().at(-1).err, lines().at(-1).outcome], ['http_401', 'auth_error'])
})

test('HTTP 403 → auth_error', async () => {
  assert.equal(await judge('t', { a: 2.2 }, Q, { key: 'k', fetchImpl: async () => ({ ok: false, status: 403 }) }), null)
  assert.deepEqual([lines().at(-1).err, lines().at(-1).outcome], ['http_403', 'auth_error'])
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

// WP-136: apiKey() must check the Keychain before ~/.claude/.env, matching the dashboard's own precedence
// (config.mjs: env var > Keychain > env file) — otherwise a rotated Keychain key never wins over a stale
// .env one in agent processes (no TYPESAFE_API_KEY in their env), which is exactly how the 401s happened.
test('apiKey() prefers the Keychain over a stale ~/.claude/.env line', () => {
  const home = mkdtempSync(join(tmpdir(), 'jev-home-'))
  mkdirSync(join(home, '.claude'), { recursive: true })
  writeFileSync(join(home, '.claude', '.env'), 'TYPESAFE_API_KEY=stale-env-key\n')
  const bin = join(home, 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'security'), '#!/bin/sh\necho fresh-keychain-key\n')
  chmodSync(join(bin, 'security'), 0o755)
  const prevHome = process.env.HOME, prevPath = process.env.PATH
  process.env.HOME = home
  process.env.PATH = `${bin}:${prevPath}`
  try {
    assert.equal(apiKey(), 'fresh-keychain-key')
  } finally {
    process.env.HOME = prevHome
    process.env.PATH = prevPath
  }
})

test('enabled/minFor read env then the dashboard env file', () => {
  writeFileSync(process.env.WT_DASHBOARD_ENV, 'WT_JEV_FOO=on\nWT_JEV_FOO_MIN=0.8\n')
  assert.equal(enabled('foo'), true)
  assert.equal(enabled('bar', true), true)
  assert.equal(minFor('foo'), 0.8)
  process.env.WT_JEV_FOO = 'off'
  assert.equal(enabled('foo'), false)
})

test('wt-judge triage --classes fails open: switch off or no key → exit 3 (babysit reads every comment)', async () => {
  const { spawnSync } = await import('node:child_process')
  const f = join(dir, 'c.json'); writeFileSync(f, '[{"body":"x"}]')
  const judgeBin = new URL('./wt-judge.mjs', import.meta.url).pathname
  const off = spawnSync(process.execPath, [judgeBin, 'triage', f, '--classes'], { env: { ...process.env, WT_JEV_BABYSIT_TRIAGE: 'off' } })
  assert.equal(off.status, 3)
  const nokey = spawnSync(process.execPath, [judgeBin, 'triage', '--classes', f], { env: { ...process.env, WT_JEV_BABYSIT_TRIAGE: 'on', TYPESAFE_API_KEY: '', HOME: dir } })
  assert.equal(nokey.status, 3)
})

test('eval/probe calls are logged with test: true; real features are not (WP-30)', async () => {
  const fail = { key: 'k', fetchImpl: async () => ({ ok: false, status: 500 }) }
  await judge('eval:route', { a: 90 }, Q, fail)
  assert.equal(lines().at(-1).test, true)
  await judge('route', { a: 91 }, Q, fail)
  assert.equal(lines().at(-1).test, undefined)
})

test('a transient 5xx is retried once within the budget (WP-47); a 4xx is not', async () => {
  let n = 0
  const flaky = async () => (++n === 1 ? { ok: false, status: 500 } : { ok: true, status: 200, json: async () => ({ answers: { q: 1 } }) })
  assert.deepEqual(await judge('t', { a: 70 }, Q, { key: 'k', fetchImpl: flaky }), { q: 1 })
  assert.equal(n, 2)
  let m = 0
  assert.equal(await judge('t', { a: 71 }, Q, { key: 'k', fetchImpl: async () => (++m, { ok: false, status: 400 }) }), null)
  assert.equal(m, 1)
})
