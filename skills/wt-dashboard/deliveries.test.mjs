// Run: node --test deliveries.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Deliveries, LIVE_MS } from './deliveries.mjs'

const mk = async () => { let t = 1_000_000; const d = new Deliveries({ dir: await mkdtemp(join(tmpdir(), 'deliv-')), now: () => t }); return [d, (ms) => { t += ms }] }
const msg = '<wt-message id=a kind=reply from="x">hi</wt-message>'

test('live only while hello is fresh', async () => {
  const [d, tick] = await mk()
  assert.equal(d.live('w1:p1'), false)
  d.hello('w1:p1')
  assert.equal(d.live('w1:p1'), true)
  assert.equal(d.live('w1:p2'), false)
  tick(LIVE_MS + 1)
  assert.equal(d.live('w1:p1'), false)
})

test('enqueue → next (own pane only) → ack once', async () => {
  const [d] = await mk()
  const r = d.enqueue('w1:p1', msg)
  assert.equal(r.kind, 'reply')
  assert.equal(d.next('w1:p2'), null)
  assert.equal(d.next('w1:p1').body, msg)
  assert.equal(d.next('w1:p1').id, r.id) // not claimed until acked
  assert.throws(() => d.ack(r.id, 'w1:p2'), (e) => e.status === 403)
  assert.equal(d.ack(r.id, 'w1:p1').status, 'delivered')
  assert.throws(() => d.ack(r.id, 'w1:p1'), (e) => e.status === 409)
  assert.equal(d.next('w1:p1'), null)
})

test('queue order is first in, first out; room traffic is kind=room', async () => {
  const [d] = await mk()
  d.enqueue('w1:p1', '<room-message id=1 room=x from=u kind=u>a</room-message>')
  d.enqueue('w1:p1', msg)
  const first = d.next('w1:p1')
  assert.equal(first.kind, 'room')
  d.ack(first.id, 'w1:p1')
  assert.equal(d.next('w1:p1').kind, 'reply')
})

test('stranded: queued rows whose mod went quiet, past the grace period', async () => {
  const [d, tick] = await mk()
  d.hello('w1:p1')
  const r = d.enqueue('w1:p1', msg)
  tick(LIVE_MS + 1)
  assert.deepEqual(d.stranded(), []) // server just started: hellos not yet trustworthy
  tick(10_000)
  assert.deepEqual(d.stranded().map((x) => x.id), [r.id])
  d.hello('w1:p1')
  assert.deepEqual(d.stranded(), []) // mod is back: it will pull it
  tick(LIVE_MS + 1)
  assert.equal(d.settle(r.id, 'pasted'), true)
  assert.equal(d.settle(r.id, 'pasted'), false) // already claimed
  assert.deepEqual(d.stranded(), [])
  assert.equal(d.list('w1:p1')[0].status, 'pasted')
})

test('enqueue rejects empty text', async () => {
  const [d] = await mk()
  assert.throws(() => d.enqueue('w1:p1', ' '), (e) => e.status === 400)
})

test('WP-258: queuedFor is true only while that envelope waits in that pane\'s queue', async () => {
  const [d] = await mk()
  const row = d.enqueue('w1:p1', msg)
  assert.equal(d.queuedFor('w1:p1', 'a'), true)
  assert.equal(d.queuedFor('w1:p2', 'a'), false); assert.equal(d.queuedFor('w1:p1', 'ab'), false)
  d.ack(row.id, 'w1:p1')
  assert.equal(d.queuedFor('w1:p1', 'a'), false)
})
