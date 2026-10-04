// Run: node --test dispatch.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Tickets } from './tickets.mjs'
import { Dispatch, mergeIds, dispatchPrompt, resolveReport, personaFor } from './dispatch.mjs'

const user = { name: 'Rep' }
const tagTicket = (a) => a.tags?.ticket ?? null

async function setup({ agents = [], pressure = 'normal', max = 4, handoff, merges = '', pending = 0, triageOn, report = null, extra = {} } = {}) {
  const tickets = new Tickets({ dir: await mkdtemp(join(tmpdir(), 'dispatch-')) })
  await tickets.board('wt-pack')
  await tickets.setSettings('wt-pack', { dispatch: true })
  const calls = []
  const d = new Dispatch({
    tickets, log: () => {},
    deps: {
      agents: async () => agents, host: async () => ({ pressure }), maxWorking: () => max, pending: () => pending,
      repoOf: async () => '/repo', reportOf: async (p) => (p === 'wt-pack' ? report : null), ticketOf: tagTicket, triageOn: () => triageOn,
      git: async (repo, ...a) => a[0] === 'log' ? merges : a[0] === 'rev-parse' ? 'abc123\n' : a[0] === 'remote' ? 'origin\n' : '',
      handoff: async (args, prompt, cwd) => {
        calls.push({ args, prompt, cwd })
        return handoff ? handoff(args) : 'created wt-pack-worker-09 w9:p1\ntarget wt-pack-worker-09 w9:p1 — x\nreach: …\n'
      },
      ...extra,
    },
  })
  return { tickets, d, calls }
}
const ready = (tickets, title, extra = {}) => tickets.create('wt-pack', { title, column: 'ready', ...extra }, user)

test('claim race: only one dispatchClaim wins', async () => {
  const { tickets } = await setup()
  const t = await ready(tickets, 'a')
  const r = await Promise.all([1, 2, 3].map(() => tickets.dispatchClaim(t.id)))
  assert.equal(r.filter(Boolean).length, 1)
})

test('cap reached: nothing is claimed, waiting = cap', async () => {
  const { tickets, d, calls } = await setup({ max: 2, pending: 1, agents: [{ name: 'w1', status: 'working', local: true }] })
  const t = await ready(tickets, 'a')
  await d.tick()
  assert.equal(calls.length, 0)
  assert.equal((await tickets.get(t.id)).dispatch, undefined)
  assert.match(d.status('wt-pack').waiting, /^cap: 2 working ≥ 2/)
})

test('memory critical: nothing is claimed', async () => {
  const { tickets, d, calls } = await setup({ pressure: 'critical' })
  const t = await ready(tickets, 'a')
  await d.tick()
  assert.equal(calls.length, 0)
  assert.equal((await tickets.get(t.id)).column, 'ready')
  assert.equal(d.status('wt-pack').waiting, 'memory pressure critical')
})

test('priority order: urgent first, none last, one dispatch per tick', async () => {
  const { tickets, d, calls } = await setup()
  await ready(tickets, 'none', { priority: 0 })
  await ready(tickets, 'low', { priority: 4 })
  const urgent = await ready(tickets, 'urgent', { priority: 1 })
  await d.tick()
  assert.equal(calls.length, 1)
  assert.match(calls[0].args.join(' '), new RegExp(`--task ${urgent.id} urgent`))
})

test('needs-plan label sends an M card to a planner', async () => {
  const { tickets, d, calls } = await setup()
  const m = await ready(tickets, 'needs design', { size: 'M', priority: 1, labels: ['ui', 'needs-plan'] })
  await d.tick()
  assert.deepEqual(calls[0].args.slice(0, 2), ['--role', 'planner'])
  assert.match(calls[0].prompt, /^Use wt-plan/)
  assert.equal((await tickets.get(m.id)).column, 'planning')
})

test('L goes to a planner, M goes to a worker, both with --role; success → assigned with history', async () => {
  const { tickets, d, calls } = await setup()
  const l = await ready(tickets, 'big', { size: 'L', priority: 1 })
  const m = await ready(tickets, 'mid', { size: 'M', priority: 2 })
  await d.tick(); await d.tick()
  assert.deepEqual(calls.map((c) => c.args.slice(0, 2)), [['--role', 'planner'], ['--role', 'worker']])
  assert.match(calls[0].prompt, /^Use wt-plan/)
  assert.match(calls[1].prompt, /wt-work.*wt-ship/s)
  assert.equal(calls[1].cwd, '/repo')
  const [L, M] = [await tickets.get(l.id), await tickets.get(m.id)]
  assert.deepEqual([L.column, M.column], ['planning', 'building'])
  assert.deepEqual(M.assignee, { name: 'wt-pack-worker-09', pane: 'w9:p1' })
  assert.equal(M.dispatch.state, 'sent')
  assert.ok(M.history.some((h) => h.kind === 'move' && h.to === 'building' && h.text === 'dispatched to wt-pack-worker-09'))
  assert.match(d.status('wt-pack').last.text, /→ wt-pack-worker-09/)
  assert.deepEqual(d.events().map((e) => e.kind), ['dispatch', 'dispatch'])
})

