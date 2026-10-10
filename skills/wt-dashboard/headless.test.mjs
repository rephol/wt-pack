// WP-293 U1: the headless supervisor against a FAKE claude (test-fixtures/fake-claude.mjs). Temp db, temp cwd, no real dashboard,
// no real agent. Run: node --test headless.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_PLUGINS, contextWindowOf, defaultName, Headless } from './headless.mjs'

const FAKE = join(import.meta.dirname, 'test-fixtures', 'fake-claude.mjs')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, what = 'condition', ms = 6000) {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error('timed out waiting for ' + what)
    await sleep(10)
  }
}

// A supervisor over a temp db. `clock` is a fake `now` the test advances (tick/idle/stuck math); real timers stay short.
async function setup(t, o = {}, dirName = 'work') {
  const dir = await mkdtemp(join(tmpdir(), 'hl-'))
  const cwd = join(dir, dirName); await mkdir(cwd)
  const clock = { v: 1_000_000 }
  const changes = []
  const h = Headless.open(join(dir, 'wt.db'), { cmd: FAKE, graceMs: 80, now: () => clock.v, log: () => {}, env: { HOME: process.env.HOME, PATH: process.env.PATH }, onChange: (id, what) => changes.push([id, what]), ...o })
  t.after(async () => { h.shutdown(); await until(() => h.procs.size === 0, 'children gone').catch(() => {}); h.db.close() })
  const start = (prompt, extra = {}) => h.spawn({ role: 'worker', cwd, prompt, ...extra })
  const state = (id) => h.get(id).state
  const events = (id) => h.events(id, 0, 2000).events
  const types = (id) => events(id).map((e) => e.type)
  const results = (id) => events(id).filter((e) => e.type.startsWith('result')).map((e) => e.event.result)
  return { h, dir, cwd, clock, changes, start, state, events, types, results }
}

test('spawn runs a prompt, records the session, ends idle; init facts land on the row', async (t) => {
  const { h, start, results, events } = await setup(t)
  const r = start('hello')
  await until(() => h.get(r.id).state === 'idle', 'idle')
  const row = h.get(r.id)
  assert.match(row.session, /^sess-/)
  assert.equal(row.turns, 1)
  assert.equal(row.cost_usd, 0.01)
  assert.deepEqual(JSON.parse(row.plugins), ['fake'])
  assert.equal(row.context_window, 1_000_000) // WP-314: the reported window of the run's own model, not a guess
  assert.equal(row.init_model, 'claude-fake-1') // WP-300
  assert.deepEqual(JSON.parse(row.init_commands), { slash_commands: ['compact', 'wt-ask'], skills: ['wt-ask'] })
  assert.deepEqual(results(r.id), ['echo: hello'])
  const init = events(r.id).find((e) => e.type === 'system/init').event
  assert.ok(init.argv.includes('--permission-prompt-tool') && init.argv.includes('stdio'))
  assert.ok(!init.argv.includes('--permission-mode')) // WP-300: no forced mode; the user's settings apply
  assert.equal(row.pid > 0, true)
  assert.equal(h.live().length, 1)
})

test('a run with no prompt idles after nothing; a message then works it', async (t) => {
  const { h, start, results } = await setup(t)
  const r = start(undefined)
  await until(() => h.get(r.id).state === 'idle' && h.get(r.id).pid, 'idle') // WP-305: no init until a turn, but not 'starting' forever
  h.message(r.id, 'first')
  await until(() => h.get(r.id).state === 'idle', 'idle')
  h.message(r.id, 'second')
  await until(() => h.get(r.id).turns === 2, 'second turn')
  assert.deepEqual(results(r.id), ['echo: first', 'echo: second'])
})

test('global cap holds extra spawns queued; slots free FIFO', async (t) => {
  const { h, start, state } = await setup(t, { cap: 2 })
  const a = start('one'), b = start('two'), c = start('three'), d = start('four')
  await until(() => state(a.id) === 'idle' && state(b.id) === 'idle', 'a,b idle')
  assert.equal(state(c.id), 'queued'); assert.equal(state(d.id), 'queued')
  assert.equal(h.live().length, 2)
  h.stop(a.id)
  await until(() => state(a.id) === 'ended', 'a ended')
  await until(() => state(c.id) === 'idle', 'c (oldest queued) started')
  assert.equal(state(d.id), 'queued') // d waits for the next free slot
  assert.equal(h.live().length, 2)
  h.stop(b.id)
  await until(() => state(d.id) === 'idle', 'd started')
})

