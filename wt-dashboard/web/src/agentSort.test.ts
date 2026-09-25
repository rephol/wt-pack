import test from 'node:test'
import assert from 'node:assert/strict'
import { sortAgents, initialSort } from './agentSort.ts'

const a = (name: string, status: 'working' | 'idle' | 'blocked' | 'done', extra = {}) => ({ name, status, asks: false, statusSince: 0, ...extra })
const L = [a('planner-10', 'idle', { lastActivity: 50 }), a('planner-02', 'working', { lastActivity: 10 }), a('planner-3', 'idle', { asks: true, statusSince: 99 }), a('planner-1', 'done', { lastActivity: 70 })]
const names = (x: { name: string }[]) => x.map((y) => y.name)

test('sortAgents: attention, activity (fallback statusSince), natural name', () => {
  assert.deepEqual(names(sortAgents(L, 'attention')), ['planner-3', 'planner-02', 'planner-10', 'planner-1'])
  assert.deepEqual(names(sortAgents(L, 'activity')), ['planner-3', 'planner-1', 'planner-10', 'planner-02'])
  assert.deepEqual(names(sortAgents(L, 'name')), ['planner-1', 'planner-02', 'planner-3', 'planner-10'])
})

test('initialSort: ?sort= over storage, invalid ignored', () => {
  assert.equal(initialSort('?sort=name', 'activity'), 'name')
  assert.equal(initialSort('?sort=bogus', 'activity'), 'activity')
  assert.equal(initialSort('', null), 'attention')
})