test('failed handoff: card stays Ready and unassigned, retried after 2 min, held after 3', async () => {
  const { tickets, d, calls } = await setup({ handoff: () => { throw new Error('claude never came up') } })
  const t = await ready(tickets, 'a')
  let now = Date.now()
  await d.tick(now)
  let c = await tickets.get(t.id)
  assert.deepEqual([c.column, c.assignee, c.dispatch.state, c.dispatch.fails], ['ready', null, 'failed', 1])
  await d.tick(now + 60_000) // too soon
  assert.equal(calls.length, 1)
  await d.tick(now += 130_000)
  await d.tick(now += 130_000)
  c = await tickets.get(t.id)
  assert.deepEqual([calls.length, c.dispatch.state, c.dispatch.fails], [3, 'held', 3])
  await d.tick(now += 600_000)
  assert.equal(calls.length, 3) // held: no more tries
  await tickets.setDispatch(t.id, null) // Retry dispatch
  await d.tick(now += 1)
  assert.equal(calls.length, 4)
})

test('a second concurrent tick is a no-op', async () => {
  const { tickets, d, calls } = await setup()
  await ready(tickets, 'a'); await ready(tickets, 'b')
  await Promise.all([d.tick(), d.tick()])
  assert.equal(calls.length, 1)
})

test('dispatch off: nothing dispatched', async () => {
  const { tickets, d, calls } = await setup()
  await tickets.setSettings('wt-pack', { dispatch: false })
  await ready(tickets, 'a')
  await d.tick()
  assert.equal(calls.length, 0)
})

test('recover(): a tagged agent finishes the dispatch; none clears the claim', async () => {
  const { tickets, d } = await setup()
  const a = await ready(tickets, 'a'), b = await ready(tickets, 'b')
  await tickets.dispatchClaim(a.id); await tickets.dispatchClaim(b.id)
  d.deps.agents = async () => [{ name: 'wt-pack-worker-02', id: 'w2:p1', local: true, tags: { ticket: a.id } }]
  await d.recover()
  const [A, B] = [await tickets.get(a.id), await tickets.get(b.id)]
  assert.deepEqual([A.column, A.assignee?.name, A.dispatch.state], ['building', 'wt-pack-worker-02', 'sent'])
  assert.deepEqual([B.column, B.assignee, B.dispatch], ['ready', null, undefined])
})

test('merge-subject parser table', () => {
  const cases = [
    ["Merge branch 'wp-48-routines' — WP-48 Routines", ['WP-48']],
    ["Merge branch 'wp-33-35'", ['WP-33']],
    ["Merge branch 'wp-39'", ['WP-39']],
    ["Merge branch 'feature-x'", []],
    ["Merge branch 'main' of github.com:rephol/wt-pack", []],
  ]
  for (const [s, want] of cases) assert.deepEqual(mergeIds(s, 'WP'), want, s)
})

test('reconcile: a merged card in review goes to done; ready with a matching merge is untouched', async () => {
  const { tickets, d } = await setup({ merges: `abcdef1234\t${Math.floor(Date.now() / 1000) + 60}\tMerge branch 'wp-1-x'\nbbbbbbb999\t${Math.floor(Date.now() / 1000) + 60}\tMerge branch 'wp-2'\n` })
  await tickets.setSettings('wt-pack', { dispatch: false })
  const r = await tickets.create('wt-pack', { title: 'rev', column: 'review' }, user)
  const q = await tickets.create('wt-pack', { title: 'rdy', column: 'ready' }, user)
  await d.tick()
  const [R, Q] = [await tickets.get(r.id), await tickets.get(q.id)]
  assert.equal(R.column, 'done')
  assert.equal(R.history.at(-1).text, 'merged in abcdef1')
  assert.equal(Q.column, 'ready')
})

test('reconcile: no origin remote scans the local base branch, no fetch (WP-224)', async () => {
  const { tickets, d } = await setup({ merges: `abcdef1234\t${Math.floor(Date.now() / 1000) + 60}\tMerge branch 'wp-1-x'\n` })
  const seen = []
  const git = d.deps.git
  d.deps.git = async (repo, ...a) => (seen.push(a.join(' ')), a[0] === 'remote' ? '' : git(repo, ...a))
  await tickets.setSettings('wt-pack', { dispatch: false })
  const r = await tickets.create('wt-pack', { title: 'rev', column: 'review' }, user)
  await d.tick()
  assert.equal((await tickets.get(r.id)).column, 'done')
  assert.ok(!seen.some((c) => c.startsWith('fetch') || c.includes('origin/')), seen.join('|'))
})