test('a queued run cancelled before its turn never starts and does not hold a slot', async (t) => {
  const { h, start, state } = await setup(t, { cap: 1 })
  const a = start('HANG'), b = start('b'), c = start('c')
  await until(() => state(a.id) === 'working', 'a working')
  assert.equal(h.stop(b.id).state, 'ended')
  assert.equal(h.get(b.id).reason, 'cancelled while queued')
  h.stop(a.id)
  await until(() => state(c.id) === 'idle', 'c took the slot')
  assert.equal(state(b.id), 'ended')
  assert.equal(h.live().length, 1)
})

test('a process that fails to spawn fails its run and frees the slot for the queue', async (t) => {
  const { h, start, state } = await setup(t, { cap: 1, cmd: '/nonexistent/claude-binary' })
  const a = start('a'), b = start('b')
  await until(() => state(a.id) === 'failed' && state(b.id) === 'failed', 'both failed')
  assert.match(h.get(a.id).reason, /spawn/)
  assert.equal(h.live().length, 0)
  assert.equal(h.procs.size, 0)
})

test('idle release stops an idle run after idleMs, never a working one', async (t) => {
  const { h, start, state, clock } = await setup(t, { idleMs: 60_000, stuckMs: 10 * 60_000 })
  const idle = start('quick'), busy = start('HANG')
  await until(() => state(idle.id) === 'idle' && state(busy.id) === 'working', 'idle + working')
  clock.v += 30_000
  assert.deepEqual(h.tick(), [])
  clock.v += 40_000
  assert.deepEqual(h.tick(), [['idle', idle.id]])
  await until(() => state(idle.id) === 'ended', 'idle run ended')
  assert.match(h.get(idle.id).reason, /idle release/)
  assert.equal(state(busy.id), 'working')
})

test('defaults are settings: cap 0 (unlimited), idle off, stuckAction flag, resumes 3; env overrides; options win', async (t) => {
  const { h } = await setup(t)
  assert.deepEqual([h.cap, h.stuckAction, h.resumes, h.idleMs], [0, 'flag', 3, 0])
  const env = { WT_HEADLESS_CAP: '4', WT_HEADLESS_STUCK_ACTION: 'kill', WT_HEADLESS_RESUMES: '3' }
  const e = new Headless({ db: h.db, env })
  assert.deepEqual([e.cap, e.stuckAction, e.resumes], [4, 'kill', 3])
  const o = new Headless({ db: h.db, env, cap: 1, stuckAction: 'interrupt', resumes: 0 })
  assert.deepEqual([o.cap, o.stuckAction, o.resumes], [1, 'interrupt', 0])
  assert.throws(() => new Headless({ db: h.db, env: {}, stuckAction: 'nuke' }), /stuckAction/)
  assert.equal(new Headless({ db: h.db, env: { WT_HEADLESS_CAP: 'x' } }).cap, 0)
})

test('stuckAction flag (default): a stuck turn is flagged only, never interrupted or killed; output clears the flag', async (t) => {
  const { h, start, state, clock, events } = await setup(t, { stuckMs: 60_000, graceMs: 80 })
  const r = start('HANG')
  await until(() => state(r.id) === 'working', 'working')
  clock.v += 61_000
  assert.deepEqual(h.tick(), [['stuck-flag', r.id]])
  assert.equal(h.get(r.id).stuck, clock.v)
  assert.ok(events(r.id).some((e) => e.event.subtype === 'stuck' && e.event.action === 'flag'))
  clock.v += 10_000
  assert.deepEqual(h.tick(), []) // no repeat, no kill past the grace
  await sleep(150)
  assert.equal(state(r.id), 'working')
  assert.ok(!events(r.id).some((e) => e.event.subtype === 'interrupt'))
  h.interrupt(r.id) // the human acts; the fake answers
  await until(() => state(r.id) === 'idle', 'idle')
  assert.equal(h.get(r.id).stuck, null)
})

test('stuck turn: watchdog interrupts first; the turn recovers', async (t) => {
  const { h, start, state, clock, results } = await setup(t, { stuckMs: 60_000, idleMs: 3_600_000, stuckAction: 'interrupt' })
  const r = start('HANG')
  await until(() => state(r.id) === 'working', 'working')
  clock.v += 61_000
  assert.deepEqual(h.tick(), [['stuck-interrupt', r.id]])
  await until(() => state(r.id) === 'idle', 'interrupted turn finished')
  assert.deepEqual(results(r.id), ['interrupted'])
  assert.deepEqual(h.tick(), []) // idle again: nothing more to do
})

