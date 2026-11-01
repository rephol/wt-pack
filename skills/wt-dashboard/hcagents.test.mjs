// WP-378 U5: the pure part of the hc read side (hcagents.mjs): which terminals are agents, their states, the snapshot maps,
// the claude pid -> session map and the core-identity rule. Rows come from the RECORDED terminal.list (test-hc.mjs templates).
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalise } from '../wt-shared/scripts/hc.mjs'
import { agentStatus, snapshot, sessionsByPid, coreChanged, dropPaneKeys, POOL_LABEL } from './hcagents.mjs'
import { terminal, shell, finished } from './test-hc.mjs'

const N = (r) => normalise(r)
const claude = (state, over = {}) => N(terminal({ status: state, ...over }))

test('a live claude is an agent in the state it reports; done is the resting state; error is unknown; a claude that has not reported is idle', () => {
  for (const s of ['idle', 'working', 'done', 'blocked']) assert.equal(agentStatus(claude(s)), s)
  assert.equal(agentStatus(claude('error')), 'unknown')
  assert.equal(agentStatus(claude(null)), 'idle')
})

test('a finished terminal or a kept login shell is exited only when the pack knows it; anybody else\'s terminal is not an agent', () => {
  const sh = N(shell({ name: 'k1' })), fin = N(finished({ name: 'old-1' }))
  assert.equal(agentStatus(sh), null, 'an unknown login shell is not ours')
  assert.equal(agentStatus(fin), null)
  assert.equal(agentStatus(sh, new Set(['k1'])), 'exited', 'a kept shell at a known agent\'s name')
  assert.equal(agentStatus(fin, new Set(['old-1'])), 'exited')
  assert.equal(agentStatus(N(finished({ labels: { role: 'worker' } }))), 'exited', 'a role label still marks it')
  // a kept shell is a live shell: never an idle agent that a send could type into
  assert.notEqual(agentStatus(sh, new Set(['k1'])), 'idle')
})

test('a <project>-shells terminal is the Terminals view\'s, never an agent', () => {
  assert.equal(agentStatus(claude('idle', { labels: { [POOL_LABEL]: 'wt-pack-shells' } })), null)
  assert.equal(agentStatus(N(shell({ name: 'x', labels: { [POOL_LABEL]: 'wt-pack-shells', role: 'worker' } })), new Set(['x'])), null)
})

test('snapshot: agents in the pane-record shape, the pool as workspace, only the mirrored keys as tokens, finished ones kept in ids', () => {
  const raw = terminal({ address: 't1', name: 'a-worker-01', status: 'blocked', labels: { role: 'worker', task: 'WP-1', 'wt.pool': 'a-workers', mine: 'x' }, cwd: '/w' })
  Object.assign(raw.status, { kind: 'permission', msg: 'approve Write: /w/x' })
  const a = N(raw)
  const fin = N(finished({ address: 't2', name: 'a-worker-02' }))
  const snap = snapshot([a, fin], { known: new Set(['a-worker-02']), tagKeys: ['role', 'task', 'pair'] })
  assert.deepEqual(snap.agents.map((x) => [x.pane_id, x.name, x.agent_status]), [['t1', 'a-worker-01', 'blocked'], ['t2', 'a-worker-02', 'exited']])
  assert.deepEqual(snap.agents[0].blocked, { kind: 'permission', msg: 'approve Write: /w/x' })
  assert.equal(snap.ws.get('t1'), 'a-workers')
  assert.deepEqual(snap.tokens.get('t1'), { role: 'worker', task: 'WP-1' }, 'wt.pool and a user\'s own label are not tokens')
  assert.deepEqual([...snap.ids].sort(), ['t1', 't2'])
  const before = snap.agents[0].state_change_seq
  const again = snapshot([{ ...a, turn: a.turn + 1 }], { tagKeys: [] }).agents[0].state_change_seq
  assert.notEqual(before, again, 'a new turn is a state change for the re-read cadence')
})

test('sessionsByPid: claude agents --json maps the terminal\'s foreground pid to its session; junk is ignored', () => {
  const m = sessionsByPid([{ sessionId: 's1', pid: 41 }, { sessionId: 's2', pid: '42' }, { pid: 9 }, null])
  assert.equal(m.get(41), 's1'); assert.equal(m.get(42), 's2'); assert.equal(m.size, 2)
  assert.equal(sessionsByPid('nope').size, 0)
})

test('coreChanged: first sight stores the id and drops nothing; the same id is a no-op; a different id drops rows and pane keys once', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hccore-')), file = join(dir, 'hc-core.json')
  let rows = 0, keys = 0
  const o = { dropRows: () => rows++, dropKeys: () => keys++ }
  assert.equal(coreChanged(file, undefined, o), 'unknown'); assert.ok(!existsSync(file), 'no id, nothing stored')
  assert.equal(coreChanged(file, 'A', o), 'new'); assert.deepEqual([rows, keys], [0, 0])
  assert.equal(coreChanged(file, 'A', o), 'same')
  assert.equal(coreChanged(file, 'B', o), 'changed'); assert.deepEqual([rows, keys], [1, 1])
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).id, 'B')
  assert.equal(coreChanged(file, 'B', o), 'same'); assert.deepEqual([rows, keys], [1, 1])
})

test('dropPaneKeys removes every key file and tolerates a missing dir', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hckeys-'))
  writeFileSync(join(dir, 't1'), 'k'); writeFileSync(join(dir, 't2'), 'k')
  assert.equal(dropPaneKeys(dir), 2); assert.ok(!existsSync(join(dir, 't1')))
  assert.equal(dropPaneKeys(join(dir, 'nope')), 0)
  mkdirSync(join(dir, 'sub')); assert.equal(dropPaneKeys(dir), 0, 'a directory is not a key file')
})

test('recorded: every hc verb the dashboard could poll with starts a stopped core, so it is gated by coreUp() (hc-starts-stopped-core.json)', () => {
  const rec = JSON.parse(readFileSync(new URL('./test-fixtures/hc-starts-stopped-core.json', import.meta.url), 'utf8'))
  assert.deepEqual(rec.steps.map((x) => [x.cmd.split(' ').slice(0, 2).join(' '), x.startsCore]), [['hc connect', true], ['hc server', true], ['hc ls', true], ['hc get', true]])
  // the server never calls hc outside the coreUp()-gated helpers: hcRows() (gate), checkCore() (gate), and calls on a terminal an agent route already resolved
  const src = readFileSync(new URL('./server.mjs', import.meta.url), 'utf8')
  assert.match(src, /const hcRows = \(\) => cached\('hc:rows', 3000, async \(\) => \{\n  if \(!\(await coreIsUp\(\)\)\) throw hcDown\(\)/)
  assert.match(src, /async function checkCore\(\) \{\n  if \([^\n]*!\(await coreIsUp\(\)\)\) return/)
  assert.match(src, /async function agents\(\) \{\n[^\n]*\n  if \(!\(await coreIsUp\(\)\)\)/)
})