test('reconcile: origin without origin/<base> falls back to the local base (WP-224)', async () => {
  const { tickets, d } = await setup({ merges: `abcdef1234\t${Math.floor(Date.now() / 1000) + 60}\tMerge branch 'wp-1-x'\n` })
  const seen = []
  const git = d.deps.git
  d.deps.git = async (repo, ...a) => (seen.push(a.join(' ')), a[1] === '--verify' ? Promise.reject(new Error('no ref')) : git(repo, ...a))
  await tickets.setSettings('wt-pack', { dispatch: false })
  const r = await tickets.create('wt-pack', { title: 'rev', column: 'review' }, user)
  await d.tick()
  assert.equal((await tickets.get(r.id)).column, 'done')
  assert.ok(seen.includes('log --merges --first-parent --since=7.days --format=%H%x09%ct%x09%s main'), seen.join('|'))
})

test('reconcile: gone twice → Ready with assignee null; gone once, herdr down or a user claim → untouched', async () => {
  const other = { name: 'someone-else', local: true, status: 'working' }
  const { tickets, d } = await setup({ agents: [other] })
  await tickets.setSettings('wt-pack', { dispatch: false })
  const t = await tickets.create('wt-pack', { title: 'a', column: 'building' }, user)
  await tickets.patch(t.id, {}, user, { name: 'wt-pack-worker-07', pane: 'w7:p1' })
  await tickets.setDispatch(t.id, { state: 'sent', at: 'x', agent: 'wt-pack-worker-07' })
  const u = await tickets.create('wt-pack', { title: 'user-claimed', column: 'building' }, user)
  await tickets.patch(u.id, {}, user, { name: 'Rep' })
  await d.tick()
  assert.equal((await tickets.get(t.id)).column, 'building') // once
  d.deps.agents = async () => [] // herdr down / no local agents: skipped, the count holds
  await d.tick()
  assert.equal((await tickets.get(t.id)).column, 'building')
  d.deps.agents = async () => [other]
  await d.tick()
  const T = await tickets.get(t.id)
  assert.deepEqual([T.column, T.assignee, T.dispatch], ['ready', null, undefined])
  assert.ok(T.history.some((h) => h.text === 'returned: wt-pack-worker-07 is gone'))
  assert.equal((await tickets.get(u.id)).column, 'building')
})

test('reconcile: a gone assignee unassigns from Ready/Review/Blocked too, without a dispatch tag or a column move (WP-140)', async () => {
  const other = { name: 'someone-else', local: true, status: 'working' }
  const { tickets, d } = await setup({ agents: [other] })
  await tickets.setSettings('wt-pack', { dispatch: false })
  const r = await tickets.create('wt-pack', { title: 'r', column: 'ready' }, user)
  await tickets.patch(r.id, {}, user, { name: 'wt-pack-worker-12', pane: 'w12:p1' }) // by-hand assign, no dispatch tag
  const v = await tickets.create('wt-pack', { title: 'v', column: 'review' }, user)
  await tickets.patch(v.id, {}, user, { name: 'wt-pack-worker-12', pane: 'w12:p2' })
  const b = await tickets.create('wt-pack', { title: 'x', column: 'blocked', note: 'stuck' }, user)
  await tickets.patch(b.id, {}, user, { name: 'wt-pack-worker-12', pane: 'w12:p3' })
  await d.tick(); await d.tick() // two misses
  const [R, V, B] = await Promise.all([tickets.get(r.id), tickets.get(v.id), tickets.get(b.id)])
  assert.deepEqual([R.column, R.assignee], ['ready', null])
  assert.deepEqual([V.column, V.assignee], ['review', null]) // unassigned, but not moved
  assert.deepEqual([B.column, B.assignee], ['blocked', null])
})

test('reconcile: stalled sets a flag without moving the card, noted once', async () => {
  const now = Date.now()
  const a = { name: 'wt-pack-worker-05', id: 'w5:p1', local: true, status: 'done', lastActivity: now - 60 * 60_000 }
  const { tickets, d } = await setup({ agents: [a] })
  await tickets.setSettings('wt-pack', { dispatch: false })
  const t = await tickets.create('wt-pack', { title: 'a', column: 'building' }, user)
  await tickets.patch(t.id, {}, user, { name: a.name, pane: a.id })
  await d.tick(now); await d.tick(now + 1000)
  const T = await tickets.get(t.id)
  assert.equal(T.column, 'building')
  assert.equal(T.dispatch.stalled, 'wt-pack-worker-05 idle 60m')
  assert.equal(T.history.filter((h) => h.text?.startsWith('stalled:')).length, 1)
})

// WP-177: a handoff that reports success but never actually lands leaves the card silently in Building.
test('WP-177: the assignee going working confirms delivery immediately, no resend', async () => {
  const a = { name: 'wt-pack-worker-09', id: 'w9:p1', local: true, status: 'idle', lastActivity: Date.now() }
  const { tickets, d, calls } = await setup({ agents: [a] })
  const t = await ready(tickets, 'a')
  const now = Date.now()
  await d.tick(now)
  d.deps.agents = async () => [{ ...a, status: 'working' }]
  await d.tick(now + 5_000) // long before the 60s window — status alone confirms it
  const c = await tickets.get(t.id)
  assert.equal(c.dispatch.confirmed, true)
  assert.equal(calls.length, 1)
})