test('stuck turn that ignores the interrupt is stopped after the grace, by the recorded pid', async (t) => {
  const { h, start, state, clock } = await setup(t, { stuckMs: 60_000, graceMs: 80, stuckAction: 'kill' })
  const kills = []
  const realKill = process.kill
  process.kill = (pid, sig) => { kills.push([pid, sig]); return realKill.call(process, pid, sig) }
  t.after(() => { process.kill = realKill })
  const r = start('DEAF')
  await until(() => state(r.id) === 'working', 'working')
  const pid = h.get(r.id).pid
  clock.v += 61_000
  assert.deepEqual(h.tick(), [['stuck-interrupt', r.id]])
  assert.deepEqual(h.tick(), []) // inside the grace window: wait
  clock.v += 1_000
  assert.deepEqual(h.tick(), [['stuck-kill', r.id]])
  await until(() => state(r.id) === 'ended', 'killed')
  assert.match(h.get(r.id).reason, /stuck turn/)
  assert.deepEqual(kills.filter(([p]) => p !== 0), [[pid, 'SIGTERM']]) // only the recorded pid, never a pattern or group
  assert.equal(h.get(r.id).pid, null)
})

test('output after the interrupt resets the stuck watchdog (no instant kill on the next stall)', async (t) => {
  const { h, start, state, clock } = await setup(t, { stuckMs: 60_000, graceMs: 80, stuckAction: 'kill' })
  const r = start('HANG')
  await until(() => state(r.id) === 'working', 'working')
  clock.v += 61_000
  h.tick() // interrupt; the fake answers with a result -> idle
  await until(() => state(r.id) === 'idle', 'idle')
  h.message(r.id, 'HANG again')
  await until(() => state(r.id) === 'working' && h.procs.get(r.id).inflight > 0, 'working again')
  await until(() => h.events(r.id, 0).events.some((e) => e.event.turn === 2), 'second turn init')
  clock.v += 61_000
  assert.deepEqual(h.tick(), [['stuck-interrupt', r.id]]) // interrupt again, not stuck-kill
})

test('resumes N: crash mid-turn resumes by session id; after N resumes the run fails', async (t) => {
  const { h, start, state, events } = await setup(t, { resumes: 2 })
  const r = start('CRASH please')
  await until(() => h.get(r.id).resumes === 1 && state(r.id) === 'idle', 'resumed once and finished')
  const inits = events(r.id).filter((e) => e.type === 'system/init').map((e) => e.event)
  assert.equal(inits.length, 2)
  assert.equal(inits[1].resumed, true)
  assert.equal(inits[1].session_id, inits[0].session_id) // same session
  assert.ok(inits[1].argv.includes(inits[0].session_id))
  assert.ok(events(r.id).some((e) => e.event.subtype === 'crash_resume'))

  const c = await setup(t, { resumes: 2 }, 'x-crashy') // crashes on every turn
  const f = c.start('anything')
  await until(() => c.state(f.id) === 'failed', 'failed after max resumes')
  const row = c.h.get(f.id)
  assert.equal(row.resumes, 2)
  assert.equal(c.events(f.id).filter((e) => e.event.subtype === 'crash_resume').length, 2)
  assert.match(row.reason, /process ended/)
  assert.equal(c.h.live().length, 0)
})

test('resumes 0: a crash mid-turn fails the run with the reason; resume stays manual', async (t) => {
  const { h, start, state, events, results } = await setup(t, { resumes: 0 })
  assert.equal(h.resumes, 0)
  const r = start('CRASH now')
  await until(() => state(r.id) === 'failed', 'failed')
  assert.match(h.get(r.id).reason, /process ended: exit 1/)
  assert.equal(h.get(r.id).resumes, 0)
  assert.ok(!events(r.id).some((e) => e.event.subtype === 'crash_resume'))
  h.resume(r.id, 'carry on')
  await until(() => state(r.id) === 'idle', 'manual resume')
  assert.deepEqual(results(r.id), ['echo: carry on'])
})

test('a stopped run is not treated as a crash; stop() of an ended run is a no-op', async (t) => {
  const { h, start, state, events } = await setup(t)
  const r = start('hi')
  await until(() => state(r.id) === 'idle', 'idle')
  h.stop(r.id, 'because')
  await until(() => state(r.id) === 'ended', 'ended')
  assert.equal(h.get(r.id).reason, 'because')
  assert.equal(h.get(r.id).resumes, 0)
  const before = { n: events(r.id).length, ended: h.get(r.id).ended, reason: h.get(r.id).reason }
  const again = h.stop(r.id, 'second stop')
  assert.equal(again.state, 'ended')
  await sleep(150) // a stray kill timer would fire by now
  assert.deepEqual({ n: events(r.id).length, ended: h.get(r.id).ended, reason: h.get(r.id).reason }, before)
  assert.throws(() => h.stop('hl-nope'), /unknown/)
})

