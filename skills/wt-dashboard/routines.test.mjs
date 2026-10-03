import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { open } from './store.mjs'
import { Routines, parseSchedule, nextRun, preview } from './routines.mjs'

const tz = (zone, fn) => () => { const was = process.env.TZ; process.env.TZ = zone; try { fn() } finally { process.env.TZ = was } }
const iso = (d) => d.toISOString()
const mem = () => open(join(mkdtempSync(join(tmpdir(), 'routines-')), 'wt.db'), { log: () => {} }) // fresh db per test

// Fake world: agents list, calls recorded.
function world(over = {}) {
  const calls = { prompt: [], spawn: [], remove: [], actions: [] }
  const w = {
    list: [], pressure: 'normal', calls,
    deps: {
      agents: async () => w.list,
      host: async () => ({ pressure: w.pressure }),
      prompt: async (a, text, o) => { calls.prompt.push([a.name, text]); calls.promptOpts = o },
      spawn: async (b) => { calls.spawn.push(b); w.list.push({ id: 'p9', name: 'aud-1', status: 'working' }); return { name: 'aud-1', pane: 'p9', prompted: true } },
      remove: async (pane, o) => { calls.remove.push([pane, o]); w.list = w.list.filter((a) => a.id !== pane) },
      actions: { housekeeping: async () => { calls.actions.push('hk'); return { summary: 'done' } }, 'jev-run': async () => ({ skipped: 'triage off' }) },
      ...over,
    },
  }
  return w
}
const setup = (over, opts = {}) => {
  const w = world(over)
  const r = new Routines({ db: mem(), deps: w.deps, log: () => {}, pollMs: 5, ...opts })
  return { w, r }
}
const HK = { name: 'hk', schedule: 'every 30m', target: { kind: 'action', action: 'housekeeping' }, enabled: true }

test('every: next run is N after', () => {
  assert.equal(+nextRun('every 30m', new Date(0)), 30 * 60_000)
  assert.equal(+nextRun('every 2h', new Date(0)), 2 * 3_600_000)
  assert.equal(+nextRun('every 1d', new Date(0)), 86_400_000)
})

test('cron in Asia/Jakarta: daily, step, weekly; on a slot → the next one', tz('Asia/Jakarta', () => {
  const at = new Date('2026-09-26T10:00:00+07:00') // a Saturday
  assert.equal(iso(nextRun('0 2 * * *', at)), '2026-09-26T19:00:00.000Z')
  assert.equal(iso(nextRun('*/15 * * * *', at)), '2026-09-26T03:15:00.000Z')
  assert.equal(iso(nextRun('0 9 * * 1', at)), '2026-09-28T02:00:00.000Z')
  assert.equal(iso(nextRun('0 2 * * *', new Date('2026-09-27T02:00:00+07:00'))), '2026-09-27T19:00:00.000Z')
}))

test('cron in America/New_York across DST spring-forward', tz('America/New_York', () => {
  // 2026-03-08 02:00 → 03:00: 02:30 does not exist that day, so the next 02:30 is the 9th (EDT).
  assert.equal(iso(nextRun('30 2 * * *', new Date('2026-03-08T01:00:00-05:00'))), '2026-03-09T06:30:00.000Z')
  assert.equal(iso(nextRun('0 3 * * *', new Date('2026-03-08T00:00:00-05:00'))), '2026-03-08T07:00:00.000Z')
}))

test('cron: dom and dow both restricted → either matches (Vixie)', tz('UTC', () => {
  // 2026-09-26 is a Saturday; '0 0 1 * 1' = the 1st or any Monday → Monday the 28th.
  assert.equal(iso(nextRun('0 0 1 * 1', new Date('2026-09-26T00:00:00Z'))), '2026-09-28T00:00:00.000Z')
  assert.equal(iso(nextRun('0 0 1,15 * *', new Date('2026-09-26T00:00:00Z'))), '2026-10-01T00:00:00.000Z')
}))

test('bad expressions throw 400', () => {
  for (const s of ['', 'every 0m', 'every 5x', '* * * *', '60 * * * *', '* 24 * * *', '*/0 * * * *', '5-1 * * * *', 'a b c d e'])
    assert.throws(() => parseSchedule(s), (e) => e.status === 400, s)
  assert.throws(() => nextRun('0 0 31 2 *'), /never fires/)
})

test('no seeds: a new install starts with no routines (WP-92)', () => {
  assert.deepEqual(setup().r.list(), [])
})