test('WP-177: fast completion (done before 60s) also confirms delivery', async () => {
  const a = { name: 'wt-pack-worker-09', id: 'w9:p1', local: true, status: 'idle', lastActivity: Date.now() }
  const { tickets, d, calls } = await setup({ agents: [a] })
  const t = await ready(tickets, 'a')
  const now = Date.now()
  await d.tick(now)
  d.deps.agents = async () => [{ ...a, status: 'done' }]
  await d.tick(now + 5_000)
  assert.equal((await tickets.get(t.id)).dispatch.confirmed, true)
  assert.equal(calls.length, 1)
})

test('WP-177: blocked (it asked a question) also confirms delivery — not a delivery failure', async () => {
  const a = { name: 'wt-pack-worker-09', id: 'w9:p1', local: true, status: 'idle', lastActivity: Date.now() }
  const { tickets, d, calls } = await setup({ agents: [a] })
  const t = await ready(tickets, 'a')
  const now = Date.now()
  await d.tick(now)
  d.deps.agents = async () => [{ ...a, status: 'blocked' }]
  await d.tick(now + 5_000)
  assert.equal((await tickets.get(t.id)).dispatch.confirmed, true)
  assert.equal(calls.length, 1)
})

test('WP-177: no confirmation within 60s resends once, to the same pane with the same prompt', async () => {
  const a = { name: 'wt-pack-worker-09', id: 'w9:p1', local: true, status: 'idle', lastActivity: Date.now() }
  const { tickets, d, calls } = await setup({ agents: [a] })
  const t = await ready(tickets, 'a')
  const now = Date.now()
  await d.tick(now)
  await d.tick(now + 30_000) // too soon
  assert.equal(calls.length, 1)
  await d.tick(now + 61_000)
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[1].args.slice(0, 2), ['--pane', 'w9:p1'])
  assert.equal(calls[1].prompt, calls[0].prompt)
  const c = await tickets.get(t.id)
  assert.ok(c.dispatch.redeliveredAt)
  assert.ok(c.history.some((h) => h.text === 'resent handoff to wt-pack-worker-09: no confirmed delivery within 60s'))
  // a second reconcile inside the same 60s window doesn't resend again
  await d.tick(now + 90_000)
  assert.equal(calls.length, 2)
})

test('WP-177: still unconfirmed 60s after the resend flags it — Inbox item, ticket comment, card left in Building', async () => {
  const a = { name: 'wt-pack-worker-09', id: 'w9:p1', local: true, status: 'idle', lastActivity: Date.now() }
  const notified = []
  const { tickets, d, calls } = await setup({ agents: [a], extra: { notify: async (i) => notified.push(i) } })
  const t = await ready(tickets, 'a')
  const now = Date.now()
  await d.tick(now)
  await d.tick(now + 61_000) // resend
  await d.tick(now + 61_000 + 30_000) // too soon after the resend
  assert.equal(notified.length, 0)
  await d.tick(now + 61_000 + 61_000)
  assert.equal(calls.length, 2) // never a third resend
  const c = await tickets.get(t.id)
  assert.equal(c.column, 'building')
  assert.equal(c.dispatch.undelivered, 'wt-pack-worker-09: handoff not confirmed even after a resend')
  assert.ok(c.history.some((h) => h.text === `stalled: ${c.dispatch.undelivered}`))
  assert.deepEqual(notified.map((n) => n.kind), ['dispatch-undelivered'])
  assert.equal(d.events().filter((e) => e.kind === 'stalled').length, 1)
  // confirmed still never lands
  await d.tick(now + 61_000 + 61_000 + 61_000)
  assert.equal(calls.length, 2)
  assert.equal(notified.length, 1) // not re-notified every tick
})

test('runHandoff: prompt on stdin, HERDR_PANE_ID blanked, 120 s timeout', async () => {
  let seen
  const execFile = (bin, args, opts, cb) => {
    seen = { bin, args, opts }
    return { stdin: { end: (p) => { seen.prompt = p; cb(null, 'reused w1:p1\n', '') } } }
  }
  process.env.HERDR_PANE_ID = 'w9:p9'
  const out = await (await import('./dispatch.mjs')).runHandoff(execFile, '/h.sh')(['--role', 'worker'], 'hi', '/repo')
  assert.equal(out, 'reused w1:p1\n')
  assert.deepEqual([seen.bin, seen.opts.cwd, seen.opts.env.HERDR_PANE_ID, seen.opts.timeout, seen.prompt], ['/h.sh', '/repo', '', 120_000, 'hi'])
})

