// Run: node --test agentinfo.test.mjs — WP-313 AgentInfo builders: one shape for a pane and a headless run, null when unknown.
import test from 'node:test'
import assert from 'node:assert/strict'
import { contextOf, tokensOf, paneInfo, headlessInfo } from './agentinfo.mjs'

const CORE = ['kind', 'key', 'name', 'role', 'persona', 'cwd', 'project', 'state', 'model', 'effort', 'permissionMode', 'plugins', 'sessionId', 'commands', 'skills',
  'contextUsed', 'contextWindow', 'contextPct', 'costUsd', 'turns', 'startedAt', 'lastActivity']

test('contextOf: WP-201 rule — last turn in+cache, 200k window, 1M for [1m] or once a turn passed 200k', () => {
  assert.deepEqual(contextOf('claude-opus-5-5', { in: 100, cr: 49_900, cw: 0 }), { used: 50_000, window: 200_000, pct: 25 })
  assert.equal(contextOf('claude-opus-5-5[1m]', { in: 100_000, cr: 0, cw: 0 }).window, 1_000_000)
  assert.equal(contextOf('x', { in: 10, cr: 0, cw: 0, peak: 300_000 }).window, 1_000_000)
  assert.equal(contextOf('x', { in: 900_000, cr: 900_000, cw: 0 }).pct, 100)
  assert.equal(contextOf('x', null), null)
  // WP-314: a reported window wins over the guess; none reported = the guess
  assert.deepEqual(contextOf('claude-opus-5-5', { in: 40_000, cr: 0, cw: 0 }, 1_000_000), { used: 40_000, window: 1_000_000, pct: 4 })
  assert.equal(contextOf('claude-opus-5-5[1m]', { in: 1, cr: 0, cw: 0 }, 200_000).window, 200_000)
  assert.equal(contextOf('x', { in: 1, cr: 0, cw: 0 }, null).window, 200_000)
  assert.deepEqual(['1M', '1.0M', '200k', 'x', null].map(tokensOf), [1_000_000, 1_000_000, 200_000, null, null])
})

test('a pane\'s status-line total is its reported window (WP-314)', () => {
  const i = paneInfo({ key: 'k', id: 'p', machine: 'm', local: true, name: 'n', pool: 'worker', status: 'idle', cwd: '/r', session: 's', model: { id: 'claude-opus-5-5', name: 'Opus' }, context: { used: '40k', total: '1M', pct: 4 } },
    { in: 40_000, cr: 0, cw: 0, peak: 40_000 })
  assert.deepEqual([i.contextUsed, i.contextWindow, i.contextPct], [40_000, 1_000_000, 4])
})
test('paneInfo and headlessInfo share one core; unknowns are null, never invented', () => {
  const pane = paneInfo({ key: 'm/w1:p1', id: 'w1:p1', machine: 'm', local: true, name: 'wt-pack-worker-01', pool: 'worker', tags: { role: 'worker', dnd: '1', pair: 'x' }, status: 'working',
    cwd: '/r', project: 'wt-pack', session: 's1', model: { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5', effort: 'medium' }, context: { used: '1', total: '2', pct: 31 }, lastActivity: 5 })
  const hl = headlessInfo({ id: 'hl-1', name: 'wt-pack-planner-01', role: 'planner', persona: null, cwd: '/r', model: 'opus', effort: 'high', init_model: 'claude-opus-5-5',
    permission_mode: 'default', plugins: '["wt-pack"]', session: 's2', init_commands: '{"slash_commands":["compact"],"skills":["wt-ask"]}', cost_usd: 0.02, turns: 3,
    started: 1, last_event: 9, context_window: 1_000_000, state: 'idle', resumes: 1, stuck: null, reason: null, pid: 7 }, { state: 'idle', project: 'wt-pack', usage: { in: 40_000, cr: 0, cw: 0, peak: 40_000 } })
  for (const i of [pane, hl]) for (const k of CORE) assert.ok(k in i, `${i.kind}.${k}`)
  assert.equal(pane.kind, 'pane'); assert.equal(pane.pane.dnd, true); assert.equal(pane.pane.pair, 'x')
  assert.deepEqual([pane.plugins, pane.commands, pane.costUsd, pane.turns, pane.permissionMode, pane.startedAt], [null, null, null, null, null, null])
  assert.deepEqual([pane.contextUsed, pane.contextWindow, pane.contextPct], [null, null, 31]) // no transcript: only the pane's own %
  assert.equal(pane.model.id, 'claude-sonnet-5-5'); assert.equal(pane.effort, 'medium'); assert.equal(pane.role, 'worker')
  assert.equal(hl.run.driver, 'cli'); assert.equal(headlessInfo({ id: 'x', name: 'n', role: 'w', cwd: '/', driver: 'sdk' }).run.driver, 'sdk')
  assert.equal(hl.kind, 'headless'); assert.equal(hl.run.resumes, 1); assert.equal(hl.run.pid, 7)
  assert.deepEqual(hl.plugins, ['wt-pack']); assert.deepEqual(hl.commands, ['compact']); assert.deepEqual(hl.skills, ['wt-ask'])
  assert.deepEqual([hl.contextUsed, hl.contextWindow, hl.contextPct], [40_000, 1_000_000, 4]) // the run's reported window, not the 200k guess
  assert.deepEqual([hl.costUsd, hl.turns, hl.startedAt, hl.lastActivity], [0.02, 3, 1, 9])
  assert.deepEqual(hl.model, { id: 'claude-opus-5-5', name: 'claude-opus-5-5' })
  const bare = headlessInfo({ id: 'hl-2', name: 'n', role: 'worker', cwd: '/r', state: 'queued' })
  assert.deepEqual([bare.model, bare.plugins, bare.commands, bare.contextPct, bare.costUsd, bare.turns], [null, null, null, null, null, null])
})

test('paneInfo carries the claude pid from the cross-check; null when unknown (WP-324)', () => {
  const a = { key: 'k', id: 'p', machine: 'm', local: true, name: 'n', pool: 'worker', status: 'idle' }
  assert.equal(paneInfo(a, null, 4242).pane.pid, 4242)
  assert.equal(paneInfo(a).pane.pid, null)
})
