// Routines (WP-48): recurring agent work run by the dashboard server. Schedules, the store (DATA/wt.db, migration 5)
// and the tick. The server injects every side effect (agents, host, prompt, spawn, remove, actions), so tests need no herdr.
import { join } from 'node:path'
import { open } from './store.mjs'

const err = (status, m) => Object.assign(new Error(m), { status })
const RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]] // m h dom mon dow (7 = Sunday too)
const UNIT = { m: 60_000, h: 3_600_000, d: 86_400_000 }

function field(s, [lo, hi]) {
  const set = new Set()
  for (const part of s.split(',')) {
    const m = part.match(/^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/)
    if (!m) throw err(400, `bad cron field '${s}'`)
    const a = m[1] === '*' ? lo : Number(m[2]), b = m[1] === '*' ? hi : m[3] !== undefined ? Number(m[3]) : m[4] ? hi : a
    const step = m[4] ? Number(m[4]) : 1
    if (a < lo || b > hi || a > b || step < 1) throw err(400, `cron field '${s}' out of range ${lo}-${hi}`)
    for (let i = a; i <= b; i += step) set.add(i)
  }
  return set
}

// 'every <N>m|h|d' or a 5-field cron in local time. Throws (status 400) on anything else.
export function parseSchedule(s) {
  const t = String(s ?? '').trim()
  const e = t.match(/^every\s+(\d+)\s*([mhd])$/)
  if (e) { if (Number(e[1]) < 1) throw err(400, 'every: N ≥ 1'); return { every: Number(e[1]) * UNIT[e[2]] } }
  const f = t.split(/\s+/)
  if (f.length !== 5) throw err(400, "schedule: 'every 30m' or cron 'm h dom mon dow'")
  const [min, hour, dom, mon, dow] = f.map((x, i) => field(x, RANGES[i]))
  if (dow.has(7)) dow.add(0)
  return { min, hour, dom, mon, dow, domAny: f[2] === '*', dowAny: f[4] === '*' }
}

// First slot strictly after `after`. ponytail: minute scan capped at 366 days, fine at 30s ticks and tens of routines.
export function nextRun(schedule, after = new Date()) {
  const s = typeof schedule === 'string' ? parseSchedule(schedule) : schedule
  if (s.every) return new Date(+after + s.every)
  let t = Math.floor(+after / 60_000) * 60_000 + 60_000
  for (let i = 0; i < 366 * 1440; i++, t += 60_000) {
    const d = new Date(t)
    if (!s.min.has(d.getMinutes()) || !s.hour.has(d.getHours()) || !s.mon.has(d.getMonth() + 1)) continue
    const dm = s.dom.has(d.getDate()), dw = s.dow.has(d.getDay())
    // Vixie cron: both day fields restricted → either matches.
    if (s.domAny || s.dowAny ? dm && dw : dm || dw) return d
  }
  throw err(400, 'schedule never fires within a year')
}

const KINDS = ['prompt', 'spawn', 'action']
export const ACTIONS = ['jev-run', 'housekeeping']
const str = (v, max) => typeof v === 'string' && v.trim() && v.length <= max

export function cleanTarget(t) {
  if (!t || !KINDS.includes(t.kind)) throw err(400, `target.kind: ${KINDS.join('|')}`)
  if (t.kind === 'prompt') {
    if (!str(t.text, 4000)) throw err(400, 'target.text required')
    if (str(t.agent, 64)) return { kind: 'prompt', agent: t.agent, text: t.text }
    if (!str(t.role, 64) || !str(t.project, 64)) throw err(400, 'target: agent, or role + project')
    return { kind: 'prompt', role: t.role, project: t.project, text: t.text }
  }
  if (t.kind === 'spawn') {
    if (!str(t.role, 64) || !str(t.project, 64) || !str(t.prompt, 4000)) throw err(400, 'target: role, project and prompt')
    return { kind: 'spawn', role: t.role, project: t.project, prompt: t.prompt }
  }
  if (!ACTIONS.includes(t.action)) throw err(400, `target.action: ${ACTIONS.join('|')}`)
  if (t.action === 'jev-run' && !str(t.project, 64)) throw err(400, 'target.project required')
  return t.action === 'jev-run' ? { kind: 'action', action: t.action, project: t.project } : { kind: 'action', action: t.action }
}

const row = (r) => r && { ...r, target: JSON.parse(r.target), enabled: !!r.enabled }

// Shared by Routines and board Dispatch (WP-52): one cap over both, then memory. working null = no cap check (actions).
export async function guard({ working, pending = 0, max, host }) {
  if (working != null && working + pending >= max) return `cap: ${working + pending} working ≥ ${max}`
  if ((await host())?.pressure === 'critical') return 'memory pressure critical'
  return null
}
const DAY = 86_400_000

export class Routines {
  // deps: { agents, host, prompt(agent, text), spawn({kind, project, prompt}), remove(pane, {force}), actions: {name: (target) => result},
  //   pending?() — other pending starts sharing the cap (board dispatches in flight) }
  constructor({ dir, db, deps = {}, log = console.error, pollMs = 15_000 }) {
    Object.assign(this, { file: dir && join(dir, 'wt.db'), _db: db, deps, log, pollMs, ticking: false, inflight: new Set(), busy: new Set() })
  }
  get db() { return this._db ?? open(this.file, { log: this.log }) } // lazy: server.mjs is imported by tests