test('reconcile: a merge older than the card latest move (reopened) is ignored', async () => {
  const { tickets, d } = await setup({ merges: `abcdef1234\t${Math.floor(Date.now() / 1000) - 86400}\tMerge branch 'wp-1-x'\n` })
  await tickets.setSettings('wt-pack', { dispatch: false })
  const r = await tickets.create('wt-pack', { title: 'reopened', column: 'done' }, user)
  await tickets.patch(r.id, { column: 'building' }, user)
  await d.tick()
  assert.equal((await tickets.get(r.id)).column, 'building')
})

test('dispatchRetry clears failed/held, refuses a claim in flight or a sent card', async () => {
  const { tickets } = await setup()
  const t = await ready(tickets, 'a')
  await tickets.dispatchClaim(t.id)
  await assert.rejects(tickets.dispatchRetry(t.id), /dispatching/)
  await tickets.setDispatch(t.id, { state: 'held', fails: 3 })
  assert.equal((await tickets.dispatchRetry(t.id)).dispatch, undefined)
})

test('Jev triage pending: skipped for up to 60s, dispatched once triaged; nothing waits when triage is off', async () => {
  const { tickets, d, calls } = await setup({ triageOn: true })
  const t = await ready(tickets, 'fresh', { size: 'M' })
  const born = Date.parse(t.created)
  await d.tick(born + 1000)
  assert.equal(calls.length, 0)
  assert.equal(d.status('wt-pack').waiting, 'waiting for triage')
  await tickets.jevApply(t.id, { owner: 'planner', dupes: [] }, []) // triage done: adds needs-plan
  await d.tick(born + 2000)
  assert.deepEqual(calls[0].args.slice(0, 2), ['--role', 'planner'])
  const late = await ready(tickets, 'jev never answered', { size: 'S' })
  await d.tick(Date.parse(late.created) + 30_000)
  assert.equal(calls.length, 1)
  await d.tick(Date.parse(late.created) + 61_000) // past the cap: fail-open
  assert.equal(calls.length, 2)
  const off = await setup({ triageOn: false })
  await ready(off.tickets, 'no jev')
  await off.d.tick()
  assert.equal(off.calls.length, 1)
})

