import test from 'node:test'
import assert from 'node:assert/strict'
import { headlessBadge, stateChip, canResume, askQuestions, askAnswerBody } from './headlessData.ts'

test('headlessBadge / stateChip / canResume', () => {
  assert.equal(headlessBadge('queued'), 'queued')
  assert.equal(headlessBadge('working'), 'headless')
  assert.equal(stateChip({ state: 'ended', reason: 'idle release' }), 'ended: idle release')
  assert.equal(stateChip({ state: 'working', reason: 'x' }), 'working')
  assert.equal(stateChip({ state: 'failed', reason: null }), 'failed')
  assert.deepEqual(['ended', 'failed', 'idle'].map(canResume), [true, true, false])
})

test('askAnswerBody: tool allow/deny, AskUserQuestion answers', () => {
  const tool = { id: 'a1', tool: 'Bash', input: { command: 'ls' }, created: 0 }
  assert.deepEqual(askAnswerBody(tool, true), { ask: 'a1', allow: true })
  assert.deepEqual(askAnswerBody(tool, false), { ask: 'a1', allow: false })
  const q = { id: 'a2', tool: 'AskUserQuestion', input: { questions: [{ question: 'Pick?', options: [{ label: 'A' }] }] }, created: 0 }
  assert.equal(askQuestions(q)[0].question, 'Pick?')
  assert.deepEqual(askQuestions(tool), [])
  assert.deepEqual(askAnswerBody(q, { question: 'Pick?', label: 'A' }), { ask: 'a2', answers: { 'Pick?': 'A' } })
})