test('message to an ended run resumes it from the session id', async (t) => {
  const { h, start, state, events, results } = await setup(t)
  const r = start('one')
  await until(() => state(r.id) === 'idle', 'idle')
  const session = h.get(r.id).session
  h.stop(r.id)
  await until(() => state(r.id) === 'ended', 'ended')
  h.message(r.id, 'two')
  await until(() => state(r.id) === 'idle' && h.get(r.id).turns === 2, 'resumed turn')
  assert.deepEqual(results(r.id), ['echo: one', 'echo: two'])
  const init = events(r.id).filter((e) => e.type === 'system/init').at(-1).event
  assert.equal(init.session_id, session)
  assert.equal(init.argv[init.argv.indexOf('--resume') + 1], session)
})

test('tool request from a normal role becomes an open ask; allow answers the child', async (t) => {
  const { h, start, state, results, changes } = await setup(t)
  const r = start('TOOL:Bash')
  const ask = await until(() => h.get(r.id).asks[0], 'open ask')
  assert.equal(ask.tool, 'Bash'); assert.equal(ask.input.command, 'echo hi')
  assert.ok(changes.some(([, w]) => w === 'ask'))
  h.answer(r.id, ask.id, { allow: true })
  await until(() => state(r.id) === 'idle', 'turn finished')
  assert.deepEqual(results(r.id), ['Bash -> allow'])
  assert.equal(h.get(r.id).asks.length, 0)
  assert.throws(() => h.answer(r.id, ask.id, { allow: true }), (e) => e.status === 404) // already answered
})

test('deny answers the child with deny; AskUserQuestion needs real answers', async (t) => {
  const { h, start, state, results } = await setup(t)
  const a = start('TOOL:Edit')
  const ask = await until(() => h.get(a.id).asks[0], 'tool ask')
  h.answer(a.id, ask.id, { allow: false, message: 'no' })
  await until(() => state(a.id) === 'idle', 'idle')
  assert.deepEqual(results(a.id), ['Edit -> deny'])

  const q = start('ASK')
  const qa = await until(() => h.get(q.id).asks[0], 'question ask')
  assert.equal(qa.tool, 'AskUserQuestion')
  assert.throws(() => h.answer(q.id, qa.id, {}), (e) => e.status === 400)
  assert.throws(() => h.answer(q.id, qa.id, { answers: { 'Not asked?': 'A' } }), (e) => e.status === 400)
  assert.throws(() => h.answer(q.id, qa.id, { answers: { 'Which?': 5 } }), (e) => e.status === 400)
  assert.equal(h.get(q.id).asks.length, 1) // bad answers leave it open
  h.answer(q.id, qa.id, { answers: { 'Which?': 'B' } })
  await until(() => state(q.id) === 'idle', 'idle')
  assert.match(results(q.id)[0], /"behavior":"allow".*"answers":\{"Which\?":"B"\}/)
})

test('open asks expire with a reason when the process ends', async (t) => {
  const { h, start, state } = await setup(t)
  const r = start('TOOL:Bash')
  const ask = await until(() => h.get(r.id).asks[0], 'open ask')
  h.stop(r.id, 'user stop')
  await until(() => state(r.id) === 'ended', 'ended')
  const row = h.db.prepare('SELECT state, note FROM headless_asks WHERE id = ?').get(ask.id)
  assert.equal(row.state, 'expired')
  assert.match(row.note, /process ended/)
  assert.equal(h.get(r.id).asks.length, 0)
  assert.throws(() => h.answer(r.id, ask.id, { allow: true }), (e) => e.status === 404)
})

test('readonly role: Read allowed automatically, Bash denied, no human ask; AskUserQuestion still asks', async (t) => {
  const { h, start, state, results } = await setup(t, { cap: 3 })
  const read = h.spawn({ role: 'reviewer', cwd: (await mkdtemp(join(tmpdir(), 'hl-ro-'))), prompt: 'TOOL:Read' })
  await until(() => state(read.id) === 'idle', 'idle')
  assert.deepEqual(results(read.id), ['Read -> allow'])
  assert.equal(h.get(read.id).asks.length, 0)
  const bash = h.spawn({ role: 'auditor', cwd: (await mkdtemp(join(tmpdir(), 'hl-ro-'))), prompt: 'TOOL:Bash' })
  await until(() => state(bash.id) === 'idle', 'idle')
  assert.deepEqual(results(bash.id), ['Bash -> deny'])
  assert.equal(h.get(bash.id).asks.length, 0)
  const q = h.spawn({ role: 'pr-watcher', cwd: (await mkdtemp(join(tmpdir(), 'hl-ro-'))), prompt: 'ASK' })
  const ask = await until(() => h.get(q.id).asks[0], 'question still reaches a human')
  assert.equal(ask.tool, 'AskUserQuestion')
})