  list() {
    const last = this.db.prepare('SELECT status, reason, started, ended FROM routine_runs WHERE routine_id = ? ORDER BY id DESC LIMIT 1')
    return this.db.prepare('SELECT * FROM routines ORDER BY created, id').all().map((r) => ({ ...row(r), last: last.get(r.id) ?? null }))
  }
  get(id) { return row(this.db.prepare('SELECT * FROM routines WHERE id = ?').get(id)) }
  settings() {
    const v = this.db.prepare("SELECT v FROM routine_settings WHERE k = 'maxWorking'").get()?.v
    return { maxWorking: v == null ? 4 : Number(v) }
  }
  setSettings(b) {
    const n = Number(b.maxWorking)
    if (!Number.isInteger(n) || n < 0 || n > 100) throw err(400, 'maxWorking: 0–100')
    this.db.prepare("INSERT INTO routine_settings (k, v) VALUES ('maxWorking', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(String(n))
    return this.settings()
  }
  // Open spawn runs whose agent is not yet listed as working, so concurrent spawns cannot all pass the cap.
  pendingSpawns(busy = new Set(), except = -1) {
    return this.db.prepare("SELECT agent FROM routine_runs WHERE status = 'running' AND id != ? AND kind = 'spawn'")
      .all(except).filter((u) => !u.agent || !busy.has(u.agent)).length
  }
  runs(limit = 100) {
    return this.db.prepare('SELECT * FROM routine_runs ORDER BY id DESC LIMIT ?')
      .all(Math.min(500, Math.max(1, Number(limit) || 100)))
  }

  #clean(b, prev) {
    const name = b.name ?? prev?.name
    if (!str(name, 100)) throw err(400, 'name: 1–100 chars')
    const schedule = String(b.schedule ?? prev?.schedule ?? '').trim()
    parseSchedule(schedule)
    const target = b.target !== undefined ? cleanTarget(b.target) : prev?.target
    if (!target) throw err(400, 'target required')
    const timeout = Number(b.timeout_min ?? prev?.timeout_min ?? 60)
    if (!(timeout > 0 && timeout <= 1440)) throw err(400, 'timeout_min: 1–1440')
    const enabled = typeof b.enabled === 'boolean' ? b.enabled : prev?.enabled ?? false
    return { name: name.trim(), schedule, target, timeout_min: timeout, enabled }
  }
  create(b, now = Date.now()) {
    const r = this.#clean(b)
    const id = `r-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    this.db.prepare('INSERT INTO routines (id, name, schedule, target, timeout_min, enabled, next_run, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, r.name, r.schedule, JSON.stringify(r.target), r.timeout_min, r.enabled ? 1 : 0, +nextRun(r.schedule, new Date(now)), now)
    return this.get(id)
  }
  update(id, b, now = Date.now()) {
    const prev = this.get(id)
    if (!prev) throw err(404, 'unknown routine')
    const r = this.#clean(b, prev)
    // Enabling (or a new schedule) starts from now, so a seed switched on weeks later does not fire on its stale slot.
    const next = (r.enabled && !prev.enabled) || r.schedule !== prev.schedule ? +nextRun(r.schedule, new Date(now)) : prev.next_run
    this.db.prepare('UPDATE routines SET name = ?, schedule = ?, target = ?, timeout_min = ?, enabled = ?, next_run = ? WHERE id = ?')
      .run(r.name, r.schedule, JSON.stringify(r.target), r.timeout_min, r.enabled ? 1 : 0, next, id)
    return this.get(id)
  }
  delete(id) {
    if (!this.db.prepare('DELETE FROM routines WHERE id = ?').run(id).changes) throw err(404, 'unknown routine')
    return { ok: true }
  }

  // Startup: runs left 'running' by a crash or restart. A spawn run's agent is removed so it does not hold the cap forever.
  async recover() {
    for (const u of this.db.prepare("SELECT id, agent, kind FROM routine_runs WHERE status = 'running'").all()) {
      if (u.agent && u.kind === 'spawn') await this.deps.remove(u.agent, { force: true }).catch((e) => this.log(`routines: remove ${u.agent}: ${e.message}`))
      this.#close(u.id, 'failed', 'server restarted')
    }
  }

  // One scheduler pass. Re-entrancy: setInterval does not wait for an async tick, so a tick in flight makes this a no-op.
  async tick(now = Date.now()) {
    if (this.ticking) return
    this.ticking = true
    try {
      this.db.prepare('DELETE FROM routine_runs WHERE started < ? AND status != ?').run(now - 30 * DAY, 'running') // ponytail: fixed 30d
      const due = this.db.prepare('SELECT * FROM routines WHERE enabled = 1 AND next_run <= ?').all(now).map(row)
      // next_run from now, not from the missed slot: a run missed during sleep fires once on wake.
      const adv = this.db.prepare('UPDATE routines SET next_run = ? WHERE id = ?')
      for (const r of due) adv.run(+nextRun(r.schedule, new Date(now)), r.id)
      for (const r of due) await this.fire(r, now)
    } finally { this.ticking = false }
  }

  // Run now: guardrails apply, next_run is left alone.
  async runNow(id, now = Date.now()) {
    const r = this.get(id)
    if (!r) throw err(404, 'unknown routine')
    return this.fire(r, now)
  }

  #close(id, status, reason = null, ended = Date.now()) {
    this.db.prepare('UPDATE routine_runs SET status = ?, reason = ?, ended = ? WHERE id = ?').run(status, reason, ended, id)
  }

  // Guardrails in order (overlap, cap, memory), then the target is started without awaiting it. Returns the run row.
  async fire(r, now = Date.now()) {
    const open = this.db.prepare("SELECT 1 FROM routine_runs WHERE routine_id = ? AND status = 'running'").get(r.id)
    // The name is copied so history still reads after the routine is deleted.
    const runId = Number(this.db.prepare('INSERT INTO routine_runs (routine_id, name, kind, started, status) VALUES (?, ?, ?, ?, ?)')
      .run(r.id, r.name, r.target.kind, now, open ? 'skipped' : 'running').lastInsertRowid)
    const get = () => this.db.prepare('SELECT * FROM routine_runs WHERE id = ?').get(runId)
    if (open) { this.#close(runId, 'skipped', 'previous run still going', now); return get() }
    const skip = (why) => { this.#close(runId, 'skipped', why); return get() }
    let a // the prompt target, resolved once
    try {
      const t = r.target
      let ags = [], working = null, pending = 0
      if (t.kind !== 'action') {
        ags = await this.deps.agents()
        const w = ags.filter((a) => a.status === 'working')
        working = w.length
        pending = this.pendingSpawns(new Set(w.map((a) => a.id)), runId) + (this.deps.pending?.() ?? 0)
      }
      // An action that timed out may still be running; one at a time per action, across routines.
      if (t.kind === 'action' && this.busy.has(t.action)) return skip(`${t.action} still running`)
      const why = await guard({ working, pending, max: this.settings().maxWorking, host: this.deps.host })
      if (why) return skip(why)
      if (t.kind === 'prompt') {
        a = ags.find((x) => t.agent ? x.name === t.agent : x.pool === t.role && x.project === t.project)
        if (!a) return skip('no agent')
        if (a.status === 'working') return skip('agent busy')
        this.db.prepare('UPDATE routine_runs SET agent = ? WHERE id = ?').run(a.name, runId)
      }
    } catch (e) { this.#close(runId, 'failed', e.message); return get() }
    const job = this.#run(r, runId, now, a).catch((e) => this.#close(runId, 'failed', String(e?.message ?? e).slice(0, 500)))
    this.inflight.add(job)
    job.finally(() => this.inflight.delete(job))
    return get()
  }
  idle() { return Promise.all([...this.inflight]) } // tests

  async #run(r, runId, started, a) {
    const t = r.target, ms = r.timeout_min * 60_000
    if (t.kind === 'prompt') {
      await this.deps.prompt(a, t.text)
      return this.#close(runId, 'ok', `prompted ${a.name}`)
    }
    if (t.kind === 'action') {
      let timer
      this.busy.add(t.action) // released when the action settles, not when the run times out
      const work = Promise.resolve().then(() => this.deps.actions[t.action](t)).finally(() => this.busy.delete(t.action))
      const out = await Promise.race([
        work,
        new Promise((resolve) => { timer = setTimeout(() => resolve({ timeout: true }), ms) }),
      ]).finally(() => clearTimeout(timer))
      if (out?.timeout) return this.#close(runId, 'timeout', `after ${r.timeout_min} min`)
      if (out?.skipped) return this.#close(runId, 'skipped', out.skipped)
      return this.#close(runId, 'ok', out?.summary ?? null)
    }
    const s = await this.deps.spawn({ kind: t.role, project: t.project, prompt: t.prompt })
    this.db.prepare('UPDATE routine_runs SET agent = ? WHERE id = ?').run(s.pane, runId)
    if (s.prompted === false) {
      await this.deps.remove(s.pane, { force: true }).catch(() => {})
      return this.#close(runId, 'failed', 'prompt not delivered')
    }
    // Done when idle after being seen working (or gone). Blocked (waiting on the user) keeps it; the timeout reaps it.
    let seen = false
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, this.pollMs))
      const list = await this.deps.agents().catch(() => null)
      const a = list?.find((x) => x.id === s.pane)
      if (Date.now() - started >= ms) {
        if (a || !list) await this.deps.remove(s.pane, { force: true }).catch((e) => this.log(`routines: remove ${s.pane}: ${e.message}`))
        return this.#close(runId, 'timeout', `after ${r.timeout_min} min; removed ${s.name}`)
      }
      if (!list) continue
      if (a && (a.status === 'working' || a.status === 'blocked')) { seen = true; continue }
      if (a && !seen) continue
      if (a) await this.deps.remove(s.pane, { force: true })
      return this.#close(runId, 'ok', `${s.name} finished`)
    }
  }
}
