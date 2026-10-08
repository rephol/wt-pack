// Run: node --test messages.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Messages, parseEnvelope, envelopeOf, movedOn, MAX_ATTEMPTS, NUDGE_MS, nudgeText, nudgeEligible } from './messages.mjs'

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

test('WP-260: a dispatch whose card moved on (done/blocked, or moved by another than dispatch after delivery) is acknowledged, never resent', async () => {
  const row = { created: '2026-10-05T16:26:00.000Z', delivered_at: '2026-10-05T16:26:56.000Z' }
  const card = (column, ...hist) => ({ column, history: hist.map(([at, author, kind = 'move']) => ({ at, author, kind })) })
  assert.equal(movedOn(null, row), false)
  assert.equal(movedOn(card('ready'), row), false) // still where it was sent
  assert.equal(movedOn(card('done'), row), true); assert.equal(movedOn(card('blocked'), row), true); assert.equal(movedOn(card('cancelled'), row), true)
  assert.equal(movedOn(card('building', ['2026-10-05T16:33:29.000Z', 'wt-pack-worker-04']), row), true) // the target took it
  assert.equal(movedOn(card('building', ['2026-10-05T16:26:10.000Z', 'dispatch']), row), false) // dispatch's own move does not count
  assert.equal(movedOn(card('ready', ['2026-10-05T16:20:00.000Z', 'user']), row), false) // a move before delivery
  assert.equal(movedOn(card('ready', ['2026-10-05T16:40:00.000Z', 'user', 'comment']), row), false) // a comment is not a move
  // the live case: delivered, never acked, card went building → review → done; the sweep acknowledges instead of resending
  const { m, clock, draft } = await setup()
  m.record(draft({ id: 'ab75', state: 'delivered' }))
  clock.t += 6 * 60_000
  const sent = []
  assert.deepEqual(await m.sweep({ seen: () => movedOn(card('review', ['2026-10-05T16:31:00.000Z', 'w']), { ...m.get('ab75'), delivered_at: '2026-10-05T16:00:00.000Z' }), resend: async (r) => sent.push(r.id) }), [{ id: 'ab75', did: 'acknowledged' }])
  assert.deepEqual(sent, []); assert.equal(m.get('ab75').state, 'acknowledged')
})

test('WP-261: an acknowledged handoff whose agent went idle or vanished without moving the card is flagged once', async () => {
  const { m, clock, draft } = await setup()
  const flagged = []
  const run = (o = {}) => m.unreported({ moved: () => false, busy: () => false, flag: (r) => flagged.push(r.id), ...o })
  m.record(draft({ state: 'delivered' })); m.ack('a1', null)
  assert.deepEqual(await run(), []) // not due yet: acked just now
  clock.t += 9 * 60_000
  assert.deepEqual(await run(), [])
  clock.t += 2 * 60_000 // 11 min after the ack
  assert.deepEqual(await run({ busy: () => true }), []) // the target is still working on it
  assert.deepEqual(await run({ moved: () => true }), []) // the card moved on: it reported by moving it
  assert.deepEqual(await run({ moved: () => Promise.reject(new Error('board down')) }), []) // an error never flags
  assert.equal(m.get('a1').state, 'acknowledged')
  assert.deepEqual(await run(), [{ id: 'a1', did: 'unreported' }]) // idle (or absent from the agent list) and not moved
  assert.deepEqual(flagged, ['a1']); assert.equal(m.get('a1').state, 'expired'); assert.equal(m.get('a1').error, 'agent finished without reporting')
  assert.deepEqual(await run(), []) // flagged once: it left `acknowledged`
  assert.deepEqual(m.byTicket(['WP-1'])['WP-1'].open, 1) // the board badge still counts it as open
})

test('WP-261: ticketless, answered and non-ack kinds are never flagged as unreported', async () => {
  const { m, clock, draft } = await setup()
  m.record(draft({ id: 't1', ticket: null, state: 'delivered' })); m.ack('t1', null)
  m.record(draft({ id: 'r1', kind: 'reply', state: 'delivered' })); m.ack('r1', null)
  m.record(draft({ id: 'd1', state: 'delivered' })); m.ack('d1', null, 'answered')
  clock.t += 60 * 60_000
  assert.deepEqual(await m.unreported({ moved: () => false, busy: () => false, flag: () => assert.fail('flagged') }), [])
})

test('WP-263: a message the sweep may not resend is flagged once and never typed again', async () => {
  const { m, clock, draft } = await setup()
  m.record(draft({ state: 'delivered', requestId: 'req-1' }))
  const sent = [], flagged = []
  clock.t += 6 * 60_000
  assert.deepEqual(await m.sweep({ resendable: () => false, resend: async (r) => sent.push(r.id), flag: (r) => flagged.push(r.id) }), [{ id: 'a1', did: 'expired' }])
  assert.deepEqual(sent, [])
  assert.deepEqual(flagged, ['a1'])
  assert.equal(m.get('a1').error, 'no acknowledgement after 1 send')
})

