import test from 'node:test'
import assert from 'node:assert/strict'
import { deriveMeta, toolGroupMeta, callDurations, shortModel, fmtTokens, fmtWhen, type TMsg } from './turns.ts'

const u = (mid: string, out: number, extra = {}) => ({ mid, model: 'claude-opus-5-5', in: 10, out, cw: 0, cr: 1000, cost: 0.01, stop: 'end_turn', ...extra })
// Two turns: a dashboard prompt → text, a tool call, final text (one API message repeated across entries);
// then a terminal prompt that gets interrupted.
const fixture: TMsg[] = [
  { id: 'u1', role: 'user', text: 'do it', ts: '2026-09-25T10:00:00Z', src: 'dashboard', images: ['data:x'] },
  { id: 'a1', role: 'assistant', text: 'on it', ts: '2026-09-25T10:00:05Z', meta: u('m1', 50) },
  { id: 't1', role: 'tool', text: '', ts: '2026-09-25T10:00:06Z', toolUseId: 'x', tool: { name: 'Bash' }, meta: u('m1', 80) },
  { id: 't1r', role: 'tool', text: 'ok', ts: '2026-09-25T10:00:16Z', toolUseId: 'x', tool: { name: 'result' } },
  { id: 'a2', role: 'assistant', text: 'done', ts: '2026-09-25T10:01:00Z', meta: u('m2', 900) },
  { id: 'u2', role: 'user', text: 'again', ts: '2026-09-25T10:02:00Z', src: 'terminal' },
  { id: 'a3', role: 'assistant', text: 'start', ts: '2026-09-25T10:02:03Z', meta: u('m3', 5, { model: '<synthetic>', cost: null }) },
  { id: 'i', role: 'user', text: '[Request interrupted by user]', ts: '2026-09-25T10:02:09Z' },
]

test('deriveMeta: groups by user turn, meta on the last assistant message, usage deduped per API message', () => {
  const m = deriveMeta(fixture)
  assert.deepEqual(m.get('u1'), { kind: 'user', ts: '2026-09-25T10:00:00Z', src: 'dashboard', attachments: 1 })
  assert.equal(m.get('a1')?.kind, 'plain')
  const t = m.get('a2')
  assert.ok(t?.kind === 'turn')
  assert.equal(t.model, 'claude-opus-5-5')
  assert.equal(t.down, 80 + 900) // m1 counted once, at its last value
  assert.equal(t.up, 2 * 1010)
  assert.deepEqual([t.cr, t.cw, t.fresh], [2000, 0, 20])
  assert.equal(t.ms, 60_000)
  assert.equal(t.tools, 1)
  assert.equal(t.cost, 0.02)
  assert.equal(t.stop, undefined)
  const t2 = m.get('a3')
  assert.ok(t2?.kind === 'turn')
  assert.equal(t2.stop, 'interrupted')
  assert.equal(t2.model, undefined) // <synthetic> is not a model
  assert.equal(t2.cost, null)
  assert.equal(t2.ms, 9000) // to the interrupt, the turn's last entry
  assert.equal(m.get('i')?.kind, 'plain') // the interrupt marker keeps a time, and does not open a turn
})

test('tool groups and call durations', () => {
  const g = fixture.slice(2, 4)
  assert.deepEqual(toolGroupMeta(g), { calls: 1, ms: 10_000 })
  assert.equal(callDurations(g).get('x'), 10_000)
})

test('formatting', () => {
  assert.equal(shortModel('claude-opus-5-5'), 'Opus 5.5')
  assert.equal(shortModel('claude-sonnet-4-6-20250101'), 'Sonnet 4.6')
  assert.equal(shortModel('claude-opus-5'), 'Opus 5')
  assert.equal(shortModel('claude-opus-5-5[1m]'), 'Opus 5.5')
  assert.equal(fmtTokens(12_400), '12k')
  assert.equal(fmtTokens(1_400), '1.4k')
  const now = Date.parse('2026-09-25T12:00:00')
  assert.equal(fmtWhen(new Date(now - 120_000).toISOString(), now), '2m')
  assert.match(fmtWhen(new Date(now - 2 * 3_600_000).toISOString(), now), /^10:00$/)
  assert.doesNotMatch(fmtWhen('2026-09-20T09:00:00', now), /:/)
})

import { contextUsage } from './turns.ts'
test('contextUsage: latest call in + cache read + cache write over 200k, or 1M once past 200k / for [1m]', () => {
  const u = (model: string, i: number, cr: number, cw: number) => ({ id: String(i + cr), role: 'assistant', text: '', ts: '', meta: { mid: 'm', model, in: i, out: 5, cw, cr, cost: null, stop: null } })
  assert.equal(contextUsage([]), null)
  assert.deepEqual(contextUsage([u('claude-sonnet-5', 1000, 40_000, 9000)]), { used: 50_000, window: 200_000, pct: 25 })
  assert.deepEqual(contextUsage([u('claude-opus-5-5[1m]', 0, 100_000, 0)]), { used: 100_000, window: 1_000_000, pct: 10 })
  assert.deepEqual(contextUsage([u('claude-opus-5-5', 0, 300_000, 0), u('claude-opus-5-5', 0, 20_000, 0)]), { used: 20_000, window: 1_000_000, pct: 2 })
})
