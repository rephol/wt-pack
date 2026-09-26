// Run: node --test dispatch.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Tickets } from './tickets.mjs'
import { Dispatch, mergeIds, dispatchPrompt } from './dispatch.mjs'

const user = { name: 'Rep' }
const tagTicket = (a) => a.tags?.ticket ?? null

async function setup({ agents = [], pressure = 'normal', max = 4, handoff, merges = '', pending = 0, triageOn, room = null } = {}) {
  const tickets = new Tickets({ dir: await mkdtemp(join(tmpdir(), 'dispatch-')) })
  await tickets.board('wt-pack')
  await tickets.setSettings('wt-pack', { dispatch: true })
  const calls = []
  const d = new Dispatch({
    tickets, log: () => {},
    deps: {
      agents: async () => agents, host: async () => ({ pressure }), maxWorking: () => max, pending: () => pending,
      repoOf: async () => '/repo', roomOf: async (p) => (room && p === 'wt-pack' ? room : null), ticketOf: tagTicket, triageOn: () => triageOn,
      git: async (repo, ...a) => a[0] === 'log' ? merges : a[0] === 'rev-parse' ? 'abc123\n' : '',
      handoff: async (args, prompt, cwd) => {
        calls.push({ args, prompt, cwd })
        return handoff ? handoff(args) : 'created wt-pack-worker-09 w9:p1\ntarget wt-pack-worker-09 w9:p1 — x\nreach: …\n'
      },
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

test('dispatchPrompt: worker and planner report to the project room when there is one (WP-74)', () => {
  const t = { id: 'WP-9', title: 'x' }
  for (const role of ['worker', 'planner']) {
    assert.match(dispatchPrompt(t, role, 'wt-pack'), /post a one-line result in #wt-pack with `room post wt-pack "…"`, and still reply to the sender/)
    assert.doesNotMatch(dispatchPrompt(t, role), /room post/)
  }
})

test('dispatch: the handoff prompt names the room of the board project (WP-74)', async () => {
  const { tickets, d, calls } = await setup({ room: 'wt-pack' })
  await ready(tickets, 'a')
  await d.tick()
  assert.match(calls[0].prompt, /room post wt-pack/)
})
