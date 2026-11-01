// Run: node --test skills/wt-agents/scripts/dnd.test.mjs — WP-147: `agents.sh dnd <name|id> on|off` sets/clears the `dnd` label
// through hc, resolving the target the way `rm` does (WP-378).
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fakeCore, harness, listCase, term } from './hc-test-kit.mjs'

const here = import.meta.dirname
const tmp = mkdtempSync(join(tmpdir(), 'wt-dnd-'))
const core = await fakeCore()
const made = []
after(() => { core.stop(); made.forEach((h) => h.fake.cleanup()); rmSync(tmp, { recursive: true, force: true }) })

const run = (args, dnd) => {
  const h = harness({ tmp, cases: { 'connect:terminal.list': listCase(term('t1', 'demo-worker-01', { status: 'idle', labels: dnd ? { dnd } : {} }), term('t2', 'demo-worker-09', { state: 'finished' })) }, extraEnv: core.env })
  made.push(h)
  const r = spawnSync(join(here, 'agents.sh'), args, { encoding: 'utf8', env: h.env })
  return { ...r, calls: h.fake.calls(), writes: h.fake.calls().filter((c) => c.args[0] === 'label').map((c) => c.args.slice(2)) }
}

test('dnd <name> on: sets the dnd label', () => {
  const r = run(['dnd', 'demo-worker-01', 'on'])
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout.trim(), 'dnd on: demo-worker-01 (t1)')
  assert.deepEqual(r.writes, [['t1', 'dnd=1']])
})

test('dnd <id> off: clears the dnd label', () => {
  const r = run(['dnd', 't1', 'off'])
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout.trim(), 'dnd off: t1 (t1)')
  assert.deepEqual(r.writes, [['t1', 'dnd=']])
})

test('dnd: bad state or unknown (or exited) agent', () => {
  let r = run(['dnd', 'demo-worker-01', 'sideways'])
  assert.equal(r.status, 2)
  assert.match(r.stderr, /dnd: on, off, or omit to query/)
  r = run(['dnd', 'nobody', 'on'])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /no such agent: nobody/)
  assert.equal(run(['dnd', 'demo-worker-09', 'on']).status, 1, 'a finished terminal cannot be marked')
})

test('dnd <name>: queries the current state without changing it', () => {
  assert.equal(run(['dnd', 'demo-worker-01'], '').stdout.trim(), 'dnd off: demo-worker-01 (t1)')
  assert.equal(run(['dnd', 'demo-worker-01'], '1').stdout.trim(), 'dnd on: demo-worker-01 (t1), no expiry')
  const r = run(['dnd', 'demo-worker-01'], '2099-01-01T00:00:00.000Z')
  assert.equal(r.stdout.trim(), 'dnd on: demo-worker-01 (t1) until 2099-01-01T00:00:00.000Z')
  assert.deepEqual(r.writes, []) // querying never writes
})

test('dnd on --for: writes an ISO expiry, same format as the dashboard', () => {
  const r = run(['dnd', 'demo-worker-01', 'on', '--for', '2h'])
  assert.equal(r.status, 0, r.stderr)
  const m = r.writes[0][1].match(/^dnd=(.+)$/)
  assert.ok(m, JSON.stringify(r.writes))
  const hoursAhead = (new Date(m[1]) - Date.now()) / 3_600_000
  assert.ok(hoursAhead > 1.9 && hoursAhead < 2.1, hoursAhead)
})

test('dnd on --for: bad duration is rejected; off --for is rejected', () => {
  let r = run(['dnd', 'demo-worker-01', 'on', '--for', 'soon'])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /bad --for duration/)
  r = run(['dnd', 'demo-worker-01', 'off', '--for', '2h'])
  assert.equal(r.status, 2)
  assert.match(r.stderr, /--for only valid with on/)
})
