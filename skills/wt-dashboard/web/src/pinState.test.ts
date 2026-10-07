import test from 'node:test'
import assert from 'node:assert/strict'
import { agentChat, groupSaved, oneLine, requestJump, roomChat, takeJump, type Saved } from './pinState.ts'

test('chat keys: a room by slug, an agent by session id; remote or session-less agents have none', () => {
  assert.deepEqual(roomChat('ops'), { chat: 'room:ops', label: '#ops', open: 'rooms/ops' })
  assert.deepEqual(agentChat({ key: 'local/w1:p3', name: 'worker', session: 'abc-123', local: true }), { chat: 'agent:abc-123', label: 'worker', open: 'agents/local/w1%3Ap3' })
  assert.equal(agentChat({ key: 'local/w1:p3', name: 'w', session: null, local: true }), null)
  assert.equal(agentChat({ key: 'mac2/p1', name: 'w', session: 'abc', local: false }), null)
})

test('saved rows group by chat, in order of each chat\'s newest bookmark', () => {
  const r = (chat: string, msg: string): Saved => ({ chat, msg, author: 'a', text: 't', label: chat, open: '', at: '' })
  const g = groupSaved([r('room:b', '3'), r('room:a', '2'), r('room:b', '1')])
  assert.deepEqual(g.map((x) => [x.chat, x.rows.map((y) => y.msg)]), [['room:b', ['3', '1']], ['room:a', ['2']]])
})

test('a jump is for one chat, taken once, and expires', () => {
  requestJump('room:a', 'm1', 1000)
  assert.equal(takeJump('room:b', 1100), null)
  assert.equal(takeJump('room:a', 1100), 'm1')
  assert.equal(takeJump('room:a', 1100), null)
  requestJump('room:a', 'm2', 1000)
  assert.equal(takeJump('room:a', 20000), null)
})

test('oneLine flattens whitespace and clips', () => {
  assert.equal(oneLine('a\n\n  b'), 'a b')
  assert.equal(oneLine('x'.repeat(200), 10), `${'x'.repeat(10)}…`)
})
