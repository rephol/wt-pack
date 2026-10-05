import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memStats } from './memstats.mjs'

const now = Date.parse('2026-10-05T12:00:00Z')
const e = (id, scope, by, at, extra = {}) => ({ id, scope, name: scope === 'global' ? null : 'x', by, at, text: `t-${id}`, ...extra })
const entries = [e('aaaaaa', 'project', 'w1', '2026-10-05'), e('bbbbbb', 'role', 'w1', '2026-10-05'), e('cccccc', 'global', 'o1', '2026-10-01'),
  e('dddddd', 'project', 'o1', '2026-09-01'), e('eeeeee', 'global', 'o1', '2026-09-01', { pending: true })]
const log = [
  { at: '2026-10-05T01:00:00Z', session: 's', kind: 'inject', ids: [] },
  { at: '2026-10-05T02:00:00Z', session: 's', kind: 'recall', ids: ['aaaaaa', 'cccccc'] },
  { at: '2026-10-04T02:00:00Z', session: 's', kind: 'recall', ids: ['aaaaaa'] },
  { at: '2026-10-04T03:00:00Z', session: 's', kind: 'future-kind', ids: ['bbbbbb'] },
].map((l) => JSON.stringify(l)).join('\n') + '\nnot json\n{"at":"nope","kind":"inject"}\n'

test('zero-filled days, scope split, inject/recall counts; malformed and unknown lines skipped', () => {
  const s = memStats(entries, log, { days: 3, now })
  assert.deepEqual(s.days.map((d) => d.day), ['2026-10-03', '2026-10-04', '2026-10-05'])
  assert.deepEqual(s.days[0], { day: '2026-10-03', written: { global: 0, role: 0, project: 0 }, inject: 0, recall: 0 })
  assert.deepEqual(s.days[2], { day: '2026-10-05', written: { global: 0, role: 1, project: 1 }, inject: 1, recall: 1 })
  assert.equal(s.days[1].recall, 1)
  assert.equal(s.logPresent, true)
})
test('by-agent counts live entries written in the window, desc; pending counted separately', () => {
  const s = memStats(entries, log, { days: 30, now })
  assert.deepEqual(s.byAgent, [{ by: 'w1', count: 2 }, { by: 'o1', count: 1 }])
  assert.equal(s.pending, 1)
})
test('top orders by recalls; never excludes recalled, pending and entries younger than 7 days', () => {
  const s = memStats(entries, log, { now })
  assert.deepEqual(s.top.map((t) => [t.id, t.recalls]), [['aaaaaa', 2], ['cccccc', 1]])
  assert.deepEqual(s.never.map((t) => t.id), ['dddddd']) // bbbbbb is today's; eeeeee is pending
})
test('missing log → logPresent false, nothing recalled', () => {
  const s = memStats(entries, null, { days: 2, now })
  assert.equal(s.logPresent, false)
  assert.deepEqual(s.top, [])
  assert.deepEqual(s.never.map((t) => t.id), ['dddddd'])
})
