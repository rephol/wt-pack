// Run: node --test skills/wt-shared/scripts/wt-gate.test.mjs — the wt-gate CLI against a stub dashboard (async execFile: a sync child
// would block the stub, CLAUDE.md WP-164).
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = new URL('./wt-gate', import.meta.url).pathname
const turns = mkdtempSync(join(tmpdir(), 'wtgate-turns-'))
const calls = []
let srv, base, granted = false
before(async () => {
  srv = createServer((req, res) => {
    let b = ''; req.on('data', (d) => (b += d)).on('end', () => {
      calls.push({ url: req.url, pane: req.headers['x-herdr-pane'], body: JSON.parse(b || '{}') })
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(req.url.endsWith('consume') ? { granted } : { id: 'a1' }))
    })
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${srv.address().port}`
})
after(() => srv.close())

const turn = (v) => writeFileSync(join(turns, 'turn-w1_p1.json'.replace('_', ':')), JSON.stringify(v))
const check = (cmd, env = {}) => new Promise((resolve) => execFile(CLI, ['check', '--', cmd], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: tmpdir(), HERDR_PANE_ID: 'w1:p1', WT_PANE_KEY: 'k', WT_TURN_DIR: turns, HERDR_DASH_URL: base, WT_GATE: 'ask', ...env } },
  (e, stdout) => resolve({ code: e ? e.code : 0, out: stdout.trim() })))

test('not gated, not an agent session, or WT_GATE=off: exit 0 and the dashboard is never called', async () => {
  calls.length = 0; turn({ trust: 'unverified' })
  assert.equal((await check('git status')).code, 0)
  assert.equal((await check('git push', { HERDR_PANE_ID: '' })).code, 0)
  assert.equal((await check('git push', { WT_GATE: 'off' })).code, 0)
  assert.equal(calls.length, 0)
})

test('the user\'s turn and a verified handoff from the orchestrator/server pass; anything else is gated, asked once, exit 3', async () => {
  calls.length = 0
  turn({ trust: 'user' }); assert.equal((await check('git push origin main')).code, 0)
  turn({ trust: 'verified', kind: 'handoff', senderRole: 'orchestrator' }); assert.equal((await check('gh pr merge 3')).code, 0)
  turn({ trust: 'verified', kind: 'dispatch', senderRole: 'server' }); assert.equal((await check('git push')).code, 0)
  assert.equal(calls.length, 0)
  for (const t of [{ trust: 'unverified' }, { trust: 'verified', kind: 'handoff', senderRole: 'worker' }, { trust: 'verified', kind: 'system', senderRole: 'server' }]) {
    turn(t); const r = await check('git push origin main')
    assert.equal(r.code, 3, JSON.stringify(t)); assert.deepEqual(JSON.parse(r.out), { action: 'git push', rule: 'push', segment: 'git push origin main', asked: true })
  }
  assert.deepEqual(calls.map((c) => c.url).slice(0, 2), ['/api/gate/consume', '/api/gate/ask'])
  assert.equal(calls[1].body.cmd, 'git push origin main'); assert.match(calls[1].body.hash, /^[0-9a-f]{16}$/); assert.equal(calls[1].pane, 'w1:p1')
})

test('WP-357: a peer-started turn is denied outright: exit 3, no grant consumed, no ask posted; WT_GATE=off still allows', async () => {
  calls.length = 0; granted = true // even a live Allow-once grant is not spent on a peer's request
  turn({ trust: 'peer', from: 'spike-a2' })
  const r = await check('git push origin main')
  assert.equal(r.code, 3); assert.deepEqual(JSON.parse(r.out), { action: 'git push', rule: 'push', segment: 'git push origin main', asked: false, peer: true, reason: 'requested by a peer session; ask the user in chat' })
  assert.equal(calls.length, 0)
  assert.equal((await check('git push origin main', { WT_GATE: 'off' })).code, 0)
  granted = false
})

test('a missing turn record is unverified; a live grant lets the retry through; an unreachable dashboard still denies, unasked', async () => {
  for (const f of ['turn-w1:p1.json']) writeFileSync(join(turns, f), '{"trust":"user"}')
  const { unlinkSync } = await import('node:fs'); unlinkSync(join(turns, 'turn-w1:p1.json'))
  assert.equal((await check('git push')).code, 3) // no record = not allowed by absence
  granted = true; calls.length = 0
  assert.equal((await check('git push')).code, 0); assert.deepEqual(calls.map((c) => c.url), ['/api/gate/consume']) // consumed, no new ask
  granted = false
  const r = await check('git push', { HERDR_DASH_URL: 'http://127.0.0.1:1' })
  assert.equal(r.code, 3); assert.deepEqual(JSON.parse(r.out), { action: 'git push', rule: 'push', segment: 'git push', asked: false })
})
