import test from 'node:test'
import assert from 'node:assert/strict'
import { matchBatch, isAnswered, toPayload, summary, emptyAnswer, OTHER, type BatchQuestion } from './pickerBatch.ts'

const q = (header: string, multiSelect = false): BatchQuestion => ({ header, question: `${header}?`, multiSelect, options: [{ label: 'a' }, { label: 'b' }] })
const tabs = (...h: string[]) => h.map((header) => ({ header }))

test('matchBatch: 2-4 matching tabs batch; single tab, review, or a header mismatch keep the per-tab flow', () => {
  for (const n of [2, 3, 4]) {
    const hs = Array.from({ length: n }, (_, i) => `H${i}`)
    assert.equal(matchBatch(tabs(...hs), false, hs.map((h) => q(h)))?.length, n)
  }
  assert.equal(matchBatch(tabs('A'), false, [q('A')]), null)
  assert.equal(matchBatch(tabs('A', 'B'), true, [q('A'), q('B')]), null)
  assert.equal(matchBatch(tabs('A', 'B'), false, [q('A'), q('X')]), null)
  assert.equal(matchBatch(tabs('A', 'B'), false, [q('A')]), null)
  assert.equal(matchBatch(tabs('A', 'B'), false, null), null)
})

test('answers: single, Other text, multi, and the bulk payload per tab', () => {
  const s = q('A'), m = q('B', true)
  assert.equal(isAnswered(s, emptyAnswer()), false)
  assert.equal(isAnswered(s, { ...emptyAnswer(), single: OTHER }), false)
  assert.equal(isAnswered(s, { ...emptyAnswer(), single: OTHER, other: 'x' }), true)
  assert.deepEqual(toPayload(s, { ...emptyAnswer(), single: 'a' }), { header: 'A', selected: ['a'], other: null })
  assert.deepEqual(toPayload(s, { single: OTHER, multi: [], other: 'x' }), { header: 'A', selected: [], other: 'x' })
  assert.equal(isAnswered(m, emptyAnswer()), false)
  assert.deepEqual(toPayload(m, { single: '', multi: ['a', 'b'], other: 'z' }), { header: 'B', selected: ['a', 'b'], other: 'z' })
  assert.equal(summary(m, { single: '', multi: ['a'], other: 'z' }), 'a, z')
})