test('send_file (WP-308): a read-only run gets only the wt-files MCP server; its tool is allowed, other MCP tools stay denied', async (t) => {
  const { h, events, state, results, cwd } = await setup(t, { cap: 3 })
  const r = h.spawn({ role: 'reviewer', cwd, prompt: 'TOOL:mcp__wt-files__send_file' })
  await until(() => state(r.id) === 'idle', 'idle')
  assert.deepEqual(results(r.id), ['mcp__wt-files__send_file -> allow'])
  const argv = events(r.id).find((e) => e.type === 'system/init').event.argv
  assert.ok(argv.includes('--strict-mcp-config'))
  const cfg = JSON.parse(argv[argv.indexOf('--mcp-config') + 1])
  assert.deepEqual(Object.keys(cfg.mcpServers), ['wt-files'])
  assert.equal(cfg.mcpServers['wt-files'].env.WT_MCP_ONLY, 'send_file')
  const d = h.spawn({ role: 'reviewer', cwd, prompt: 'TOOL:mcp__wt-files__ticket_list' })
  await until(() => state(d.id) === 'idle', 'idle')
  assert.deepEqual(results(d.id), ['mcp__wt-files__ticket_list -> deny'])
  const w = h.spawn({ role: 'worker', cwd, prompt: 'TOOL:mcp__wt__send_file' }) // an ask-policy role needs no human for it either
  await until(() => state(w.id) === 'idle', 'idle')
  assert.deepEqual(results(w.id), ['mcp__wt__send_file -> allow'])
  assert.equal(h.get(w.id).asks.length, 0)
})

test('events: store-assigned seq is unique and increasing; the after cursor pages without gaps', async (t) => {
  const { h, start, state } = await setup(t)
  const a = start('one'), b = start('two')
  await until(() => state(a.id) === 'idle' && state(b.id) === 'idle', 'both idle')
  const ea = h.events(a.id, 0), eb = h.events(b.id, 0)
  const seqs = ea.events.map((e) => e.seq)
  assert.deepEqual(seqs, [...seqs].sort((x, y) => x - y))
  assert.equal(new Set([...seqs, ...eb.events.map((e) => e.seq)]).size, seqs.length + eb.events.length) // no seq reused across runs
  assert.equal(ea.last, seqs.at(-1))
  const mid = seqs[2]
  assert.deepEqual(h.events(a.id, mid).events.map((e) => e.seq), seqs.filter((s) => s > mid))
  assert.deepEqual(h.events(a.id, ea.last).events, [])
  assert.deepEqual(h.events(a.id, 0, 2).events.map((e) => e.seq), seqs.slice(0, 2))
  h.message(a.id, 'three')
  await until(() => h.get(a.id).turns === 2, 'second turn')
  const fresh = h.events(a.id, ea.last).events
  assert.ok(fresh.length > 0 && fresh.every((e) => e.seq > ea.last)) // a client resumes from its last seq
})

test('events are bounded per run (KEEP_EVENTS) while seq keeps counting', async (t) => {
  const { h, start, state } = await setup(t)
  const r = start('FLOOD:2600')
  await until(() => state(r.id) === 'idle', 'flood done', 15000)
  const all = h.events(r.id, 0, 2000)
  const stored = h.db.prepare('SELECT count(*) n FROM headless_events WHERE run_id = ?').get(r.id).n
  assert.ok(stored <= 2000 + 100, `kept ${stored}`)
  assert.ok(stored >= 1900, `kept ${stored}`)
  assert.equal(all.last, h.db.prepare('SELECT MAX(seq) m FROM headless_events WHERE run_id = ?').get(r.id).m)
  assert.ok(all.events[0].seq > 600) // the oldest rows are gone, seq did not restart
  assert.ok(h.get(r.id).events > 2600) // the row's counter still counts everything
})

test('an oversized line is stubbed, not stored whole, and the stream recovers', async (t) => {
  const { h, start, state, results, events } = await setup(t)
  const r = start('BIG')
  await until(() => state(r.id) === 'idle', 'idle after big line')
  assert.deepEqual(results(r.id), ['big'])
  const rows = h.db.prepare('SELECT length(json) n, json FROM headless_events WHERE run_id = ?').all(r.id)
  assert.ok(rows.every((x) => x.n < 16 * 1024), 'no stored row is large')
  assert.ok(events(r.id).some((e) => e.event.subtype === 'oversized_line' || e.event.truncated), 'a stub marks the big line')
})

