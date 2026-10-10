// Run: node --test agentinfo.test.mjs — WP-313 AgentInfo builders: one shape for a pane and a headless run, null when unknown.
import test from 'node:test'
import assert from 'node:assert/strict'
import { contextOf, paneInfo, headlessInfo } from './agentinfo.mjs'

const CORE = ['kind', 'key', 'name', 'role', 'persona', 'cwd', 'project', 'state', 'model', 'effort', 'permissionMode', 'plugins', 'sessionId', 'commands', 'skills',
  'contextUsed', 'contextWindow', 'contextPct', 'costUsd', 'turns', 'startedAt', 'lastActivity']

test('contextOf: WP-201 rule — last turn in+cache, 200k window, 1M for [1m] or once a turn passed 200k', () => {
  assert.deepEqual(contextOf('claude-opus-5-5', { in: 100, cr: 49_900, cw: 0 }), { used: 50_000, window: 200_000, pct: 25 })
  assert.equal(contextOf('claude-opus-5-5[1m]', { in: 100_000, cr: 0, cw: 0 }).window, 1_000_000)
  assert.equal(contextOf('x', { in: 10, cr: 0, cw: 0, peak: 300_000 }).window, 1_000_000)
  assert.equal(contextOf('x', { in: 900_000, cr: 900_000, cw: 0 }).pct, 100)
  assert.equal(contextOf('x', null), null)
})

test('paneInfo and headlessInfo share one core; unknowns are null, never invented', () => {
  const pane = paneInfo({ key: 'm/w1:p1', id: 'w1:p1', machine: 'm', local: true, name: 'wt-pack-worker-01', pool: 'worker', tags: { role: 'worker', dnd: '1', pair: 'x' }, status: 'working',
    cwd: '/r', project: 'wt-pack', session: 's1', model: { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5', effort: 'medium' }, context: { used: '1', total: '2', pct: 31 }, lastActivity: 5 })
  const hl = headlessInfo({ id: 'hl-1', name: 'wt-pack-planner-01', role: 'planner', persona: null, cwd: '/r', model: 'opus', effort: 'high', init_model: 'claude-opus-5-5',
    permission_mode: 'default', plugins: '["wt-pack"]', session: 's2', init_commands: '{"slash_commands":["compact"],"skills":["wt-ask"]}', cost_usd: 0.02, turns: 3,
    started: 1, last_event: 9, state: 'idle', resumes: 1, stuck: null, reason: null, pid: 7 }, { state: 'idle', project: 'wt-pack', usage: { in: 40_000, cr: 0, cw: 0, peak: 40_000 } })
  for (const i of [pane, hl]) for (const k of CORE) assert.ok(k in i, `${i.kind}.${k}`)
  assert.equal(pane.kind, 'pane'); assert.equal(pane.pane.dnd, true); assert.equal(pane.pane.pair, 'x')
  assert.deepEqual([pane.plugins, pane.commands, pane.costUsd, pane.turns, pane.permissionMode, pane.startedAt], [null, null, null, null, null, null])
  assert.deepEqual([pane.contextUsed, pane.contextWindow, pane.contextPct], [null, null, 31]) // no transcript: only the pane's own %
  assert.equal(pane.model.id, 'claude-sonnet-5-5'); assert.equal(pane.effort, 'medium'); assert.equal(pane.role, 'worker')
  assert.equal(hl.kind, 'headless'); assert.equal(hl.run.resumes, 1); assert.equal(hl.run.pid, 7)
  assert.deepEqual(hl.plugins, ['wt-pack']); assert.deepEqual(hl.commands, ['compact']); assert.deepEqual(hl.skills, ['wt-ask'])
  assert.deepEqual([hl.contextUsed, hl.contextWindow, hl.contextPct], [40_000, 200_000, 20])
  assert.deepEqual([hl.costUsd, hl.turns, hl.startedAt, hl.lastActivity], [0.02, 3, 1, 9])
  assert.deepEqual(hl.model, { id: 'claude-opus-5-5', name: 'claude-opus-5-5' })
  const bare = headlessInfo({ id: 'hl-2', name: 'n', role: 'worker', cwd: '/r', state: 'queued' })
  assert.deepEqual([bare.model, bare.plugins, bare.commands, bare.contextPct, bare.costUsd, bare.turns], [null, null, null, null, null, null])
})
