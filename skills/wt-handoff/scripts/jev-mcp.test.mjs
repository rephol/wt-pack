// node --test: the Noul question per catalog server, and the confidence cut.
import test from 'node:test'
import assert from 'node:assert/strict'
import { questions, picksFrom } from './jev-mcp.mjs'

test('one noul question per known catalog server; unknown names are never asked', () => {
  const q = questions(['figma', 'railway', 'mystery'])
  assert.deepEqual(Object.keys(q), ['figma', 'railway'])
  assert.equal(q.figma.type, 'noul')
})
test('picks are the answers at or above the threshold, probabilities rounded', () => {
  const r = picksFrom({ figma: { noul: 0.951 }, railway: { noul: 0.69 }, context7: { noul: 0.7 } }, 0.7)
  assert.deepEqual(r.picks, ['figma', 'context7'])
  assert.deepEqual(r.p, { figma: 0.95, railway: 0.69, context7: 0.7 })
  assert.deepEqual(picksFrom(undefined, 0.7), { picks: [], p: {} })
})