test('multi-byte characters split across chunks survive', async (t) => {
  const { h, start, state, events } = await setup(t)
  const r = start('SPLIT')
  await until(() => state(r.id) === 'idle', 'idle')
  const msg = events(r.id).find((e) => e.type === 'assistant' && JSON.stringify(e.event).includes('llo'))
  assert.ok(JSON.stringify(msg.event).includes('héllo wörld'))
})

test('the child gets a minimal env: no API key, no HERDR_*', async (t) => {
  const env = { ...process.env, ANTHROPIC_API_KEY: 'sk-test', ANTHROPIC_AUTH_TOKEN: 't', HERDR_PANE_ID: 'p1', HERDR_ENV: '1', SECRET_THING: 'x' }
  const { h, start, state, events } = await setup(t, { env })
  const r = start('env')
  await until(() => state(r.id) === 'idle', 'idle')
  const keys = events(r.id).find((e) => e.type === 'system/init').event.env
  assert.ok(keys.includes('PATH') && keys.includes('HOME'))
  assert.deepEqual(keys.filter((k) => /^(ANTHROPIC|HERDR|SECRET)/.test(k)), [])
  assert.ok(keys.length <= 6, keys.join(','))
})

test('interrupt goes over a control_request and ends the turn; not-working runs refuse', async (t) => {
  const { h, start, state, types, results } = await setup(t)
  const r = start('HANG')
  await until(() => state(r.id) === 'working', 'working')
  h.interrupt(r.id)
  await until(() => state(r.id) === 'idle', 'interrupted')
  assert.deepEqual(results(r.id), ['interrupted'])
  assert.ok(types(r.id).includes('control_response'))
  assert.throws(() => h.interrupt(r.id), (e) => e.status === 409)
  assert.throws(() => h.interrupt('hl-nope'), (e) => e.status === 404)
})

test('reconcile: runs left live by a previous server are resumed,  their asks expire, the recorded pid is signalled', async (t) => {
  const first = await setup(t)
  const r = first.start('TOOL:Bash')
  const ask = await until(() => first.h.get(r.id).asks[0], 'open ask')
  const pid = first.h.get(r.id).pid
  // "restart": a fresh supervisor over the same db that knows no processes
  const second = new Headless({ db: first.h.db, cmd: FAKE, log: () => {}, now: () => first.clock.v, graceMs: 80 })
  const out = await second.reconcile()
  assert.deepEqual(out, [r.id])
  const row = second.get(r.id)
  assert.match(row.reason ?? 'server restarted', /server restarted/)
  assert.ok(['queued', 'starting', 'working', 'idle'].includes(row.state)) // WP-304: resumed, not ended
  assert.equal(row.asks.length, 0)
  const a = first.h.db.prepare('SELECT state, note FROM headless_asks WHERE id = ?').get(ask.id)
  assert.equal(a.state, 'expired'); assert.match(a.note, /server restarted/)
  await until(() => { try { process.kill(pid, 0); return false } catch { return true } }, 'old child terminated') // it was a stream-json claude
  for (const p of second.procs.values()) p.child.kill() // the resumed child; shutdown() would skip it if first's exit handler ended the row
  await until(() => second.procs.size === 0, 'resumed child gone')
})

test('reconcile leaves a reused pid alone (a process that is not a stream-json claude)', async (t) => {
  const { h } = await setup(t)
  const bystander = spawn('sleep', ['30'], { stdio: 'ignore' })
  t.after(() => bystander.kill())
  await until(() => bystander.pid, 'bystander pid')
  const id = 'hl-reused'
  h.db.prepare(`INSERT INTO headless_runs (id, name, role, cwd, state, pid, created, last_event) VALUES (?, 'x', 'worker', '/tmp', 'working', ?, 1, 1)`).run(id, bystander.pid)
  assert.deepEqual(await h.reconcile(), [id])
  assert.equal(h.get(id).state, 'failed') // no session to resume
  process.kill(bystander.pid, 0) // still alive: throws otherwise
  assert.equal(bystander.exitCode, null)
})

test('reconcile keeps queued runs and starts them', async (t) => {
  const { h, state } = await setup(t, { cap: 1 })
  h.db.prepare(`INSERT INTO headless_runs (id, name, role, cwd, state, prompt, created, last_event) VALUES ('hl-q', 'q', 'worker', ?, 'queued', 'hi', 1, 1)`).run(tmpdir())
  await h.reconcile()
  await until(() => state('hl-q') === 'idle', 'queued run started after restart')
})

