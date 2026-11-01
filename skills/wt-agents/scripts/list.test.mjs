// Run: node --test skills/wt-agents/scripts/list.test.mjs — WP-173: `list`/`list --json` surface dnd (+until) and pair (hc labels, WP-378).
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fakeCore, harness, listCase, term } from './hc-test-kit.mjs'

const here = import.meta.dirname
const tmp = mkdtempSync(join(tmpdir(), 'wt-list-'))
const core = await fakeCore()
const made = []
after(() => { core.stop(); made.forEach((h) => h.fake.cleanup()); rmSync(tmp, { recursive: true, force: true }) })

const pool = { 'wt.pool': 'demo-workers' }
const rows = [
  term('t1', 'demo-worker-01', { labels: pool, status: 'idle' }),
  term('t2', 'demo-worker-02', { labels: { ...pool, dnd: '1' }, status: 'working' }),
  term('t3', 'demo-worker-03', { labels: { ...pool, dnd: '2099-01-01T00:00:00.000Z', pair: 'WP-9' }, status: 'done' }),
  term('t4', 'demo-planner-01', { labels: { 'wt.pool': 'demo-planners' }, status: 'idle' }), // another pool
  term('t5', 'demo-worker-09', { labels: pool, state: 'finished' }), // exited: not listed
  term('t6', 'demo-worker-10', { labels: pool, program: 'zsh' }), // a keep shell at an agent's address: not an agent
]
const run = (args, { list = rows, path = null } = {}) => {
  const h = harness({ tmp, cases: { 'connect:terminal.list': listCase(...list) }, extraEnv: { ...core.env, WT_AGENTS_WORKSPACE: 'demo-workers' } })
  made.push(h)
  return spawnSync(join(here, 'agents.sh'), args, { encoding: 'utf8', env: { ...h.env, PATH: path ?? h.env.PATH } })
}

test('list: plain output marks dnd (with expiry) and pair, off agents unmarked; only live agents of the pool', () => {
  const r = run(['list', 'worker'])
  assert.equal(r.status, 0, r.stderr)
  const lines = r.stdout.trim().split('\n').map((l) => l.split('\t'))
  assert.deepEqual(lines.map((c) => c[0]), ['demo-worker-01', 'demo-worker-02', 'demo-worker-03'])
  const byName = Object.fromEntries(lines.map((c) => [c[0], c]))
  assert.deepEqual(byName['demo-worker-01'].slice(1, 3), ['t1', 'idle'])
  assert.deepEqual(byName['demo-worker-01'].slice(4), ['-', '-'])
  assert.deepEqual(byName['demo-worker-02'].slice(4), ['dnd', '-'])
  assert.deepEqual(byName['demo-worker-03'].slice(4), ['dnd until 2099-01-01T00:00:00.000Z', 'WP-9'])
})

test('list --json: exposes structured dnd:{on,until} and pair alongside raw labels as tokens', () => {
  const r = run(['list', 'worker', '--json'])
  assert.equal(r.status, 0, r.stderr)
  const o = Object.fromEntries(r.stdout.trim().split('\n').map((l) => { const x = JSON.parse(l); return [x.name, x] }))
  assert.deepEqual(o['demo-worker-01'].dnd, { on: false, until: null })
  assert.equal(o['demo-worker-01'].pair, null)
  assert.deepEqual(o['demo-worker-02'].dnd, { on: true, until: null })
  assert.deepEqual(o['demo-worker-03'].dnd, { on: true, until: '2099-01-01T00:00:00.000Z' })
  assert.equal(o['demo-worker-03'].pair, 'WP-9'); assert.equal(o['demo-worker-03'].pane, 't3')
  assert.equal(o['demo-worker-03'].tokens.dnd, '2099-01-01T00:00:00.000Z') // the raw map is untouched, for backward compat
})

test('WP-324: list --json adds session + pid from `claude agents --json` (matched on the terminal\'s claude pid); unknown to claude → null; no claude → still lists', () => {
  const b2 = join(tmp, 'bin2'); mkdirSync(b2)
  writeFileSync(join(b2, 'claude'), `#!/bin/sh\n[ "$1 $2" = "agents --json" ] && echo '[{"pid":4242,"sessionId":"sid-1","cwd":"/repo"}]'\n`)
  chmodSync(join(b2, 'claude'), 0o755)
  const two = [term('t1', 'demo-worker-01', { labels: pool, status: 'idle', pid: 4242 }), term('t2', 'demo-worker-02', { labels: pool, status: 'idle', pid: 9999 })]
  const got = (path) => run(['list', 'worker', '--json'], { list: two, path }).stdout.trim().split('\n').map((l) => JSON.parse(l))
  const h0 = harness({ tmp })
  made.push(h0)
  let r = got(`${b2}:${h0.env.PATH}`)
  assert.deepEqual(r.map((x) => [x.session, x.pid]), [['sid-1', 4242], [null, null]])
  rmSync(join(b2, 'claude'))
  r = got(`${h0.env.PATH.split(':')[0]}:/usr/bin:/bin:${dirname(process.execPath)}`) // no claude on PATH
  assert.deepEqual(r.map((x) => x.pid), [null, null])
})
