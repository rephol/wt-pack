import test from 'node:test'
import assert from 'node:assert/strict'
import { UsageAgg } from './usage.mjs'

test('agent-name lines attribute a session; unnamed sessions have no name', () => {
  const a = new UsageAgg()
  const msg = { type: 'assistant', sessionId: 's1', timestamp: new Date().toISOString(), message: { id: 'm1', model: 'x', usage: { input_tokens: 1 } } }
  a.ingest([JSON.stringify({ type: 'agent-name', agentName: 'wt-pack-worker-02', sessionId: 's1' }), JSON.stringify(msg)].join('\n'), 's1', 'session')
  assert.equal(a.names.get('s1'), 'wt-pack-worker-02')
  assert.equal(a.names.get('s2'), undefined)
  assert.equal(a.recs.size, 1)
})

import { pickLimits, noteRateLimit, resetRateLimit, parseCountdown } from './usage.mjs'
test('WP-336 pickLimits: freshest source wins whole, age and staleness reported', () => {
  const now = Date.parse('2026-10-11T12:00:00Z')
  const file = { session: 3, sessionResetAt: null, weekly: 9, weeklyResetAt: null, ageSec: 16 * 3600 }
  const pane = { session: { pct: 5, reset: '1h30m' }, weekly: { pct: 20, reset: '3d 2hr 0m' }, at: now - 120_000 }
  resetRateLimit()
  let l = pickLimits(file, pane, now)
  assert.deepEqual([l.source, l.weekly, l.ageSec, l.stale], ['pane', 20, 120, false])
  assert.equal(l.sessionResetAt, '2026-10-11T13:30:00.000Z')
  noteRateLimit({ type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.05, resetsAt: 1791720600 }, seven_day: { utilization: 0.16, resetsAt: 1792188000 } } } }, now - 10_000)
  l = pickLimits(file, pane, now)
  assert.deepEqual([l.source, l.session, l.weekly, l.ageSec], ['headless', 5, 16, 10])
  resetRateLimit()
  l = pickLimits(file, null, now)
  assert.deepEqual([l.source, l.stale], ['file', true])
  assert.equal(pickLimits(null, null, now), null)
  assert.equal(pickLimits(file, { ...pane, at: now - 31 * 60_000 }, now).stale, true)
})
test('parseCountdown', () => {
  assert.equal(parseCountdown('4h57m'), (4 * 60 + 57) * 60_000)
  assert.equal(parseCountdown('3d 15hr 7m'), ((3 * 24 + 15) * 60 + 7) * 60_000)
  assert.equal(parseCountdown('soon'), null)
})