test('spawn validates its input; live row with no process can be stopped', async (t) => {
  const { h, cwd } = await setup(t)
  assert.throws(() => h.spawn({ role: 'bad role!', cwd }), (e) => e.status === 400)
  assert.throws(() => h.spawn({ role: 'worker', cwd: 'relative/path' }), (e) => e.status === 400)
  assert.throws(() => h.spawn({ role: 'worker', cwd, prompt: 'x'.repeat(100_001) }), (e) => e.status === 400)
  h.db.prepare(`INSERT INTO headless_runs (id, name, role, cwd, state, created, last_event) VALUES ('hl-orphan', 'o', 'worker', '/tmp', 'idle', 1, 1)`).run()
  assert.equal(h.stop('hl-orphan').state, 'ended')
})

test('rss reports resident memory of live processes', async (t) => {
  const { h, start, state } = await setup(t)
  const r = start('hi')
  await until(() => state(r.id) === 'idle', 'idle')
  const m = await h.rss()
  assert.ok(m[h.get(r.id).pid] > 0)
})

test('roles allowlist: only listed roles spawn; * or none = any', async (t) => {
  const { h, cwd } = await setup(t, { roles: ['pr-watcher'] })
  assert.throws(() => h.spawn({ role: 'worker', cwd }), (e) => e.status === 400 && /not enabled for headless/.test(e.message))
  assert.equal(h.spawn({ role: 'pr-watcher', cwd }).role, 'pr-watcher')
  const any = await setup(t, { roles: ['*'] })
  assert.equal(any.h.spawn({ role: 'worker', cwd: any.cwd }).role, 'worker')
})

test('permissionMode: passed through for a worker, validated, and a read-only role stays on default (WP-300)', async (t) => {
  const { h, events, cwd } = await setup(t)
  const w = h.spawn({ role: 'worker', cwd, prompt: 'hi', permissionMode: 'acceptEdits' })
  await until(() => events(w.id).some((e) => e.type === 'system/init'), 'init')
  const argv = events(w.id).find((e) => e.type === 'system/init').event.argv
  assert.equal(argv[argv.indexOf('--permission-mode') + 1], 'acceptEdits')
  assert.equal(h.get(w.id).req_permission_mode, 'acceptEdits')
  assert.throws(() => h.spawn({ role: 'worker', cwd, permissionMode: 'nope' }), /permissionMode/)
  assert.throws(() => h.spawn({ role: 'reviewer', cwd, permissionMode: 'bypassPermissions' }), /read-only/)
  const r = h.spawn({ role: 'reviewer', cwd, prompt: 'hi' })
  await until(() => events(r.id).some((e) => e.type === 'system/init'), 'init')
  const ra = events(r.id).find((e) => e.type === 'system/init').event.argv
  assert.equal(ra[ra.indexOf('--permission-mode') + 1], 'default')
  assert.equal(ra[ra.indexOf('--tools') + 1], 'Read,Grep,Glob,LS,NotebookRead,AskUserQuestion')
  assert.ok(ra.includes('--strict-mcp-config') && !argv.includes('--tools'))
})

test('cap 0 is unlimited: every spawn starts at once (WP-301)', async (t) => {
  const { h, start, state } = await setup(t)
  const ids = [start('a'), start('b'), start('c')].map((r) => r.id)
  await until(() => ids.every((id) => state(id) !== 'queued'), 'none queued')
})

test('reconcile resumes live runs with --resume (working and idle), fails one with no session or no resumes left (WP-304)', async (t) => {
  const first = await setup(t)
  const w = first.start('HANG'), i = first.start('hi')
  await until(() => first.state(i.id) === 'idle' && first.h.get(w.id).session, 'idle + working')
  const second = new Headless({ db: first.h.db, cmd: FAKE, log: () => {}, now: () => first.clock.v, graceMs: 80, resumes: 1 })
  first.h.db.prepare("INSERT INTO headless_runs (id, name, role, cwd, state, created, last_event) VALUES ('hl-nosess', 'n', 'worker', ?, 'working', 1, 1)").run(first.cwd)
  first.h.db.prepare("INSERT INTO headless_runs (id, name, role, cwd, session, state, resumes, created, last_event) VALUES ('hl-spent', 's', 'worker', ?, 'sess-x', 'idle', 1, 1, 1)").run(first.cwd)
  const wasWorking = first.h.get(w.id).session
  await second.reconcile()
  assert.match(second.get('hl-nosess').reason, /no session/); assert.equal(second.get('hl-nosess').state, 'failed')
  assert.match(second.get('hl-spent').reason, /resumes exhausted/); assert.equal(second.get('hl-spent').state, 'failed')
  await until(() => second.get(i.id).state === 'idle' && second.get(i.id).resumes === 1, 'idle run back with its process')
  for (const id of [w.id, i.id]) {
    const ev = second.events(id, 0, 2000).events
    assert.ok(ev.some((e) => e.type === 'supervisor' && e.event.subtype === 'resumed_after_restart'), 'run log says it resumed')
    assert.equal(ev.filter((e) => e.type === 'supervisor' && e.event.subtype === 'started').at(-1).event.resume, second.get(id).session ?? wasWorking)
  }
  for (const p of second.procs.values()) p.child.kill()
  await until(() => second.procs.size === 0, 'children gone')
})

