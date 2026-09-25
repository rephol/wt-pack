import test from 'node:test'
import assert from 'node:assert/strict'
import { gate, collapseRepeats, shortAgo, DEFAULT_PREFS, type InboxItem, type Kind } from './notifyGate.ts'

test('gate: per-kind native/inbox toggles, quiet items, open-panel suppression, dedupe, 30s per-target rate limit', () => {
  const st = (over = {}) => ({ prefs: structuredClone(DEFAULT_PREFS), focused: false, openKey: null, seen: new Set<string>(), lastAt: new Map<string, number>(), now: 0, ...over })
  const e = (kind: Kind, key: string, extra: Partial<InboxItem> = {}): InboxItem => ({ id: key, ts: '', kind, key, title: 't', body: 'b', read: false, resolvedAt: null, target: { agent: 'a' }, ...extra })
  const noNative = st(); noNative.prefs.native['agent-done'] = false
  assert.equal(gate(e('agent-done', 'd'), noNative), false) // native off (inbox may stay on)
  const noInbox = st(); noInbox.prefs.inbox['agent-done'] = false
  assert.equal(gate(e('agent-done', 'd'), noInbox), false) // hidden kinds never pop either
  assert.equal(gate(e('question', 'q', { quiet: true }), st()), false)
  assert.equal(gate(e('room-suggestion', 's'), st()), false) // off natively by default
  assert.equal(gate(e('agent-done', 'd'), st({ focused: true, openKey: 'a' })), false)
  assert.equal(gate(e('agent-done', 'd'), st({ focused: false, openKey: 'a' })), true)
  const s = st()
  assert.equal(gate(e('question', 'n1'), s), true)
  assert.equal(gate(e('question', 'n1'), { ...s, now: 60_000 }), false)
  assert.equal(gate(e('agent-done', 'd1'), { ...s, now: 10_000 }), false)
  assert.equal(gate(e('agent-done', 'd1'), { ...s, now: 31_000 }), true)
})

test('collapseRepeats: repeated done events fold into one row with a count; actionable items never fold', () => {
  const it = (id: string, kind: Kind, title: string, read = false): InboxItem => ({ id, ts: '', kind, key: id, title, body: '', read, resolvedAt: null, target: {} })
  const rows = collapseRepeats([it('1', 'agent-done', 'a is done'), it('2', 'question', 'q'), it('3', 'agent-done', 'a is done', true), it('4', 'question', 'q'), it('5', 'agent-done', 'b is done')])
  assert.deepEqual(rows.map((r) => [r.id, r.count, r.ids]), [['1', 2, ['1', '3']], ['2', 1, ['2']], ['4', 1, ['4']], ['5', 1, ['5']]])
  assert.equal(rows[0].anyUnread, true)
  assert.equal(shortAgo(new Date(0).toISOString(), 30_000), 'now')
  assert.equal(shortAgo(new Date(0).toISOString(), 600_000), '10m')
})
