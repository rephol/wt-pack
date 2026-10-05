// Run: node --test messages.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Messages, parseEnvelope, envelopeOf, MAX_ATTEMPTS } from './messages.mjs'

async function setup() {
  const clock = { t: Date.parse('2026-01-01T00:00:00Z') }
  const m = new Messages({ dir: await mkdtemp(join(tmpdir(), 'messages-')), log: () => {}, now: () => clock.t })
  const draft = (o = {}) => ({ id: 'a1', sender: 'orch', target: 'w1:p1', kind: 'handoff', ticket: 'WP-1', body: 'hi', ...o })
  return { m, clock, draft }
}

test('parseEnvelope reads the wt-message tag, also behind a slash command', () => {
  assert.deepEqual(parseEnvelope('/goal <wt-message id=ab12 kind=dispatch from="wt-dashboard" ticket=WP-9>b</wt-message>'), { id: 'ab12', kind: 'dispatch', sender: 'wt-dashboard', ticket: 'WP-9' })
  assert.equal(parseEnvelope('plain text'), null)
})

test('state transitions: queued → delivered → acknowledged → answered; illegal moves are 409', async () => {
  const { m, draft } = await setup()
  m.record(draft())
  assert.equal(m.move('a1', 'delivered').state, 'delivered')
  assert.equal(m.ack('a1', 'w1:p1').state, 'acknowledged')
  assert.equal(m.ack('a1', 'w1:p1').state, 'acknowledged') // idempotent
  assert.equal(m.ack('a1', 'w1:p1', 'answered').state, 'answered')
  assert.throws(() => m.move('a1', 'queued'), { status: 409 })
  assert.throws(() => m.ack('a1', 'w9:p9'), { status: 403 })
  assert.throws(() => m.ack('nope', null), { status: 404 })
})

test('an ack on a queued message proves delivery', async () => {
  const { m, draft } = await setup()
  m.record(draft())
  const r = m.ack('a1', 'w1:p1')
  assert.equal(r.state, 'acknowledged')
  assert.ok(r.delivered_at && r.acked_at)
})

test('recording the same request_id (or id) twice returns the first row and changes nothing', async () => {
  const { m, draft } = await setup()
  m.record(draft({ requestId: 'req-1', body: 'first' }))
  const again = m.record(draft({ id: 'b2', requestId: 'req-1', body: 'second' }))
  assert.equal(again.duplicate, true)
  assert.equal(again.row.id, 'a1')
  assert.equal(m.list().length, 1)
  assert.equal(m.record(draft({ body: 'third' })).row.body, 'first')
})

test('expiry: resend with the same id, then flag once attempts run out', async () => {
  const { m, clock, draft } = await setup()
  m.record(draft({ state: 'delivered', requestId: 'req-1' }))
  m.record(draft({ id: 'r1', kind: 'reply', requestId: 'req-2', state: 'delivered' })) // a reply expects no ack
  const sent = [], flagged = []
  const deps = { resend: async (row) => sent.push(row.id), flag: (row) => flagged.push(row.id) }
  assert.deepEqual(await m.sweep(deps), []) // not due yet
  for (let i = 1; i < MAX_ATTEMPTS; i++) {
    clock.t += 6 * 60_000
    assert.deepEqual(await m.sweep(deps), [{ id: 'a1', did: 'resent' }])
  }
  assert.deepEqual(sent, ['a1', 'a1']) // same envelope id every time
  assert.equal(m.get('a1').attempts, MAX_ATTEMPTS)
  clock.t += 6 * 60_000
  assert.deepEqual(await m.sweep(deps), [{ id: 'a1', did: 'expired' }])
  assert.equal(m.get('a1').state, 'expired')
  assert.deepEqual(flagged, ['a1'])
  assert.deepEqual(await m.sweep(deps), []) // flagged once
  assert.equal(m.get('r1').state, 'delivered')
})

test('expiry: a target that is demonstrably working counts as an ack; a failed resend is retried later', async () => {
  const { m, clock, draft } = await setup()
  m.record(draft({ state: 'delivered' }))
  clock.t += 6 * 60_000
  assert.deepEqual(await m.sweep({ seen: () => true, resend: async () => { throw new Error('x') } }), [{ id: 'a1', did: 'acknowledged' }])
  m.record(draft({ id: 'c3', state: 'delivered' }))
  clock.t += 6 * 60_000
  assert.deepEqual(await m.sweep({ resend: async () => { throw new Error('pane gone') } }), [{ id: 'c3', did: 'resend-failed' }])
  assert.equal(m.get('c3').error, 'pane gone')
})

test('byTicket gives the newest message and the open count', async () => {
  const { m, clock, draft } = await setup()
  m.record(draft({ state: 'delivered' }))
  clock.t += 1000
  m.record(draft({ id: 'a2', state: 'delivered' }))
  m.ack('a1', null)
  const r = m.byTicket(['WP-1', 'WP-2'])
  assert.equal(r['WP-1'].last.id, 'a2')
  assert.equal(r['WP-1'].open, 1)
  assert.equal(r['WP-2'], undefined)
})

test('envelopeOf also reads a room delivery, but not its context tag', () => {
  assert.deepEqual(envelopeOf('<room-message id=r9 room=wt-pack from="Rep" kind=mention>x</room-message>'), { id: 'r9', kind: 'room', sender: 'Rep', ticket: null })
  assert.equal(envelopeOf('<room-message id=r9 room=wt-pack from="dashboard" kind=context since=3>x</room-message>'), null)
})

test('WP-258: a message still waiting in the target\'s queue is neither resent, counted nor flagged', async () => {
  const { m, clock, draft } = await setup()
  m.record(draft({ id: 'q1', state: 'queued' })); const at0 = m.get('q1').attempts
  let waiting = true; const sent = []
  const deps = { pending: () => waiting, resend: async (r) => { sent.push(r.id) }, flag: () => assert.fail('flagged') }
  for (let i = 0; i < 5; i++) { clock.t += 6 * 60_000; assert.deepEqual(await m.sweep(deps), []) } // a long turn: 30 min
  assert.deepEqual(sent, []); assert.equal(m.get('q1').attempts, at0); assert.equal(m.get('q1').state, 'queued')
  waiting = false // the queue was pasted away (mod went quiet): the normal expiry takes over
  assert.deepEqual(await m.sweep(deps), [{ id: 'q1', did: 'resent' }])
})