test('defaultName: <repo>-<role>-NN, lowest unused, slugged and kept within 32 chars (WP-306)', () => {
  assert.equal(defaultName('wt-pack', 'worker', []), 'wt-pack-worker-01')
  assert.equal(defaultName('wt-pack', 'worker', ['wt-pack-worker-01', 'wt-pack-worker-03', 'other-worker-02']), 'wt-pack-worker-02')
  assert.equal(defaultName('My App.v2', 'Planner', []), 'my-app-v2-planner-01')
  const long = defaultName('a-very-long-repository-name', 'frontend-engineer', [])
  assert.ok(long.length <= 32 && long.endsWith('-frontend-engineer-01'), long)
})

test('a run is told its role and persona by env (WT_ROLE/WT_PERSONA); a bad persona is refused (WP-307)', async (t) => {
  const { h, cwd, events } = await setup(t)
  const r = h.spawn({ role: 'planner', persona: 'frontend', cwd, prompt: 'hi' })
  await until(() => events(r.id).some((e) => e.type === 'system/init'), 'init')
  const env = events(r.id).find((e) => e.type === 'system/init').event.env
  assert.ok(env.includes('WT_ROLE') && env.includes('WT_PERSONA'))
  assert.equal(h.get(r.id).persona, 'frontend')
  assert.throws(() => h.spawn({ role: 'planner', persona: 'Bad Name', cwd }), /persona/)
  const w = h.spawn({ role: 'worker', cwd, prompt: 'hi' })
  await until(() => events(w.id).some((e) => e.type === 'system/init'), 'init')
  assert.ok(!events(w.id).find((e) => e.type === 'system/init').event.env.includes('WT_PERSONA'))
})

// WP-309: a run turns the user's other plugins off with --settings, keeping its own list (or the server default) on.
async function pluginsRun(t, o, spawnExtra) {
  const home = await mkdtemp(join(tmpdir(), 'hl-home-')); await mkdir(join(home, '.claude'))
  await writeFile(join(home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'a@x': true, 'b@y': true, 'off@z': false } }))
  const { h, start, events } = await setup(t, { env: { HOME: home, PATH: process.env.PATH }, ...o })
  const r = start('hi', spawnExtra)
  await until(() => events(r.id).some((e) => e.type === 'system/init'), 'init')
  const argv = events(r.id).find((e) => e.type === 'system/init').event.argv
  const i = argv.indexOf('--settings')
  return { h, r, flag: i < 0 ? null : JSON.parse(argv[i + 1]) }
}
test('plugins: default turns every enabled plugin off; a run list keeps its own on; * does not trim; bad input is a 400 (WP-309)', async (t) => {
  assert.deepEqual((await pluginsRun(t)).flag, { enabledPlugins: { 'a@x': false, 'b@y': false } })
  assert.deepEqual((await pluginsRun(t, {}, { plugins: ['a@x'] })).flag, { enabledPlugins: { 'b@y': false } })
  assert.deepEqual((await pluginsRun(t, { plugins: ['b@y'] })).flag, { enabledPlugins: { 'a@x': false } }) // the server default
  assert.equal((await pluginsRun(t, { plugins: ['*'] })).flag, null)
  assert.equal(DEFAULT_PLUGINS, '') // the one value to flip for the default
  const { h, cwd } = await setup(t)
  for (const bad of ['a@x', [1], ['bad id!'], Array(41).fill('a@x')]) assert.throws(() => h.spawn({ role: 'worker', cwd, plugins: bad }), (e) => e.status === 400)
})
test('plugins: each run stores its own list is stored for a resume to rebuild (WP-309)', async (t) => {
  const { h, r } = await pluginsRun(t, {}, { plugins: ['a@x'] })
  assert.equal(h.get(r.id).req_plugins, '["a@x"]')
})

test('contextWindowOf: the run\'s own model first, else the largest, else null (WP-314)', () => {
  assert.equal(contextWindowOf({ a: { contextWindow: 200000 }, b: { contextWindow: 1000000 } }, 'a'), 200000)
  assert.equal(contextWindowOf({ a: { contextWindow: 200000 }, b: { contextWindow: 1000000 } }, 'zzz'), 1000000)
  assert.equal(contextWindowOf({ a: {} }, 'a'), null); assert.equal(contextWindowOf(undefined, 'a'), null)
})
