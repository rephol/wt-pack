import test from 'node:test'
import assert from 'node:assert/strict'
import { parseBlock, ccBlock, ccPending, resetCcBlock, findCcusage } from './ccusage.mjs'

const block = { isActive: true, isGap: false, startTime: '2026-10-04T07:00:00.000Z', endTime: '2026-10-04T12:00:00.000Z', totalTokens: 5140912, costUSD: 1.15,
  burnRate: { tokensPerMinute: 515701.9, costPerHour: 6.95 }, projection: { totalTokens: 138707706, totalCost: 31.15, remainingMinutes: 259 }, models: ['claude-opus-5-5'], secret: 'x' }

test('parseBlock: the active block\'s named fields only; nothing active, a gap or garbage → null', () => {
  const b = parseBlock(JSON.stringify({ blocks: [{ ...block, isActive: false }, block] }))
  assert.equal(b.tokens, 5140912)
  assert.equal(b.projCost, 31.15)
  assert.equal(b.remainingMinutes, 259)
  assert.equal(b.secret, undefined)
  assert.equal(parseBlock(JSON.stringify({ blocks: [{ ...block, isGap: true }] })), null)
  assert.equal(parseBlock(JSON.stringify({ blocks: [] })), null)
  assert.equal(parseBlock('not json'), null)
})

test('ccBlock: never waits — null until the read lands, then cached 60 s; a failure is not retried for 10 min', async () => {
  resetCcBlock()
  let n = 0
  const ok = async () => (n++, parseBlock(JSON.stringify({ blocks: [block] })))
  const t = Date.now()
  assert.equal(ccBlock(t, ok), null)
  assert.equal(ccBlock(t, ok), null)
  await ccPending()
  assert.equal(n, 1)
  assert.equal(ccBlock(t + 30_000, ok).tokens, 5140912)
  assert.equal(ccPending(), null)
  resetCcBlock()
  const bad = async () => (n++, null)
  ccBlock(t, bad); await ccPending()
  assert.equal(ccBlock(t + 5 * 60_000, bad), null)
  assert.equal(n, 2)
  resetCcBlock()
})

test('findCcusage: first executable in the dirs, else null', () => {
  assert.equal(findCcusage(['/nonexistent']), null)
  assert.equal(findCcusage(['', '/nonexistent', '/bin'].map((d) => d && d)), null)
})