test('catch-up: next_run 5h in the past → exactly one run, next_run > now', async () => {
  const { w, r } = setup()
  const now = Date.now()
  const x = r.create(HK, now - 6 * 3_600_000)
  r.db.prepare('UPDATE routines SET next_run = ? WHERE id = ?').run(now - 5 * 3_600_000, x.id)
  await r.tick(now); await r.idle()
  await r.tick(now + 1000); await r.idle()
  assert.equal(w.calls.actions.length, 1)
  assert.ok(r.get(x.id).next_run > now)
  assert.equal(r.runs()[0].status, 'ok')
  r.delete(x.id)
  assert.equal(r.runs()[0].name, 'hk') // history keeps the name
})

test('two concurrent ticks → one run', async () => {
  const { w, r } = setup()
  const x = r.create(HK)
  r.db.prepare('UPDATE routines SET next_run = 0 WHERE id = ?').run(x.id)
  await Promise.all([r.tick(), r.tick()]); await r.idle()
  assert.equal(w.calls.actions.length, 1)
  assert.equal(r.runs().filter((u) => u.routine_id === x.id).length, 1)
})

test('overlap: a running run → skipped', async () => {
  const { r } = setup({ actions: { housekeeping: () => new Promise(() => {}) } })
  const x = r.create({ ...HK, timeout_min: 0.0005 })
  await r.runNow(x.id)
  const u = await r.runNow(x.id)
  assert.equal(u.status, 'skipped')
  assert.match(u.reason, /still going/)
  await r.idle()
})

test('cap: working agents + an open spawn not yet working ≥ maxWorking → skipped', async () => {
  const { w, r } = setup({ spawn: () => new Promise(() => {}) })
  r.setSettings({ maxWorking: 2 })
  w.list = [{ id: 'p1', name: 'a', status: 'working' }]
  const sp = r.create({ name: 's', schedule: 'every 1h', target: { kind: 'spawn', role: 'auditor', project: 'x', prompt: '/wt-audit' } })
  assert.equal((await r.runNow(sp.id)).status, 'running') // 1 working + 0 pending < 2
  const pr = r.create({ name: 'p', schedule: 'every 1h', target: { kind: 'prompt', agent: 'b', text: 'hi' } })
  const u = await r.runNow(pr.id)
  assert.equal(u.status, 'skipped')
  assert.match(u.reason, /^cap: 2/)
})

test('prompt: idle agent prompted; busy → skipped; none → skipped', async () => {
  const { w, r } = setup()
  const x = r.create({ name: 'p', schedule: 'every 1h', target: { kind: 'prompt', role: 'orchestrator', project: 'wt-pack', text: 'digest' } })
  assert.equal((await r.runNow(x.id)).reason, 'no agent')
  w.list = [{ id: 'p1', name: 'orch', pool: 'orchestrator', project: 'wt-pack', status: 'working' }]
  assert.equal((await r.runNow(x.id)).reason, 'agent busy')
  w.list[0].status = 'idle'
  await r.runNow(x.id); await r.idle()
  assert.deepEqual(w.calls.prompt, [['orch', 'digest']])
  assert.equal(r.runs()[0].status, 'ok')
})

test('memory pressure critical → skipped; warn runs', async () => {
  const { w, r } = setup()
  const x = r.create(HK)
  w.pressure = 'critical'
  assert.equal((await r.runNow(x.id)).reason, 'memory pressure critical')
  w.pressure = 'warn'
  await r.runNow(x.id); await r.idle()
  assert.equal(r.runs()[0].status, 'ok')
})

test('spawn: finishes → removed with force; timeout → removed with force, status timeout', async () => {
  const { w, r } = setup()
  const x = r.create({ name: 's', schedule: 'every 1h', target: { kind: 'spawn', role: 'auditor', project: 'x', prompt: '/wt-audit' } })
  await r.runNow(x.id)
  setTimeout(() => { w.list[0].status = 'idle' }, 20)
  await r.idle()
  assert.deepEqual(w.calls.remove, [['p9', { force: true }]])
  assert.equal(r.runs()[0].status, 'ok')
  r.update(x.id, { timeout_min: 0.0005 }) // 30ms; the agent stays working
  await r.runNow(x.id); await r.idle()
  assert.equal(r.runs()[0].status, 'timeout')
  assert.equal(w.calls.remove.length, 2)
  assert.deepEqual(w.calls.remove[1][1], { force: true })
})