test('dispatchPrompt: report line in four shapes, both roles; no "reply to the sender" (WP-75)', () => {
  const t = { id: 'WP-9', title: 'x' }
  const orch = { name: 'o', pane: 'w1:p2' }
  for (const role of ['worker', 'planner']) {
    const room = dispatchPrompt(t, role, { room: 'wt-pack', orch: null })
    assert.match(room, /When done, post a one-line result in #wt-pack with `room post wt-pack "…"`\.\n$/)
    const o = dispatchPrompt(t, role, { room: null, orch })
    assert.match(o, /When done, send a one-line result to o with `\/\S+\/wt-handoff\/scripts\/handoff\.sh --reply w1:p2 "…"`\.\n$/)
    const both = dispatchPrompt(t, role, { room: 'wt-pack', orch })
    assert.match(both, /room post wt-pack "…"` and send a one-line result to o with `\/\S+\/wt-handoff\/scripts\/handoff\.sh --reply w1:p2/)
    const none = dispatchPrompt(t, role, { room: null, orch: null })
    assert.doesNotMatch(none, /When done/)
    assert.equal(none, dispatchPrompt(t, role))
    for (const p of [room, o, both, none]) assert.doesNotMatch(p, /reply to the sender/)
  }
})

test('resolveReport: project room by default, none, a slug, archived skipped, local orchestrator only (WP-75)', () => {
  const rooms = { 'wt-pack': { slug: 'wt-pack' }, ops: { slug: 'ops' }, old: { slug: 'old', archived: true } }
  const room = (s) => rooms[s]
  const local = { local: true, pool: 'orchestrator', project: 'wt-pack', name: 'o', id: 'w1:p2' }
  const remote = { ...local, local: false, name: 'r', id: 'w9:p1' }
  assert.deepEqual(resolveReport('wt-pack', {}, room, [local]), { room: 'wt-pack', orch: { name: 'o', pane: 'w1:p2' } })
  assert.deepEqual(resolveReport('wt-pack', { reportRoom: '', reportOrch: false }, room, [local]), { room: null, orch: null })
  assert.equal(resolveReport('wt-pack', { reportRoom: 'ops' }, room).room, 'ops')
  assert.equal(resolveReport('wt-pack', { reportRoom: 'old' }, room).room, null)
  assert.equal(resolveReport('wt-pack', { reportRoom: 'gone' }, room).room, null)
  assert.equal(resolveReport('wt-pack', {}, room, [remote]).orch, null)
  assert.equal(resolveReport('x', {}, room, [local]).orch, null) // another project's orchestrator
})

test('dispatch: tick() puts the resolved room and orchestrator in the prompt (WP-75)', async () => {
  const { tickets, d, calls } = await setup({ report: { room: 'wt-pack', orch: { name: 'o', pane: 'w1:p2' } } })
  await ready(tickets, 'a')
  await d.tick()
  assert.match(calls[0].prompt, /room post wt-pack/)
  assert.match(calls[0].prompt, /handoff\.sh --reply w1:p2/)
  assert.deepEqual(calls[0].args.slice(2, 6), ['--kind', 'dispatch', '--from', 'wt-dashboard']) // WP-104
})

test('project settings (WP-107): maxWorking and baseBranch are asked per project', async () => {
  const { tickets, d, calls } = await setup({ agents: [{ name: 'w1', status: 'working', local: true }] })
  const asked = [], git = []
  d.deps.maxWorking = (p) => (asked.push(p), 1)
  d.deps.baseBranch = (p) => (asked.push(p), 'develop')
  d.deps.git = async (repo, ...a) => (git.push(a), a[0] === 'rev-parse' ? 'abc123\n' : a[0] === 'remote' ? 'origin\n' : '')
  await ready(tickets, 'a')
  await tickets.create('wt-pack', { title: 'rev', column: 'review' }, user)
  await d.tick()
  assert.equal(calls.length, 0)
  assert.match(d.status('wt-pack').waiting, /^cap: 1 working ≥ 1/)
  assert.deepEqual([...new Set(asked)], ['wt-pack'])
  assert.ok(git.some((a) => a[0] === 'log' && a.at(-1) === 'origin/develop'))
  assert.ok(git.some((a) => a[0] === 'rev-parse' && a.at(-1) === 'origin/develop'))
  assert.ok(!git.flat().includes('origin/main'))
})

test('WP-122: the report line names this pack\'s own handoff.sh, never a ~/.claude/skills link', async () => {
  const { reportLine } = await import('./dispatch.mjs')
  const l = reportLine({ orch: { name: 'o', pane: 'w1:p2' } })
  assert.doesNotMatch(l, /~\/\.claude\/skills/)
  assert.match(l, /\/wt-handoff\/scripts\/handoff\.sh --reply w1:p2/)
})

// WP-128: two strikes (returns or review send-backs) escalate a ticket to opus, live routing only.
async function strikeSetup(mode) {
  const outcomes = [], notes = []
  const r = await setup({ max: 0, extra: { routeMode: async () => mode, routeOutcome: (...a) => outcomes.push(a), notify: async (i) => notes.push(i) } })
  const t = await r.tickets.create('wt-pack', { title: 'x', column: 'building' }, user)
  await r.tickets.comment(t.id, 'routing: sonnet (live, jev, ref abc12#0)', user)
  return { ...r, t, outcomes, notes }
}
for (const [mode, n, want] of [['live', 2, true], ['live', 1, false], ['shadow', 2, false]]) {
  test(`routing escalation: ${mode}, ${n} strike(s) → ${want ? 'escalated' : 'not'}`, async () => {
    const { tickets, d, t, outcomes, notes } = await strikeSetup(mode)
    for (let i = 0; i < n; i++) await tickets.comment(t.id, `routing: send-back abc12#0 — P1 ${i}`, user)
    await d.tick(); await d.tick()
    const esc = (await tickets.get(t.id)).history.filter((h) => /^routing: escalate opus/.test(h.text ?? ''))
    assert.equal(esc.length, want ? 1 : 0) // once, not per tick
    assert.equal(notes.length, want ? 1 : 0)
    if (want) { assert.equal(notes[0].kind, 'routing-escalation'); assert.deepEqual(outcomes[0].slice(0, 2), ['abc12#0', 'escalated']) }
  })
}

// WP-131: WP-128 put a "routing:" line second; the agent name must still come from the target line.
test('handoff output with a routing line: name from the target line, card claimed once', async () => {
  const { tickets, d, calls } = await setup({ handoff: () => 'created wt-pack-worker-09 w9:p1\nrouting: sonnet (live, jev, ref ab1#0)\ntarget wt-pack-worker-09 w9:p1 — x\nreach: …\n' })
  const t = await ready(tickets, 'a')
  await d.tick(); await d.tick()
  const got = await tickets.get(t.id)
  assert.equal(got.assignee.name, 'wt-pack-worker-09'); assert.equal(got.assignee.pane, 'w9:p1')
  assert.equal(calls.length, 1)
})

// WP-147: pairing
test('WP-147: dispatch picks a free reviewer as the buddy, passes --buddy, and pairs the ticket', async () => {
  const reviewer = { name: 'wt-pack-reviewer-01', id: 'wR:p1', local: true, pool: 'reviewer', project: 'wt-pack', status: 'idle', paneTokens: {} }
  const { tickets, d, calls } = await setup({ agents: [reviewer] })
  const t = await ready(tickets, 'a')
  await d.tick()
  assert.ok(calls[0].args.includes('--buddy'))
  assert.equal(calls[0].args[calls[0].args.indexOf('--buddy') + 1], 'wR:p1')
  assert.deepEqual((await tickets.get(t.id)).pair, {
    worker: { name: 'wt-pack-worker-09', pane: 'w9:p1' },
    buddy: { name: 'wt-pack-reviewer-01', pane: 'wR:p1', role: 'reviewer' },
  })
})

test('WP-147: no free reviewer → no --buddy, ticket stays unpaired', async () => {
  const { tickets, d, calls } = await setup({ agents: [] })
  const t = await ready(tickets, 'a')
  await d.tick()
  assert.ok(!calls[0].args.includes('--buddy'))
  assert.equal((await tickets.get(t.id)).pair, undefined)
})

test('WP-147 reconcile: a gone paired worker is replaced in place, not returned to Ready, with a comment', async () => {
  const repl = { name: 'wt-pack-worker-02', id: 'w2:p1', local: true, pool: 'worker', project: 'wt-pack', status: 'idle', paneTokens: {} }
  const buddy = { name: 'wt-pack-reviewer-01', id: 'wR:p1', local: true, pool: 'reviewer', project: 'wt-pack', status: 'idle', paneTokens: {} }
  const tagged = []
  const { tickets, d } = await setup({ agents: [repl, buddy], extra: { tagPair: async (pane, ticket) => tagged.push([pane, ticket]) } })
  await tickets.setSettings('wt-pack', { dispatch: false })
  const t = await tickets.create('wt-pack', { title: 'a', column: 'building' }, user)
  await tickets.patch(t.id, { pair: { worker: { name: 'wt-pack-worker-07', pane: 'w7:p1' }, buddy: { name: 'wt-pack-reviewer-01', pane: 'wR:p1', role: 'reviewer' } } },
    user, { name: 'wt-pack-worker-07', pane: 'w7:p1' })
  await d.tick(); await d.tick() // two misses
  const T = await tickets.get(t.id)
  assert.equal(T.column, 'building')
  assert.equal(T.assignee.name, 'wt-pack-worker-02')
  assert.equal(T.pair.worker.name, 'wt-pack-worker-02')
  assert.equal(T.pair.buddy.name, 'wt-pack-reviewer-01') // unchanged
  assert.ok(T.history.some((h) => h.text === 'pair: wt-pack-worker-07 → wt-pack-worker-02 (gone)'))
  assert.deepEqual(tagged, [['w2:p1', T.id]])
})

test('WP-147 reconcile: two tickets losing their worker in the same tick never get the same replacement', async () => {
  const repl = { name: 'wt-pack-worker-02', id: 'w2:p1', local: true, pool: 'worker', project: 'wt-pack', status: 'idle', paneTokens: {} }
  const { tickets, d } = await setup({ agents: [repl] })
  await tickets.setSettings('wt-pack', { dispatch: false })
  const t1 = await tickets.create('wt-pack', { title: 'a', column: 'building' }, user)
  await tickets.patch(t1.id, { pair: { worker: { name: 'wt-pack-worker-07', pane: 'w7:p1' } } }, user, { name: 'wt-pack-worker-07', pane: 'w7:p1' })
  const t2 = await tickets.create('wt-pack', { title: 'b', column: 'building' }, user)
  await tickets.patch(t2.id, { pair: { worker: { name: 'wt-pack-worker-08', pane: 'w8:p1' } } }, user, { name: 'wt-pack-worker-08', pane: 'w8:p1' })
  await d.tick(); await d.tick() // two misses, both tickets, same tick
  const [T1, T2] = await Promise.all([tickets.get(t1.id), tickets.get(t2.id)])
  const winners = [T1.pair.worker?.name, T2.pair.worker?.name].filter(Boolean)
  assert.equal(new Set(winners).size, winners.length) // never the same agent twice
  assert.ok(winners.includes('wt-pack-worker-02')) // the one free worker went to exactly one of them
  assert.ok([T1.pair.worker, T2.pair.worker].includes(null)) // the other has no replacement
})

test('WP-147 reconcile: a gone buddy is replaced too, worker untouched', async () => {
  const worker = { name: 'wt-pack-worker-07', id: 'w7:p1', local: true, pool: 'worker', project: 'wt-pack', status: 'working', paneTokens: {} }
  const replBuddy = { name: 'wt-pack-reviewer-02', id: 'wR:p2', local: true, pool: 'reviewer', project: 'wt-pack', status: 'idle', paneTokens: {} }
  const { tickets, d } = await setup({ agents: [worker, replBuddy] })
  await tickets.setSettings('wt-pack', { dispatch: false })
  const t = await tickets.create('wt-pack', { title: 'a', column: 'building' }, user)
  await tickets.patch(t.id, { pair: { worker: { name: 'wt-pack-worker-07', pane: 'w7:p1' }, buddy: { name: 'wt-pack-reviewer-01', pane: 'wR:p1', role: 'reviewer' } } },
    user, { name: 'wt-pack-worker-07', pane: 'w7:p1' })
  await d.tick(); await d.tick()
  const T = await tickets.get(t.id)
  assert.equal(T.assignee.name, 'wt-pack-worker-07')
  assert.equal(T.pair.buddy.name, 'wt-pack-reviewer-02')
})

test('WP-147 reconcile: no free replacement → Inbox notify, card left where it is', async () => {
  const notified = []
  const other = { name: 'someone-else', local: true, pool: 'other', project: 'wt-pack', status: 'working' }
  const { tickets, d } = await setup({ agents: [other], extra: { notify: async (item) => notified.push(item) } })
  await tickets.setSettings('wt-pack', { dispatch: false })
  const t = await tickets.create('wt-pack', { title: 'a', column: 'building' }, user)
  await tickets.patch(t.id, { pair: { worker: { name: 'wt-pack-worker-07', pane: 'w7:p1' }, buddy: { name: 'wt-pack-reviewer-01', pane: 'wR:p1', role: 'reviewer' } } },
    user, { name: 'wt-pack-worker-07', pane: 'w7:p1' })
  await d.tick(); await d.tick()
  const T = await tickets.get(t.id)
  assert.equal(T.column, 'building')
  assert.equal(T.pair.worker, null)
  assert.ok(notified.some((n) => n.kind === 'pair-gone'))
})

// WP-204
test('personaFor: first persona in order whose base matches the role and a label matches (case-insensitive)', () => {
  const ps = [{ name: 'a-planner', base: 'planner', labels: ['ui'] }, { name: 'b-worker', base: 'worker', labels: ['backend'] }, { name: 'c-worker', base: 'worker', labels: ['UI', 'css'] }]
  assert.equal(personaFor({ labels: ['ui'] }, ps, 'worker').name, 'c-worker')
  assert.equal(personaFor({ labels: ['ui'] }, ps, 'planner').name, 'a-planner')
  assert.equal(personaFor({ labels: ['docs'] }, ps, 'worker'), null)
  assert.equal(personaFor({}, ps, 'worker'), null)
  assert.equal(personaFor({ labels: ['ui'] }, undefined, 'worker'), null)
})

test('dispatch passes --persona for a matching label, and nothing for a plain ticket', async () => {
  const { tickets, d, calls } = await setup({ extra: { personasOf: async () => [{ name: 'frontend-worker', base: 'worker', labels: ['ui'] }] } })
  await ready(tickets, 'ui thing', { labels: ['ui'] })
  await d.tick()
  assert.deepEqual(calls[0].args.slice(0, 4), ['--role', 'worker', '--persona', 'frontend-worker'])
  const s2 = await setup({ extra: { personasOf: async () => [{ name: 'frontend-worker', base: 'worker', labels: ['ui'] }] } })
  await ready(s2.tickets, 'plain')
  await s2.d.tick()
  assert.ok(!s2.calls[0].args.includes('--persona'))
})

test('WP-205: an idle persona reviewer is not picked as a buddy', async () => {
  const persona = { name: 'wt-pack-qa-reviewer-01', id: 'wR:p3', local: true, pool: 'reviewer', project: 'wt-pack', status: 'idle', paneTokens: { persona: 'qa-reviewer' } }
  const { tickets, d, calls } = await setup({ agents: [persona] })
  await ready(tickets, 'a')
  await d.tick()
  assert.ok(!calls[0].args.includes('--buddy'))
})

test('WP-205: a gone paired buddy is not replaced by an idle persona reviewer', async () => {
  const persona = { name: 'wt-pack-qa-reviewer-01', id: 'wR:p3', local: true, pool: 'reviewer', project: 'wt-pack', status: 'idle', paneTokens: { persona: 'qa-reviewer' } }
  const worker = { name: 'wt-pack-worker-07', id: 'w7:p1', local: true, pool: 'worker', project: 'wt-pack', status: 'working', paneTokens: {} }
  const { tickets, d } = await setup({ agents: [persona, worker], extra: { tagPair: async () => {} } })
  await tickets.setSettings('wt-pack', { dispatch: false })
  const t = await tickets.create('wt-pack', { title: 'a', column: 'building' }, user)
  await tickets.patch(t.id, { pair: { worker: { name: 'wt-pack-worker-07', pane: 'w7:p1' }, buddy: { name: 'wt-pack-reviewer-01', pane: 'wR:p1', role: 'reviewer' } } },
    user, { name: 'wt-pack-worker-07', pane: 'w7:p1' })
  await d.tick(); await d.tick()
  assert.notEqual((await tickets.get(t.id)).pair?.buddy?.name, 'wt-pack-qa-reviewer-01')
})

test('WP-221 reconcile: an assignee whose claude exited (status exited) counts as gone → Ready', async () => {
  const dead = { name: 'wt-pack-worker-07', local: true, status: 'exited', id: 'w7:p1' }
  const { tickets, d } = await setup({ agents: [dead] })
  await tickets.setSettings('wt-pack', { dispatch: false })
  const t = await tickets.create('wt-pack', { title: 'a', column: 'building' }, user)
  await tickets.patch(t.id, {}, user, { name: 'wt-pack-worker-07', pane: 'w7:p1' })
  await d.tick()
  await d.tick()
  const T = await tickets.get(t.id)
  assert.deepEqual([T.column, T.assignee], ['ready', null])
})