test('WP-263: maxAttempts 2 = the original send plus one resend', async () => {
  const { m, clock, draft } = await setup()
  m.record(draft({ state: 'delivered', requestId: 'req-1' }))
  const sent = []
  const deps = { resendable: () => true, resend: async (r) => sent.push(r.id), flag: () => {} }
  clock.t += 6 * 60_000
  assert.deepEqual(await m.sweep(deps, { maxAttempts: 2 }), [{ id: 'a1', did: 'resent' }])
  clock.t += 6 * 60_000
  assert.deepEqual(await m.sweep(deps, { maxAttempts: 2 }), [{ id: 'a1', did: 'expired' }])
  assert.deepEqual(sent, ['a1'])
})

// ---- WP-272: the server's "continue" nudge and the finish-check reminder ----
const acked = (m, draft, o = {}) => { m.record(draft(o)); m.move(o.id ?? 'a1', 'delivered'); m.ack(o.id ?? 'a1', null) }
const mins = (n) => n * 60_000

test('WP-272 nudge: not due → none; due → once; a second pass and a restart (same db) send nothing more', async () => {
  const { m, clock, draft } = await setup()
  acked(m, draft)
  const sent = []
  const deps = { eligible: () => true, send: (r) => { sent.push(r.id) } }
  clock.t += NUDGE_MS - 1000
  assert.deepEqual(await m.nudges(deps), [])
  clock.t += 2000
  assert.deepEqual((await m.nudges(deps)).map((d) => d.did), ['nudged'])
  assert.deepEqual(await m.nudges(deps), [])
  const again = new Messages({ dir: m.file.replace(/\/wt\.db$/, ''), log: () => {}, now: () => clock.t }) // a restart
  assert.deepEqual(await again.nudges(deps), [])
  assert.deepEqual(sent, ['a1'])
})

test('WP-272 nudge: ineligible rows (card in review, other project, off) and non-ack kinds are skipped, unanswered only', async () => {
  const { m, clock, draft } = await setup()
  acked(m, draft); acked(m, draft, { id: 'r1', kind: 'reply', ticket: 'WP-2' })
  clock.t += mins(5)
  const card = (column) => ({ column }), agent = { local: true, project: 'wt-pack', status: 'idle' }
  assert.equal(nudgeEligible({ card: card('building'), agent, project: 'wt-pack' }), true)
  assert.equal(nudgeEligible({ card: card('review'), agent, project: 'wt-pack' }), false)
  assert.equal(nudgeEligible({ card: card('done'), agent, project: 'wt-pack' }), false)
  assert.equal(nudgeEligible({ card: card('building'), agent: { ...agent, project: 'other' }, project: 'wt-pack' }), false)
  assert.equal(nudgeEligible({ card: card('building'), agent: { ...agent, status: 'working' }, project: 'wt-pack' }), false)
  assert.equal(nudgeEligible({ card: card('building'), agent, project: 'wt-pack', off: true }), false)
  const sent = []
  await m.nudges({ eligible: () => false, send: (r) => sent.push(r.id) })
  assert.deepEqual(sent, [])
  await m.nudges({ eligible: () => true, send: (r) => sent.push(r.id) })
  assert.deepEqual(sent, ['a1']) // the reply kind expects no ack
})

test('WP-272: wording by role', () => {
  assert.match(nudgeText('worker', 'WP-9'), /^WP-9: your card is not in review\. Continue, or report what blocks you with handoff\.sh --reply$/)
  assert.match(nudgeText('planner', 'WP-9'), /^WP-9: the plan is not handed back\./)
  assert.match(nudgeText('reviewer', 'WP-9'), /^WP-9: not reported yet\./)
})

test('WP-272: unreported counts from the nudge when there was one (4 min), else from the ack (10 min)', async () => {
  const { m, clock, draft } = await setup()
  acked(m, draft); acked(m, draft, { id: 'b2', ticket: 'WP-2' })
  clock.t += NUDGE_MS + 1000
  await m.nudges({ eligible: (r) => r.id === 'a1', send: () => {} })
  const flagged = []
  const deps = { moved: () => false, busy: () => false, flag: (r) => flagged.push(r.id) }
  await m.unreported(deps)
  assert.deepEqual(flagged, []) // nudged just now: 4 more minutes
  clock.t += NUDGE_MS + 1000
  await m.unreported(deps)
  assert.deepEqual(flagged, ['a1']) // b2 was never nudged: still inside its 10 minutes
  clock.t += mins(5)
  await m.unreported(deps)
  assert.deepEqual(flagged, ['a1', 'b2'])
})

test('WP-272 finish check: the newest acked, unanswered handoff with an open card is reminded once; answered or closed → none', async () => {
  const { m, draft } = await setup()
  acked(m, draft)
  assert.equal(await m.remindable('w9:p9', () => true), null)
  assert.equal(await m.remindable('w1:p1', () => false), null) // the card is in review
  assert.equal((await m.remindable('w1:p1', () => true)).id, 'a1')
  assert.equal(await m.remindable('w1:p1', () => true), null) // once
  m.record(draft({ id: 'c3', ticket: 'WP-3' })); m.move('c3', 'delivered'); m.ack('c3', null, 'answered')
  assert.equal(await m.remindable('w1:p1', () => true), null)
})
