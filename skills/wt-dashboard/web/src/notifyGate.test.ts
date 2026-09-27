import test from 'node:test'
import assert from 'node:assert/strict'
import { gate, collapseRepeats, shortAgo, DEFAULT_PREFS, type InboxItem, type Kind } from './notifyGate.ts'

test('gate: per-kind native/inbox toggles, quiet items, open-panel suppression, dedupe, 30s per-target rate limit', () => {
  const st = (over = {}) => ({ prefs: structuredClone(DEFAULT_PREFS), focused: false, openKeys: [] as string[], seen: new Set<string>(), lastAt: new Map<string, number>(), now: 0, ...over })
  const e = (kind: Kind, key: string, extra: Partial<InboxItem> = {}): InboxItem => ({ id: key, ts: '', kind, key, title: 't', body: 'b', read: false, resolvedAt: null, target: { agent: 'a' }, ...extra })
  const noNative = st(); noNative.prefs.native['agent-done'] = false
  assert.equal(gate(e('agent-done', 'd'), noNative), false) // native off (inbox may stay on)
  const noInbox = st(); noInbox.prefs.inbox['agent-done'] = false
  assert.equal(gate(e('agent-done', 'd'), noInbox), false) // hidden kinds never pop either
  assert.equal(gate(e('question', 'q', { quiet: true }), st()), false)
  assert.equal(gate(e('room-suggestion', 's'), st()), false) // off natively by default
  assert.equal(gate(e('agent-done', 'd'), st({ focused: true, openKeys: ['a'] })), false)
  assert.equal(gate(e('agent-done', 'd'), st({ focused: false, openKeys: ['a'] })), true)
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

test('groupInbox: by agent / room / task / memory, first-seen order, singles stay one-row groups', async () => {
  const { groupInbox } = await import('./notifyGate.ts')
  const r = (id: string, kind: Kind, title: string, target: InboxItem['target'], read = false) =>
    ({ id, ts: '2026-09-26T00:00:00Z', kind, key: id, title, body: '', read, resolvedAt: null, target, ids: [id], count: 1, anyUnread: !read })
  const g = groupInbox([
    r('1', 'agent-done', 'w-02 (p) is done', { agent: 'm/p2' }),
    r('2', 'memory', 'w-02 remembered', { agent: 'm/p2', memory: 'x' }),
    r('3', 'agent-stalled', 'w-02 (p) stalled', { agent: 'm/p2' }, true),
    r('4', 'room-created', 'New room', { room: 'wt-pack' }),
    r('5', 'ci-failed', 'CI failed', { task: 'ACM-1', pr: '#3' }),
    r('6', 'agent-done', 'w-01 (p) is done', { agent: 'm/p1' }),
  ])
  assert.deepEqual(g.map((x) => [x.key, x.label, x.rows.map((y) => y.id), x.unread]), [
    ['agent:m/p2', 'w-02', ['1', '3'], 1], ['memory', 'Memory', ['2'], 1], ['room:wt-pack', '#wt-pack', ['4'], 1], ['task:ACM-1', 'ACM-1', ['5'], 1], ['agent:m/p1', 'w-01', ['6'], 1],
  ])
})

test('groupInbox: groups sort by their most urgent row (absent = 1), stable otherwise', async () => {
  const { groupInbox } = await import('./notifyGate.ts')
  const r = (id: string, target: InboxItem['target'], urgency?: number) =>
    ({ id, ts: '2026-09-26T00:00:00Z', kind: 'agent-done' as Kind, key: id, title: `${id} x`, body: '', read: false, resolvedAt: null, target, ids: [id], count: 1, anyUnread: true, urgency })
  const keys = (rows: ReturnType<typeof r>[]) => groupInbox(rows).map((g) => g.key)
  assert.deepEqual(keys([r('1', { agent: 'a' }), r('2', { agent: 'b' }), r('3', { agent: 'c' })]), ['agent:a', 'agent:b', 'agent:c'])
  assert.deepEqual(keys([r('1', { agent: 'a' }, 0), r('2', { agent: 'b' }), r('3', { agent: 'c' }, 3)]), ['agent:c', 'agent:b', 'agent:a'])
  assert.deepEqual(keys([r('1', { agent: 'a' }, 1), r('2', { agent: 'b' }, 0), r('3', { agent: 'b' }, 2)]), ['agent:b', 'agent:a'])
})

test('needsYou: unresolved actionable items only — FYIs and resolved questions do not count', async () => {
  const { needsYou } = await import('./notifyGate.ts')
  const e = (kind: Kind, resolvedAt: string | null = null): InboxItem => ({ id: kind, ts: '', kind, key: kind, title: 't', body: 'b', read: false, resolvedAt, target: {} })
  const items = [e('agent-done'), e('agent-done'), e('agent-done'), e('server'), e('question'), e('question', '2026-01-01'), e('room-suggestion')]
  assert.equal(items.filter(needsYou).length, 2)
})

test('ACTIONABLE_KINDS matches the server inbox ACTIONABLE set', async () => {
  const { ACTIONABLE_KINDS } = await import('./notifyGate.ts')
  const { ACTIONABLE } = await import('../../inbox.mjs')
  assert.deepEqual([...ACTIONABLE_KINDS].sort(), [...ACTIONABLE].sort())
})
