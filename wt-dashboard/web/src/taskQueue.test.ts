import test from 'node:test'
import assert from 'node:assert/strict'
import { sections, type QTask } from './taskQueue.ts'

const now = Date.parse('2026-09-26T12:00:00Z')
const t = (id: string, state: string, daysAgo = 0): QTask => ({ id, title: id, url: null, state, agent: null, project: null, question: null, plan: null, pr: null,
  updatedAt: new Date(now - daysAgo * 86400_000).toISOString() })

test('sections: fixed order, empty hidden, shipped only within 7 days', () => {
  const s = sections([t('a', 'up_next'), t('b', 'needs_you'), t('c', 'shipped', 2), t('d', 'merged', 1), t('e', 'shipped', 8), t('f', 'building'), t('g', 'queued')], now)
  assert.deepEqual(s.map((x) => [x.key, x.tasks.map((y) => y.id)]), [['needs_you', ['b']], ['up_next', ['a']], ['shipped', ['d', 'c']]])
  assert.deepEqual(sections([t('f', 'building')], now), [])
})