test('spawn: blocked is not finished; idle before ever working is not finished; prompt not delivered fails', async () => {
  const { w, r } = setup()
  const x = r.create({ name: 's', schedule: 'every 1h', timeout_min: 0.001, target: { kind: 'spawn', role: 'auditor', project: 'x', prompt: '/wt-audit' } })
  w.deps.spawn = async () => { w.list.push({ id: 'p9', name: 'aud-1', status: 'blocked' }); return { name: 'aud-1', pane: 'p9', prompted: true } }
  await r.runNow(x.id); await r.idle()
  assert.equal(r.runs()[0].status, 'timeout')
  w.list = []; w.deps.spawn = async () => { w.list.push({ id: 'p9', name: 'aud-1', status: 'idle' }); return { name: 'aud-1', pane: 'p9', prompted: true } }
  await r.runNow(x.id); await r.idle()
  assert.equal(r.runs()[0].status, 'timeout')
  w.list = []; w.deps.spawn = async () => ({ name: 'aud-1', pane: 'p9', prompted: false })
  await r.runNow(x.id); await r.idle()
  assert.deepEqual([r.runs()[0].status, r.runs()[0].reason], ['failed', 'prompt not delivered'])
})

test('action: timeout, and a skipped result', async () => {
  const { r } = setup({ actions: { housekeeping: () => new Promise(() => {}), 'jev-run': async () => ({ skipped: 'triage off' }) } })
  const x = r.create({ ...HK, timeout_min: 0.0005 })
  await r.runNow(x.id); await r.idle()
  assert.equal(r.runs()[0].status, 'timeout')
  const j = r.create({ name: 'j', schedule: 'every 1h', target: { kind: 'action', action: 'jev-run', project: 'wt-pack' } })
  await r.runNow(j.id); await r.idle()
  assert.deepEqual([r.runs()[0].status, r.runs()[0].reason], ['skipped', 'triage off'])
})

test('action: a timed-out action still running blocks the next run of that action, from any routine', async () => {
  let finish
  const { r } = setup({ actions: { housekeeping: () => new Promise((res) => { finish = res }) } })
  const x = r.create({ ...HK, timeout_min: 0.0005 }), y = r.create({ ...HK, name: 'hk2' })
  await r.runNow(x.id); await r.idle()
  assert.equal(r.runs()[0].status, 'timeout')
  await r.runNow(y.id)
  assert.deepEqual([r.runs()[0].status, r.runs()[0].reason], ['skipped', 'housekeeping still running'])
  finish({ summary: 'late' }); await new Promise((res) => setTimeout(res, 0))
  await r.runNow(x.id); finish({ summary: 'ok' }); await r.idle()
  assert.equal(r.runs()[0].status, 'ok')
})

test('startup cleanup: orphaned spawn run → agent removed, run failed', async () => {
  const { w, r } = setup()
  r.db.prepare("INSERT INTO routine_runs (routine_id, started, status, agent, kind) VALUES ('seed-audit', 1, 'running', 'p7', 'spawn'), ('seed-digest', 1, 'running', 'orch', 'prompt')").run()
  await r.recover()
  assert.deepEqual(w.calls.remove, [['p7', { force: true }]])
  assert.ok(r.runs().every((u) => u.status === 'failed' && u.reason === 'server restarted'))
})

test('Run now leaves next_run alone; enabling resets it from now', async () => {
  const { r } = setup()
  const x = r.create(HK)
  await r.runNow(x.id); await r.idle()
  assert.equal(r.get(x.id).next_run, x.next_run)
  r.update(x.id, { enabled: false })
  const now = Date.now() + 3_600_000
  assert.equal(r.update(x.id, { enabled: true }, now).next_run, now + 30 * 60_000)
})

test('runs older than 30 days are pruned on tick', async () => {
  const { r } = setup()
  r.db.prepare("INSERT INTO routine_runs (routine_id, started, status) VALUES ('x', ?, 'ok'), ('x', ?, 'ok')").run(Date.now() - 31 * 86_400_000, Date.now())
  await r.tick()
  assert.equal(r.runs().length, 1)
})

test('validation: bad schedule, target and timeout → 400', () => {
  const { r } = setup()
  for (const b of [{ ...HK, schedule: 'nope' }, { ...HK, target: { kind: 'shell' } }, { ...HK, target: { kind: 'spawn', role: 'a' } }, { ...HK, timeout_min: 0 }, { ...HK, name: '' }])
    assert.throws(() => r.create(b), (e) => e.status === 400)
  assert.throws(() => r.setSettings({ maxWorking: -1 }), (e) => e.status === 400)
})

