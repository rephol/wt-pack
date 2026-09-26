import test from 'node:test'
import assert from 'node:assert/strict'
import { agentsByProject, recentRooms, tileCounts } from './overviewData.ts'

test('agentsByProject: per-project state counts, busiest first, null → other', () => {
  const g = agentsByProject([
    { project: 'wt-pack', status: 'idle' },
    { project: 'umkmall', status: 'working' },
    { project: 'umkmall', status: 'working' },
    { project: 'umkmall', status: 'blocked' },
    { project: null, status: 'done' },
  ])
  assert.deepEqual(g, [
    { project: 'umkmall', working: 2, idle: 0, blocked: 1 },
    { project: 'other', working: 0, idle: 0, blocked: 0 },
    { project: 'wt-pack', working: 0, idle: 1, blocked: 0 },
  ])
})

test('recentRooms: newest first, skips silent and archived', () => {
  const r = recentRooms([
    { slug: 'a', lastAt: '2026-09-26T01:00:00Z' },
    { slug: 'b', lastAt: null },
    { slug: 'c', lastAt: '2026-09-26T03:00:00Z' },
    { slug: 'd', lastAt: '2026-09-26T04:00:00Z', archived: true },
  ])
  assert.deepEqual(r.map((x) => x.slug), ['c', 'a'])
})

test('tileCounts: only my tasks, like Tasks → Mine', () => {
  const t = (state: string, mine?: boolean) => ({ state, mine })
  assert.deepEqual(tileCounts([t('in_review', true), t('in_review', false), t('in_review'), t('needs_you'), t('stalled', false)]),
    { needsYou: 1, stalled: 0, inReview: 2 })
})
