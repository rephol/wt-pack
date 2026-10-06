// WP-271: the grouped phone notification's summary (web/public/push-summary.js, shared with sw.js).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
// a classic script (sw.js importScripts it): run it with a fake worker global
const self = {}
vm.runInNewContext(readFileSync(new URL('./web/public/push-summary.js', import.meta.url), 'utf8'), { self })
const { pushSummary } = self

const done = (t) => ({ title: t, body: 'b', cat: 'agents', kind: 'agent-done', url: '/#inbox' })
test('the first item of a category is shown as itself', () => {
  const s = pushSummary(null, done('a is done'))
  assert.deepEqual([s.title, s.body, s.data.url, s.data.n], ['a is done', 'b', '/#inbox', 1])
})
test('a repeat becomes "N agents done" with the newest names, opening the category in the Inbox', () => {
  let s = pushSummary(null, done('a is done'))
  for (const n of ['b', 'c', 'd']) s = pushSummary(s.data, done(`${n} is done`))
  assert.deepEqual([s.title, s.body, s.data.url, s.data.n], ['4 agents done', 'd is done\nc is done\nb is done', '/#inbox/agents', 4])
})
test('mixed kinds fall back to the category label; needs-you reads "N need you"', () => {
  let s = pushSummary(pushSummary(null, done('a')).data, { ...done('x'), kind: 'ci-failed' })
  assert.equal(s.title, '2 agent updates')
  const q = { title: 'q', cat: 'needs-you', kind: 'question', url: '/#inbox' }
  assert.equal(pushSummary(pushSummary(null, q).data, q).title, '2 need you')
  assert.equal(pushSummary({ n: 1, kinds: ['server'], names: ['s'] }, { title: 't', cat: 'system', kind: 'usage' }).title, '2 system alerts')
})
test('a payload without a category (the test push) is never grouped', () => {
  const s = pushSummary({ n: 5 }, { title: 'wt-dashboard', body: 'ok', url: '/#inbox' })
  assert.deepEqual([s.title, s.body, s.data.n], ['wt-dashboard', 'ok', 1])
})