test('deliver (WP-54): defaults by kind for old rows; self → Inbox; room → one post; failure → Inbox too; skip → nothing', async () => {
  const got = { notify: [], post: [] }
  const { w, r } = setup({ notify: async (n) => { got.notify.push(n) }, post: async (room, text) => { got.post.push([room, text]) } })
  const hk = r.create(HK)
  assert.deepEqual(hk.target.deliver, { to: 'none' })
  r.db.prepare('UPDATE routines SET target = ? WHERE id = ?').run(JSON.stringify({ kind: 'prompt', agent: 'orch', text: 'x' }), hk.id) // pre-WP-54 row
  assert.deepEqual(r.get(hk.id).target.deliver, { to: 'self' })
  r.update(hk.id, { target: { ...HK.target, deliver: { to: 'none' } } })
  await r.runNow(hk.id); await r.idle()
  assert.equal(got.notify.length + got.post.length, 0) // none + ok → silent
  const x = r.create({ ...HK, name: 'toRoom', target: { ...HK.target, deliver: { to: 'room', room: 'wt-pack' } } })
  await r.runNow(x.id); await r.idle()
  assert.deepEqual(got.post, [['wt-pack', 'toRoom: ok — done']])
  w.deps.actions.housekeeping = async () => { throw new Error('boom') }
  await r.runNow(x.id); await r.idle()
  assert.equal(got.post.length, 2); assert.equal(got.notify.length, 1); assert.equal(got.notify[0].error, true)
  const p = r.create({ name: 'p', schedule: 'every 1h', target: { kind: 'prompt', agent: 'orch', text: 'x' } })
  await r.runNow(p.id) // no agent → skipped, not reported
  w.list = [{ id: 'p1', name: 'orch', status: 'idle' }]
  await r.runNow(p.id); await r.idle()
  assert.equal(got.notify.length, 2); assert.equal(got.notify[1].error, false)
  r.update(x.id, { target: HK.target }) // no deliver → kept
  assert.deepEqual(r.get(x.id).target.deliver, { to: 'room', room: 'wt-pack' })
  for (const d of [{ to: 'room' }, { to: 'mail' }]) assert.throws(() => r.create({ ...HK, target: { ...HK.target, deliver: d } }), (e) => e.status === 400)
})

test('preview: next 3 slots', tz('UTC', () => {
  assert.deepEqual(preview('0 9 * * 1', 3, new Date('2026-09-26T00:00:00Z')).map(iso), ['2026-09-28T09:00:00.000Z', '2026-10-05T09:00:00.000Z', '2026-10-12T09:00:00.000Z'])
  assert.throws(() => preview('nope'), (e) => e.status === 400)
}))

test('routine sends name themselves (WP-104): prompt gets { routine }, spawn gets tag kind=routine', async () => {
  const { w, r } = setup()
  w.list.push({ id: 'p1', name: 'orch', status: 'idle', pool: 'orchestrator', project: 'x' })
  const p = r.create({ name: 'Digest', schedule: 'every 1h', target: { kind: 'prompt', agent: 'orch', text: 'digest' } })
  await r.runNow(p.id); await r.idle()
  assert.deepEqual(w.calls.promptOpts, { routine: 'Digest' })
  const s = r.create({ name: 'Audit', schedule: 'every 1h', target: { kind: 'spawn', role: 'auditor', project: 'x', prompt: '/wt-audit' } })
  await r.runNow(s.id)
  setTimeout(() => { w.list.find((a) => a.id === 'p9').status = 'idle' }, 20)
  await r.idle()
  assert.deepEqual(w.calls.spawn.at(-1).tag, { kind: 'routine', from: 'Audit' })
})

test('WP-205: a role-based routine pick skips a persona agent; naming it still works', async () => {
  const { w, r } = setup()
  w.list = [{ id: 'p1', name: 'fe-worker', pool: 'worker', project: 'wt-pack', status: 'idle', paneTokens: { persona: 'frontend-worker' } }]
  const by = r.create({ name: 'p', schedule: 'every 1h', target: { kind: 'prompt', role: 'worker', project: 'wt-pack', text: 'x' } })
  assert.equal((await r.runNow(by.id)).reason, 'no agent')
  const named = r.create({ name: 'q', schedule: 'every 1h', target: { kind: 'prompt', agent: 'fe-worker', text: 'y' } })
  await r.runNow(named.id); await r.idle()
  assert.deepEqual(w.calls.prompt, [['fe-worker', 'y']])
})
