import test from 'node:test'
import assert from 'node:assert/strict'
import { kindOf, modelLabel, contextLabel, modelRows, type AgentInfo } from './agentInfo.ts'

// `satisfies AgentInfo` is the typecheck test: tsc (npm run typecheck:web) fails when the contract and a consumer drift.
const core = { key: 'k', name: 'n', role: 'worker', persona: null, cwd: '/r', project: 'p', state: 'idle', model: { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5' }, effort: 'medium', effortSource: 'default',
  permissionMode: null, plugins: null, sessionId: null, commands: null, skills: null, contextUsed: null, contextWindow: null, contextPct: null, costUsd: null, turns: null, startedAt: null, lastActivity: null } as const
const pane = { ...core, kind: 'pane', pane: { id: 'w1:p1', machine: 'm', local: true, tags: {}, dnd: false, pair: null, workspace: null, pid: null, routed: null } } satisfies AgentInfo
const run = { ...core, kind: 'headless', permissionMode: 'default', plugins: ['wt-pack'], commands: ['compact'], skills: [], sessionId: 'abcdef123456', turns: 0, costUsd: 0.5, contextUsed: 40_000, contextWindow: 200_000, contextPct: 20,
  run: { id: 'hl-1', state: 'idle', resumes: 0, stuck: null, reason: null, pid: null, driver: 'cli' } } satisfies AgentInfo

test('kindOf prefers info.kind, falls back to the headless flag', () => {
  assert.equal(kindOf(pane), 'pane'); assert.equal(kindOf({ info: run }), 'headless'); assert.equal(kindOf({ headless: true }), 'headless'); assert.equal(kindOf({}), 'pane')
})
test('modelLabel / contextLabel / modelRows show only what is known', () => {
  assert.equal(modelLabel(pane), 'Sonnet 5.5 · medium (default)'); assert.equal(modelLabel({ ...pane, model: null, effort: null }), '')
  assert.equal(contextLabel(pane), null); assert.equal(contextLabel(run), '20% · 40k / 200k'); assert.equal(contextLabel({ ...pane, contextPct: 31 }), '31%')
  assert.deepEqual(modelRows(pane).map((r) => r[0]), ['Running'])
  assert.deepEqual(modelRows(run).map((r) => r[0]), ['Running', 'Driver', 'Permissions', 'Session', 'Turns', 'Cost', 'Plugins', 'Commands'])
  assert.deepEqual(modelRows(run).find((r) => r[0] === 'Turns'), ['Turns', '0']) // a real 0 is shown, null is not
})
