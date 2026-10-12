import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agentActions } from './agentActions.ts'

const a = (status: string, over: Partial<{ local: boolean; id: string | null; headless: boolean }> = {}) => ({ local: true, status, id: 'w1:p1' as string | null, ...over })

test('live pane: Pause and Remove', () => { for (const s of ['idle', 'working', 'blocked', 'done', 'unknown']) assert.deepEqual(agentActions(a(s)), ['pause', 'remove']) })
test('paused: Resume and Forget with confirm, no Remove', () => assert.deepEqual(agentActions(a('paused', { id: null })), ['resume', 'forget-confirm']))
test('missing and exited: Respawn and Forget, no Remove', () => { for (const s of ['missing', 'exited']) assert.deepEqual(agentActions(a(s, { id: null })), ['respawn', 'forget']) })
test('headless: Stop only, and only when stoppable', () => {
  assert.deepEqual(agentActions(a('working', { headless: true }), { canStop: true }), ['stop'])
  assert.deepEqual(agentActions(a('idle', { headless: true })), [])
})
test('remote: Remove is the disabled remote item', () => assert.deepEqual(agentActions(a('idle', { local: false })), ['remove-remote']))
test('no state without an id ever gets Remove', () => {
  for (const s of ['idle', 'working', 'paused', 'missing', 'exited', 'blocked', 'done', 'unknown'])
    for (const headless of [false, true]) assert.ok(!agentActions(a(s, { id: null, headless }), { canStop: true }).includes('remove'), s)
})
