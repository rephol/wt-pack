// WP-293: headless agents. The server owns ONE unmodified `claude -p --input-format stream-json --output-format stream-json
// --permission-prompt-tool stdio` process per run, under the user's own login (no API key, no SDK package), and talks to it
// over stdin/stdout JSON lines. Every event goes into wt.db with a store-assigned sequence (snapshot-then-stream: a client
// reads `events?after=N`, or follows the change stream and refetches after its last seq). Opt-in: nothing else uses this.
//
// Supervisor rules (what t3code lacks, WP-294): a global cap with a queue in front of spawn, idle release, a stuck-turn
// watchdog, startup reconcile, kill by the RECORDED pid only (never pkill), bounded event retention.
import { spawn as nodeSpawn, execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { open, tx } from './store.mjs'

const err = (status, m) => Object.assign(new Error(m), { status })
export const ROLE = /^[\w.-]{1,40}$/
export const READ_ONLY = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead'])
const LIVE = ['starting', 'working', 'idle'] // a process exists
const LINE_MAX = 256 * 1024 // an event bigger than this is stored as a stub
const KEEP_EVENTS = 2000 // per run; older rows are dropped, seq keeps counting
const TEXT_MAX = 100_000

// Roles map to a permission mode and a tool policy. 'readonly': Read/Grep/Glob answered automatically, any other tool denied.
// 'ask': every tool request becomes an open ask for a human. Unknown role = ask (never silently permissive).
export const POLICIES = { reviewer: 'readonly', 'pr-watcher': 'readonly', auditor: 'readonly' }
export const policyOf = (role) => POLICIES[role] ?? 'ask'

export class Headless {
  // opts: cmd (the binary; tests pass a fake), cap, idleMs, stuckMs, graceMs, resumes, db, onChange(run id, what), log, now
  constructor({ db, cmd = 'claude', cap = 3, idleMs = 30 * 60_000, stuckMs = 10 * 60_000, graceMs = 5_000, resumes = 2,
    onChange = () => {}, log = console.error, now = Date.now, env = process.env } = {}) {
    Object.assign(this, { db, cmd, cap, idleMs, stuckMs, graceMs, resumes, onChange, log, now, env, procs: new Map() })
  }
  static open(file, o = {}) { return new Headless({ ...o, db: open(file, { log: o.log }) }) }

  // ---- reads ----
  run(id) { return this.db.prepare('SELECT * FROM headless_runs WHERE id = ?').get(id) }
  list() { return this.db.prepare('SELECT * FROM headless_runs ORDER BY created DESC LIMIT 200').all().map((r) => this.#view(r)) }
  get(id) { const r = this.run(id); return r && this.#view(r) }
  #view(r) {
    const open = this.db.prepare("SELECT id, tool, input, created FROM headless_asks WHERE run_id = ? AND state = 'open' ORDER BY created").all(r.id)
      .map((a) => ({ ...a, input: JSON.parse(a.input) }))
    return { ...r, asks: open, live: LIVE.includes(r.state) }
  }
  events(id, after = 0, limit = 500) {
    const rows = this.db.prepare('SELECT seq, at, type, json FROM headless_events WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT ?').all(id, Number(after) || 0, Math.min(limit, 2000))
    return { events: rows.map((r) => ({ seq: r.seq, at: r.at, type: r.type, event: JSON.parse(r.json) })), last: this.db.prepare('SELECT MAX(seq) m FROM headless_events WHERE run_id = ?').get(id).m ?? 0 }
  }
  live() { return this.db.prepare(`SELECT * FROM headless_runs WHERE state IN ('starting','working','idle')`).all() }

  // ---- lifecycle ----
  // Create a run and start it now, or queue it when the cap is reached.
  spawn({ role, cwd, prompt, model, effort, name } = {}) {
    if (!ROLE.test(role ?? '')) throw err(400, 'role: 1-40 chars of [\\w.-]')
    if (typeof cwd !== 'string' || !cwd.startsWith('/')) throw err(400, 'cwd: an absolute path')
    if (prompt !== undefined && (typeof prompt !== 'string' || prompt.length > TEXT_MAX)) throw err(400, `prompt: a string up to ${TEXT_MAX} chars`)
    const id = 'hl-' + randomBytes(5).toString('hex')
    const t = this.now()
    this.db.prepare(`INSERT INTO headless_runs (id, name, role, cwd, model, effort, prompt, state, created, last_event, resumes)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, 0)`).run(id, name ?? `${role}-${id.slice(3, 7)}`, role, cwd, model ?? null, effort ?? null, prompt ?? null, t, t)
    this.#note(id, 'supervisor', { subtype: 'queued' })
    this.pump()
    return this.get(id)
  }
  // Start queued runs while under the cap, oldest first.
  pump() {
    const active = this.live().length
    const queued = this.db.prepare("SELECT id FROM headless_runs WHERE state = 'queued' ORDER BY created").all()
    for (const q of queued.slice(0, Math.max(0, this.cap - active))) this.#start(q.id)
  }
  #start(id) {
    const r = this.run(id)
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--permission-prompt-tool', 'stdio',
      '--permission-mode', 'default', ...(r.model ? ['--model', r.model] : []), ...(r.effort ? ['--effort', r.effort] : []),
      ...(r.session ? ['--resume', r.session] : [])]
    // A minimal env: the login lives in the keychain and HOME, never an API key; no HERDR_* so it is not mistaken for a pane.
    const env = { HOME: this.env.HOME, PATH: this.env.PATH, TERM: 'dumb', ...(this.env.USER ? { USER: this.env.USER } : {}) }
    let child
    try { child = nodeSpawn(this.cmd, args, { cwd: r.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] }) } catch (e) { return this.#end(id, 'failed', `spawn: ${e.message}`) }
    const p = { child, buf: '', done: false, killing: false }
    this.procs.set(id, p)
    this.db.prepare("UPDATE headless_runs SET state = 'starting', pid = ?, started = ?, last_event = ?, reason = NULL WHERE id = ?").run(child.pid ?? null, this.now(), this.now(), id)
    this.#note(id, 'supervisor', { subtype: 'started', pid: child.pid, resume: r.session ?? null })
    child.on('error', (e) => { this.#note(id, 'supervisor', { subtype: 'spawn_error', message: e.message }); p.done = true; this.#exit(id, p, null, null, `spawn: ${e.message}`) })
    child.stdin.on('error', () => {}) // EPIPE after exit is handled by 'close'
    child.stdout.on('data', (d) => this.#data(id, p, d))
    child.stderr.on('data', (d) => this.#note(id, 'stderr', { text: String(d).slice(0, 2000) }, false))
    child.on('close', (code, sig) => this.#exit(id, p, code, sig))
    if (r.prompt) { this.#write(id, userLine(r.prompt)); this.db.prepare('UPDATE headless_runs SET prompt = NULL WHERE id = ?').run(id) }
    this.onChange(id, 'run')
  }
  #data(id, p, d) {
    p.buf += d
    let i
    while ((i = p.buf.indexOf('\n')) >= 0) {
      const line = p.buf.slice(0, i); p.buf = p.buf.slice(i + 1)
      if (line.trim()) this.#event(id, line)
    }
    if (p.buf.length > LINE_MAX) { this.#note(id, 'supervisor', { subtype: 'oversized_line', bytes: p.buf.length }); p.buf = '' }
  }
  #event(id, line) {
    let e
    try { e = JSON.parse(line) } catch { return this.#note(id, 'stdout', { text: line.slice(0, 2000) }) }
    const type = e.type + (e.subtype ? '/' + e.subtype : '')
    const t = this.now()
    this.#store(id, type, line.length > LINE_MAX ? JSON.stringify({ type: e.type, subtype: e.subtype, truncated: line.length }) : line, t)
    const set = (sql, ...a) => this.db.prepare(`UPDATE headless_runs SET ${sql} WHERE id = ?`).run(...a, id)
    if (e.type === 'system' && e.subtype === 'init') {
      set(`session = ?, plugins = ?, permission_mode = ?, api_key_source = ?, state = CASE WHEN state = 'starting' THEN 'working' ELSE state END`,
        e.session_id ?? null, JSON.stringify((e.plugins ?? []).map((x) => x.name ?? x)), e.permissionMode ?? null, e.apiKeySource ?? null)
    } else if (e.type === 'result') {
      set(`state = 'idle', turns = turns + 1, cost_usd = cost_usd + ?`, Number(e.total_cost_usd) || 0)
    } else if (e.type === 'user' || e.type === 'assistant') {
      set(`state = CASE WHEN state IN ('idle','starting') THEN 'working' ELSE state END`)
    } else if (e.type === 'control_request' && e.request?.subtype === 'can_use_tool') {
      this.#toolRequest(id, e)
    }
    this.onChange(id, 'event')
  }
  // can_use_tool: AskUserQuestion always waits for a human; other tools follow the role's policy.
  #toolRequest(id, e) {
    const r = this.run(id), { tool_name: tool, input = {} } = e.request
    const rid = e.request_id
    if (tool !== 'AskUserQuestion' && policyOf(r.role) === 'readonly') {
      const ok = READ_ONLY.has(tool)
      return this.#reply(id, rid, ok ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: `${tool} is not allowed for a ${r.role} agent` })
    }
    this.db.prepare("INSERT OR REPLACE INTO headless_asks (id, run_id, tool, input, state, created) VALUES (?, ?, ?, ?, 'open', ?)").run(rid, id, tool, JSON.stringify(input), this.now())
    this.onChange(id, 'ask')
  }
  #reply(id, request_id, response) { this.#write(id, JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id, response } })) }
  #write(id, line) {
    const p = this.procs.get(id)
    if (!p || p.done || !p.child.stdin.writable) throw err(409, 'the agent process is not running')
    p.child.stdin.write(line + '\n')
  }
  #store(id, type, json, t) {
    const seq = this.db.prepare('INSERT INTO headless_events (run_id, at, type, json) VALUES (?, ?, ?, ?)').run(id, t, type, json).lastInsertRowid
    this.db.prepare('UPDATE headless_runs SET last_event = ?, events = events + 1 WHERE id = ?').run(t, id)
    if (Number(seq) % 200 === 0) this.db.prepare('DELETE FROM headless_events WHERE run_id = ? AND seq <= (SELECT MAX(seq) - ? FROM headless_events WHERE run_id = ?)').run(id, KEEP_EVENTS, id)
  }
  // A supervisor/diagnostic event in the same log; `touch` false = it must not reset the idle/stuck clocks.
  #note(id, type, data, touch = true) {
    const t = this.now()
    this.db.prepare('INSERT INTO headless_events (run_id, at, type, json) VALUES (?, ?, ?, ?)').run(id, t, type, JSON.stringify({ type, ...data }))
    if (touch) this.db.prepare('UPDATE headless_runs SET last_event = ? WHERE id = ?').run(t, id)
  }
  #exit(id, p, code, sig, why) {
    if (this.procs.get(id) === p) this.procs.delete(id)
    p.done = true
    const r = this.run(id)
    if (!r || !LIVE.includes(r.state)) return this.pump()
    // The process went away on its own while a turn was in flight: resume by session id, a couple of times.
    const crashed = !p.killing
    const reason = why ?? (p.reason || (sig ? `killed by ${sig}` : `exit ${code}`))
    this.#expireAsks(id, `process ended (${reason})`)
    if (crashed && r.session && r.state === 'working' && r.resumes < this.resumes) {
      this.db.prepare("UPDATE headless_runs SET state = 'queued', resumes = resumes + 1, pid = NULL, prompt = ? WHERE id = ?").run('Your previous process ended in the middle of a turn. Continue where you left off.', id)
      this.#note(id, 'supervisor', { subtype: 'crash_resume', reason, attempt: r.resumes + 1 })
      return this.pump()
    }
    this.#end(id, crashed && r.state === 'working' ? 'failed' : 'ended', p.reason || (crashed ? `process ended: ${reason}` : reason))
  }
  #end(id, state, reason) {
    this.db.prepare('UPDATE headless_runs SET state = ?, reason = ?, ended = ?, pid = NULL WHERE id = ?').run(state, reason, this.now(), id)
    this.#note(id, 'supervisor', { subtype: 'ended', state, reason })
    this.onChange(id, 'run')
    this.pump()
  }
  #expireAsks(id, why) {
    const n = this.db.prepare("UPDATE headless_asks SET state = 'expired', note = ? WHERE run_id = ? AND state = 'open'").run(why, id).changes
    if (n) this.onChange(id, 'ask')
    return n
  }
  // Stop a process: close stdin (claude exits on EOF), then SIGTERM the RECORDED pid after a grace period. Never a pattern kill.
  stop(id, reason = 'stopped') {
    const p = this.procs.get(id), r = this.run(id)
    if (!r) throw err(404, 'unknown headless agent')
    if (r.state === 'queued') { this.#end(id, 'ended', 'cancelled while queued'); return this.get(id) }
    if (!p || p.done) return this.get(id)
    Object.assign(p, { killing: true, reason })
    try { p.child.stdin.end() } catch { /* already closed */ }
    const t = setTimeout(() => { if (!p.done && p.child.pid === r.pid) try { process.kill(r.pid, 'SIGTERM') } catch { /* gone */ } }, this.graceMs)
    t.unref?.()
    p.child.once('close', () => clearTimeout(t))
    return this.get(id)
  }

  // ---- commands ----
  message(id, text) {
    if (typeof text !== 'string' || !text.trim() || text.length > TEXT_MAX) throw err(400, `text: 1-${TEXT_MAX} chars`)
    const r = this.run(id)
    if (!r) throw err(404, 'unknown headless agent')
    if (r.state === 'queued') throw err(409, 'queued behind the cap; send once it starts')
    if (!LIVE.includes(r.state)) return this.resume(id, text)
    this.#write(id, userLine(text))
    this.db.prepare("UPDATE headless_runs SET state = 'working', last_event = ? WHERE id = ? AND state = 'idle'").run(this.now(), id)
    this.#note(id, 'supervisor', { subtype: 'message', chars: text.length })
    this.onChange(id, 'run')
    return this.get(id)
  }
  // Start a stopped/ended/failed run again from its session id. text = the next user message.
  resume(id, text) {
    const r = this.run(id)
    if (!r) throw err(404, 'unknown headless agent')
    if (!r.session) throw err(409, 'no session id recorded yet; nothing to resume')
    if (LIVE.includes(r.state) || r.state === 'queued') throw err(409, `already ${r.state}`)
    this.db.prepare("UPDATE headless_runs SET state = 'queued', prompt = ?, resumes = 0, ended = NULL WHERE id = ?").run(text ?? null, id)
    this.pump()
    return this.get(id)
  }
  interrupt(id) {
    const r = this.run(id)
    if (!r) throw err(404, 'unknown headless agent')
    if (r.state !== 'working') throw err(409, `the agent is ${r.state}, not working`)
    this.#write(id, JSON.stringify({ type: 'control_request', request_id: 'int-' + randomBytes(4).toString('hex'), request: { subtype: 'interrupt' } }))
    this.#note(id, 'supervisor', { subtype: 'interrupt' })
    return this.get(id)
  }
  // Answer an open ask. body: { allow: bool, message? } for a tool; { answers: {question: label} } for AskUserQuestion.
  answer(id, askId, body = {}) {
    const a = this.db.prepare("SELECT * FROM headless_asks WHERE id = ? AND run_id = ? AND state = 'open'").get(askId, id)
    if (!a) throw err(404, 'no such open ask')
    const input = JSON.parse(a.input)
    let response
    if (a.tool === 'AskUserQuestion') {
      const answers = body.answers
      if (!answers || typeof answers !== 'object' || Array.isArray(answers)) throw err(400, 'answers: { <question text>: <label> }')
      const known = new Set((input.questions ?? []).map((q) => q.question))
      for (const [q, v] of Object.entries(answers)) if (!known.has(q) || typeof v !== 'string') throw err(400, `answers: unknown question or non-string answer: ${q.slice(0, 60)}`)
      response = { behavior: 'allow', updatedInput: { ...input, answers } }
    } else {
      response = body.allow === true ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: String(body.message ?? 'denied by the user').slice(0, 500) }
    }
    this.#reply(id, askId, response)
    this.db.prepare("UPDATE headless_asks SET state = 'answered', note = ? WHERE id = ?").run(JSON.stringify(response.behavior), askId)
    this.#note(id, 'supervisor', { subtype: 'ask_answered', ask: askId, behavior: response.behavior })
    this.onChange(id, 'ask')
    return this.get(id)
  }

  // ---- supervision ----
  // Called on a timer. Idle release, stuck-turn watchdog. Returns what it did (for logs/tests).
  tick() {
    const t = this.now(), did = []
    for (const r of this.live()) {
      const quiet = t - r.last_event
      if (r.state === 'idle' && quiet > this.idleMs) { this.stop(r.id, `idle release (${Math.round(quiet / 60_000)} min quiet)`); did.push(['idle', r.id]) }
      else if (r.state === 'working' && quiet > this.stuckMs) {
        const p = this.procs.get(r.id)
        if (p && !p.stuck) {
          p.stuck = t
          this.#note(r.id, 'supervisor', { subtype: 'stuck', quietMs: quiet }, false)
          try { this.interrupt(r.id) } catch { /* process gone: exit handler runs */ }
          did.push(['stuck-interrupt', r.id])
        } else if (p && t - p.stuck > this.graceMs) {
          this.stop(r.id, `stuck turn: no events for ${Math.round(quiet / 60_000)} min`)
          did.push(['stuck-kill', r.id])
        }
      }
    }
    return did
  }
  // Startup: processes left by a previous server are not ours any more. Mark them ended, expire their asks, say why; kill the
  // recorded pid only when `ps` still shows a stream-json claude there (a reused pid is left alone). Returns the ids reconciled.
  async reconcile() {
    const out = []
    for (const r of this.live()) {
      if (this.procs.has(r.id)) continue
      if (r.pid && (await commandOf(r.pid)).includes('stream-json')) try { process.kill(r.pid, 'SIGTERM') } catch { /* gone */ }
      this.#expireAsks(r.id, 'server restarted')
      this.#end(r.id, 'ended', 'server restarted while it was running; resume by session id')
      out.push(r.id)
    }
    for (const q of this.db.prepare("SELECT id FROM headless_runs WHERE state = 'queued'").all()) this.#note(q.id, 'supervisor', { subtype: 'requeued_after_restart' })
    this.pump()
    return out
  }
  // Resident memory (KB) of every live process, one `ps` call.
  async rss() {
    const pids = this.live().map((r) => r.pid).filter(Boolean)
    if (!pids.length) return {}
    const out = await new Promise((res) => execFile('ps', ['-o', 'pid=,rss=', '-p', pids.join(',')], (_, so) => res(so ?? '')))
    return Object.fromEntries(out.trim().split('\n').filter(Boolean).map((l) => l.trim().split(/\s+/).map(Number)))
  }
  shutdown() { for (const [id] of this.procs) try { this.stop(id, 'server shutdown') } catch { /* gone */ } }
}

const userLine = (text) => JSON.stringify({ type: 'user', message: { role: 'user', content: text } })
const commandOf = (pid) => new Promise((res) => execFile('ps', ['-o', 'command=', '-p', String(pid)], (_, so) => res(so ?? '')))
