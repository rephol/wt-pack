// WP-293: headless agents. The server owns ONE unmodified `claude -p --input-format stream-json --output-format stream-json
// --permission-prompt-tool stdio` process per run, under the user's own login (no API key, no SDK package), and talks to it
// over stdin/stdout JSON lines. Every event goes into wt.db with a store-assigned sequence (snapshot-then-stream: a client
// reads `events?after=N`, or follows the change stream and refetches after its last seq). Opt-in: nothing else uses this.
//
// Supervisor rules (what t3code lacks, WP-294): a global cap with a queue in front of spawn, idle release, a stuck-turn
// watchdog, startup reconcile, kill by the RECORDED pid only (never pkill), bounded event retention.
import { spawn as nodeSpawn, execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFileSync, existsSync, accessSync, constants } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, join, dirname, delimiter } from 'node:path'
import { open } from './store.mjs'

const err = (status, m) => Object.assign(new Error(m), { status })
export const ROLE = /^[\w.-]{1,40}$/
export const READ_ONLY = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead'])
// WP-308: the wt MCP server's send_file (any server name): it only names files to the user, so it is allowed for every policy.
export const SEND_FILE = /^mcp__.+__send_file$/
const DRIVERS = ['cli', 'sdk']
const SDK_DIR = fileURLToPath(new URL('./headless-sdk/', import.meta.url))
const LIVE = ['starting', 'working', 'idle'] // a process exists
const LINE_MAX = 256 * 1024 // an event bigger than this is stored as a stub
const KEEP_EVENTS = 2000 // per run; older rows are dropped, seq keeps counting
const PRUNE_EVERY = 100
const TEXT_MAX = 100_000

// Roles map to a permission mode and a tool policy. 'readonly': Read/Grep/Glob answered automatically, any other tool denied.
// 'ask': every tool request becomes an open ask for a human. Unknown role = ask (never silently permissive).
export const POLICIES = { reviewer: 'readonly', 'pr-watcher': 'readonly', auditor: 'readonly' }
export const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions']
// WP-309: THE default for which plugins stay on in a run (comma list). '' = wt-pack only; '*' = no trimming (every enabled plugin, as before).
// Flip it here, or per server with WT_HEADLESS_PLUGINS. Not yet confirmed by the user.
export const DEFAULT_PLUGINS = ''
// WP-314: the context window a result event reports: modelUsage[<model>].contextWindow for the run's own model, else the largest (a subagent's model
// may be listed too). null when the event has none.
export function contextWindowOf(modelUsage, model) {
  const ws = Object.entries(modelUsage ?? {}).map(([m, u]) => [m, Number(u?.contextWindow)]).filter(([, w]) => w > 0)
  return ws.find(([m]) => m === model)?.[1] ?? (ws.length ? Math.max(...ws.map(([, w]) => w)) : null)
}
export const PLUGIN_ID = /^[\w.@-]{1,100}$/
// WP-309: the user's plugins that are switched on (user settings only). ponytail: project/local `enabledPlugins` are not read; add when a repo enables plugins.
export function enabledPlugins(home) {
  try {
    const e = JSON.parse(readFileSync(`${home}/.claude/settings.json`, 'utf8')).enabledPlugins
    return Object.keys(e ?? {}).filter((k) => e[k] === true)
  } catch { return [] }
}
export const STUCK_ACTIONS = ['flag', 'interrupt', 'kill']
// WP-306: the herdr scheme (agents.sh spawn): <repo slug>-<role>-<lowest unused NN>. The slug is lowercase [a-z0-9_-], cut to 20, and
// shortened further for a long role so the whole name stays <= 32. `taken` = names of live herdr agents and non-ended headless runs.
export function defaultName(repo, role, taken) {
  const lrole = String(role).toLowerCase().replace(/[^a-z0-9_-]/g, '-')
  const slug = String(repo).toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, Math.min(20, Math.max(1, 28 - lrole.length)))
  const used = new Set([...taken].map((n) => n.startsWith(`${slug}-${lrole}-`) ? Number(n.slice(slug.length + lrole.length + 2)) : NaN))
  let n = 1
  while (used.has(n)) n++
  return `${slug}-${lrole}-${String(n).padStart(2, '0')}`
}
export const policyOf = (role) => POLICIES[role] ?? 'ask'

// The absolute path of the claude binary: a path as given, else the first executable named so on PATH.
function absBin(cmd, path = '') {
  const ok = (f) => { try { accessSync(f, constants.X_OK); return true } catch { return false } }
  if (cmd.includes('/')) return ok(resolve(cmd)) ? resolve(cmd) : null
  return path.split(delimiter).filter(Boolean).map((d) => join(d, cmd)).find(ok) ?? null
}

export class Headless {
  // opts: cmd (the binary; tests pass a fake), cap, idleMs, stuckMs, graceMs, resumes, stuckAction, db, onChange(run id, what), log, now.
  // Product defaults are settings (WP-293): cap 0 (unlimited), idle release off (idleMs 0), stuckAction 'flag' (no automatic interrupt/kill), resumes 3 (a crash
  // mid-turn is resumed up to 3 times, then fails). An option wins, then env WT_HEADLESS_CAP / _STUCK_ACTION / _RESUMES, then the default.
  constructor({ db, cmd = 'claude', cap, idleMs = 0, stuckMs = 10 * 60_000, graceMs = 5_000, resumes, stuckAction, driver, worker = join(SDK_DIR, 'worker.mjs'), roles, plugins,
    onChange = () => {}, log = console.error, now = Date.now, env = process.env } = {}) {
    const num = (v, d) => (v === undefined || v === '' || !Number.isFinite(Number(v)) || Number(v) < 0 ? d : Number(v))
    cap = num(cap ?? env.WT_HEADLESS_CAP, 0) // 0 = unlimited
    resumes = num(resumes ?? env.WT_HEADLESS_RESUMES, 3)
    stuckAction = stuckAction ?? env.WT_HEADLESS_STUCK_ACTION ?? 'flag'
    if (!STUCK_ACTIONS.includes(stuckAction)) throw new Error(`stuckAction: one of ${STUCK_ACTIONS.join(', ')}`)
    // driver (WP-315; worker = the script it spawns, tests swap it): 'cli' (default) spawns `cmd`; 'sdk' spawns headless-sdk/worker.mjs, which speaks the same stream-json through the Agent SDK. Option, then env WT_HEADLESS_DRIVER.
    driver = driver ?? env.WT_HEADLESS_DRIVER ?? 'cli'
    if (!DRIVERS.includes(driver)) throw new Error(`driver: one of ${DRIVERS.join(', ')}`)
    // roles: the roles allowed to spawn headless (server: WT_HEADLESS_ROLES, default '*'); undefined or '*' = any.
    // plugins: ids that stay on in a run (server: WT_HEADLESS_PLUGINS, default none = every enabled plugin but wt-pack, which loads through
    // CLAUDE_CODE_PLUGIN_DIRS, is switched off); '*' = no trimming. Each run's own list (spawn `plugins`) replaces it.
    plugins = Array.isArray(plugins) ? plugins : (plugins ?? env.WT_HEADLESS_PLUGINS ?? DEFAULT_PLUGINS).split(',').map((x) => x.trim()).filter(Boolean)
    Object.assign(this, { plugins, db, cmd, cap, idleMs, stuckMs, graceMs, resumes, stuckAction, driver, worker, roles: roles && !roles.includes('*') ? roles : null, onChange, log, now, env, procs: new Map() })
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
  spawn({ role, cwd, prompt, model, effort, name, permissionMode, persona, plugins, spawner } = {}) {
    if (plugins != null && !(Array.isArray(plugins) && plugins.length <= 40 && plugins.every((x) => typeof x === 'string' && PLUGIN_ID.test(x)))) throw err(400, 'plugins: an array of up to 40 plugin ids')
    if (persona != null && !/^[a-z][a-z0-9-]{0,23}$/.test(persona)) throw err(400, 'persona: a role file name (lowercase, digits, -)')
    if (!ROLE.test(role ?? '')) throw err(400, 'role: 1-40 chars of [\\w.-]')
    if (this.roles && !this.roles.includes(role)) throw err(400, `role ${role} is not enabled for headless (WT_HEADLESS_ROLES)`)
    if (typeof cwd !== 'string' || !cwd.startsWith('/')) throw err(400, 'cwd: an absolute path')
    if (prompt !== undefined && (typeof prompt !== 'string' || prompt.length > TEXT_MAX)) throw err(400, `prompt: a string up to ${TEXT_MAX} chars`)
    // WP-300: unset = the user's own Claude Code settings decide. A read-only role stays on 'default' so every tool reaches policyOf.
    if (permissionMode != null && !PERMISSION_MODES.includes(permissionMode)) throw err(400, `permissionMode: one of ${PERMISSION_MODES.join(', ')}`)
    if (permissionMode && permissionMode !== 'default' && policyOf(role) === 'readonly') throw err(400, `role ${role} is read-only: permissionMode must be default`)
    const id = 'hl-' + randomBytes(5).toString('hex')
    const t = this.now()
    this.db.prepare(`INSERT INTO headless_runs (id, name, role, persona, cwd, model, effort, prompt, req_permission_mode, req_plugins, driver, spawner, state, created, last_event, resumes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, 0)`).run(id, name ?? `${role}-${id.slice(3, 7)}`, role, persona || null, cwd, model ?? null, effort ?? null, prompt ?? null, permissionMode || null, plugins ? JSON.stringify(plugins) : null, this.driver, typeof spawner === 'string' ? spawner : null, t, t)
    this.#note(id, 'supervisor', { subtype: 'queued' })
    this.pump()
    return this.get(id)
  }
  // Start queued runs while under the cap, oldest first.
  // Re-entrant calls (#start failing -> #end -> pump) only ask for another pass, so the cap is never overshot.
  pump() {
    if (this.pumping) { this.again = true; return }
    this.pumping = true
    try {
      do {
        this.again = false
        const room = this.cap ? this.cap - this.live().length : -1 // LIMIT -1 = no limit
        const queued = this.db.prepare("SELECT id FROM headless_runs WHERE state = 'queued' ORDER BY created, rowid LIMIT ?").all(room < 0 && this.cap ? 0 : room)
        for (const q of queued) this.#start(q.id)
      } while (this.again)
    } finally { this.pumping = false }
  }
  // WP-309: `--settings {"enabledPlugins":{id:false}}` turns the user's other plugins off for this run only (their hooks, skills and MCP
  // are most of a run's start-up tokens); the run's own list, else the server default, stays on. A resume rebuilds the same flag.
  #pluginArgs(r) {
    let keep = this.plugins
    try { if (r.req_plugins) keep = JSON.parse(r.req_plugins) } catch { /* keep the default */ }
    if (keep.includes('*')) return []
    const off = Object.fromEntries(enabledPlugins(this.env.HOME).filter((k) => !keep.includes(k)).map((k) => [k, false]))
    return Object.keys(off).length ? ['--settings', JSON.stringify({ enabledPlugins: off })] : []
  }
  #start(id) {
    const r = this.run(id)
    if (r?.state !== 'queued') return // cancelled or taken since the queue was read
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--permission-prompt-tool', 'stdio',
      ...(policyOf(r.role) === 'readonly' ? ['--permission-mode', 'default', '--tools', [...READ_ONLY, 'AskUserQuestion'].join(','), '--strict-mcp-config',
        '--mcp-config', JSON.stringify({ mcpServers: { 'wt-files': { command: process.execPath, args: [fileURLToPath(new URL('../wt-shared/mcp/wt-server.mjs', import.meta.url))], env: { WT_MCP_ONLY: 'send_file' } } } })] : // WP-300: only read tools exist, so no allow-rule in the user's settings can open a write/exec/MCP tool
         r.req_permission_mode ? ['--permission-mode', r.req_permission_mode] : []), ...(r.model ? ['--model', r.model] : []), ...(r.effort ? ['--effort', r.effort] : []),
      ...this.#pluginArgs(r), ...(r.session ? ['--resume', r.session] : [])]
    // A minimal env: the login lives in the keychain and HOME, never an API key; no HERDR_* so it is not mistaken for a pane.
    // WT_ROLE / WT_PERSONA (WP-307): a herdr pane's role comes from its pane token, which a headless run has not got; wt-memory's context
    // and the role files read these instead, so it is briefed exactly like a herdr agent of that role.
    const env = { TERM: 'dumb', WT_ROLE: r.role, WT_HEADLESS_ID: id, ...(r.persona ? { WT_PERSONA: r.persona } : {}),
      ...Object.fromEntries(['HOME', 'PATH', 'USER'].filter((k) => this.env[k]).map((k) => [k, this.env[k]])) }
    let child, bin = this.cmd
    if (r.driver === 'sdk') { // WP-315: the same args and stream-json, through the Agent SDK worker; a resume keeps the run's recorded driver
      const testSdk = this.env.WT_HEADLESS_SDK_MODULE
      if (!testSdk && !existsSync(join(dirname(this.worker), 'node_modules/@anthropic-ai/claude-agent-sdk'))) return this.#end(id, 'failed', 'SDK driver not installed: run ./setup')
      const claude = absBin(this.cmd, this.env.PATH)
      if (!claude) return this.#end(id, 'failed', 'claude binary not found')
      env.WT_CLAUDE_BIN = claude
      if (testSdk) env.WT_HEADLESS_SDK_MODULE = testSdk
      args.unshift(this.worker); bin = process.execPath
    }
    try { child = nodeSpawn(bin, args, { cwd: r.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] }) } catch (e) { return this.#end(id, 'failed', `spawn: ${e.message}`) }
    const p = { child, buf: '', skip: false, done: false, exited: false, killing: false, inflight: 0 }
    this.procs.set(id, p)
    this.db.prepare("UPDATE headless_runs SET state = 'starting', pid = ?, started = ?, last_event = ?, reason = NULL WHERE id = ?").run(child.pid ?? null, this.now(), this.now(), id)
    this.#note(id, 'supervisor', { subtype: 'started', pid: child.pid, resume: r.session ?? null })
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8') // a multi-byte char split across chunks stays whole
    child.on('error', (e) => { this.#note(id, 'supervisor', { subtype: 'spawn_error', message: e.message }); p.spawnFailed = true; this.#exit(id, p, null, null, `spawn: ${e.message}`) })
    child.stdin.on('error', () => {}) // EPIPE after exit is handled by 'close'
    child.stdout.on('data', (d) => this.#data(id, p, d))
    child.stderr.on('data', (d) => this.#note(id, 'stderr', { text: String(d).slice(0, 2000) }, false))
    child.on('close', (code, sig) => this.#exit(id, p, code, sig))
    if (r.prompt) { this.#send(id, r.prompt); this.db.prepare('UPDATE headless_runs SET prompt = NULL WHERE id = ?').run(id) }
    // WP-305: claude emits no init until its first turn, so a run started without a prompt would sit in 'starting' for good.
    else this.db.prepare("UPDATE headless_runs SET state = 'idle' WHERE id = ? AND state = 'starting'").run(id)
    this.onChange(id, 'run')
  }
  #data(id, p, d) {
    p.buf += d
    let i
    while ((i = p.buf.indexOf('\n')) >= 0) {
      const line = p.buf.slice(0, i); p.buf = p.buf.slice(i + 1)
      if (p.skip) p.skip = false // the tail of a line already stubbed
      else if (line.trim()) this.#event(id, line)
    }
    // A line still growing past the limit: stub it now and drop the rest of it up to the next newline (memory stays bounded).
    if (p.buf.length > LINE_MAX && !p.skip) { this.#note(id, 'supervisor', { subtype: 'oversized_line', bytes: p.buf.length }); p.skip = true }
    if (p.skip) p.buf = ''
  }
  #event(id, line) {
    let e
    try { e = JSON.parse(line) } catch { return this.#note(id, 'stdout', { text: line.slice(0, 2000) }) }
    const type = e.type + (e.subtype ? '/' + e.subtype : '')
    const p = this.procs.get(id)
    this.db.prepare('UPDATE headless_runs SET stuck = NULL WHERE id = ? AND stuck IS NOT NULL').run(id) // output = the turn is alive
    this.#append(id, type, line.length > LINE_MAX ? JSON.stringify({ type: e.type, subtype: e.subtype, truncated: line.length }) : line, this.now())
    const set = (sql, ...a) => this.db.prepare(`UPDATE headless_runs SET ${sql} WHERE id = ?`).run(...a, id)
    if (e.type === 'system' && e.subtype === 'init') {
      set(`session = ?, plugins = ?, permission_mode = ?, api_key_source = ?, init_model = ?, init_commands = ?, state = CASE WHEN state = 'starting' THEN '${p?.inflight ? 'working' : 'idle'}' ELSE state END`,
        e.session_id ?? null, JSON.stringify((e.plugins ?? []).map((x) => x.name ?? x)), e.permissionMode ?? null, e.apiKeySource ?? null,
        e.model ?? null, JSON.stringify({ slash_commands: e.slash_commands ?? [], skills: e.skills ?? [] }))
    } else if (e.type === 'result') {
      if (p) p.inflight = 0
      set(`state = 'idle', turns = turns + 1, cost_usd = cost_usd + ?`, Number(e.total_cost_usd) || 0)
      const win = contextWindowOf(e.modelUsage, this.run(id)?.init_model) // WP-314: the model's own window, not a guess
      if (win) set('context_window = ?', win)
    } else if (e.type === 'system' && e.subtype === 'context_usage') { // WP-315: the SDK worker's getContextUsage(), after each result
      if (e.maxTokens > 0) set('context_window = ?', e.maxTokens)
      if (Number.isFinite(e.totalTokens)) set('context_used = ?', e.totalTokens)
    } else if (e.type === 'system' && e.subtype === 'commands') {
      let c = {}; try { c = JSON.parse(this.run(id)?.init_commands) ?? {} } catch {}
      set('init_commands = ?', JSON.stringify({ ...c, commands: e.commands ?? [] }))
    } else if (e.type === 'user' || e.type === 'assistant') {
      set(`state = CASE WHEN state IN ('idle','starting') THEN 'working' ELSE state END`)
    } else if (e.type === 'control_request' && e.request?.subtype === 'can_use_tool') {
      this.#toolRequest(id, e)
    } else if (e.type === 'control_cancel_request' && e.request_id) { // claude gave up waiting on a tool decision
      if (this.db.prepare("UPDATE headless_asks SET state = 'expired', note = 'cancelled by the agent' WHERE id = ? AND run_id = ? AND state = 'open'").run(e.request_id, id).changes) this.onChange(id, 'ask')
    }
    this.onChange(id, 'event')
  }
  // can_use_tool: AskUserQuestion always waits for a human; other tools follow the role's policy.
  #toolRequest(id, e) {
    const r = this.run(id), { tool_name: tool, input = {} } = e.request
    const rid = e.request_id
    if (SEND_FILE.test(tool)) return this.#reply(id, rid, { behavior: 'allow', updatedInput: input })
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
  #send(id, text) { this.#write(id, userLine(text)); const p = this.procs.get(id); if (p) p.inflight++ }
  // The one writer of the event log. seq is store-assigned (AUTOINCREMENT, never reused); `touch` false = the row must not reset
  // the idle/stuck clocks. Retention is per run: every PRUNE_EVERY events, rows older than the newest KEEP_EVENTS go.
  #append(id, type, json, t, touch = true) {
    this.db.prepare('INSERT INTO headless_events (run_id, at, type, json) VALUES (?, ?, ?, ?)').run(id, t, type, json)
    const n = this.db.prepare(`UPDATE headless_runs SET events = events + 1${touch ? ', last_event = ' + Number(t) : ''} WHERE id = ? RETURNING events`).get(id)?.events
    if (n && n % PRUNE_EVERY === 0) this.db.prepare('DELETE FROM headless_events WHERE run_id = ? AND seq <= (SELECT MAX(seq) FROM headless_events WHERE run_id = ?) - ?').run(id, id, KEEP_EVENTS)
  }
  #note(id, type, data, touch = true) { this.#append(id, type, JSON.stringify({ type, ...data }), this.now(), touch) }
  #exit(id, p, code, sig, why) {
    if (p.exited) return // 'error' then 'close' for the same child
    p.exited = p.done = true
    if (this.procs.get(id) === p) this.procs.delete(id)
    if (p.buf.trim() && !p.skip) this.#event(id, p.buf) // a last line without its newline
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
    this.#end(id, crashed && (r.state === 'working' || r.state === 'starting') ? 'failed' : 'ended', p.reason || (crashed ? `process ended: ${reason}` : reason))
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
    if (!LIVE.includes(r.state)) return this.get(id) // already ended/failed: nothing to stop
    if (!p || p.done) { if (!p) this.#end(id, 'ended', reason); return this.get(id) } // a live row with no process of ours
    if (p.killing) return this.get(id)
    Object.assign(p, { killing: true, reason })
    try { p.child.stdin.end() } catch { /* already closed */ }
    const t = setTimeout(() => { if (!p.done) try { process.kill(p.child.pid, 'SIGTERM') } catch { /* gone */ } }, this.graceMs)
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
    this.#send(id, text)
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
    this.#note(id, 'supervisor', { subtype: 'interrupt' }, false) // must not reset the stuck clock
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
      if (r.state === 'idle' && this.idleMs && quiet > this.idleMs) { this.stop(r.id, `idle release (${Math.round(quiet / 60_000)} min quiet)`); did.push(['idle', r.id]) }
      else if (r.state === 'working' && quiet > this.stuckMs) {
        // Flag first (a 'stuck' event + the row's `stuck` time, shown by get()); 'interrupt'/'kill' also interrupt; 'kill' then
        // stops the run once graceMs passes without output. Any output clears the flag (#event).
        const p = this.procs.get(r.id)
        if (!r.stuck) {
          this.db.prepare('UPDATE headless_runs SET stuck = ? WHERE id = ?').run(t, r.id)
          this.#note(r.id, 'supervisor', { subtype: 'stuck', quietMs: quiet, action: this.stuckAction }, false)
          this.onChange(r.id, 'run')
          if (this.stuckAction === 'flag') { did.push(['stuck-flag', r.id]); continue }
          try { this.interrupt(r.id) } catch { /* process gone: exit handler runs */ }
          did.push(['stuck-interrupt', r.id])
        } else if (this.stuckAction === 'kill' && p && t - r.stuck > this.graceMs) {
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
      out.push(r.id)
      // WP-304: carry on by session id (a working turn is told to continue, an idle run just gets its process back), up to
      // WT_HEADLESS_RESUMES times; a run with no session or no resumes left is marked failed. Stopped/removed runs are not live.
      if (!r.session || r.resumes >= this.resumes) { this.#end(r.id, 'failed', `server restarted while it was running; ${r.session ? 'resumes exhausted' : 'no session to resume'}`); continue }
      const working = r.state !== 'idle'
      this.db.prepare("UPDATE headless_runs SET state = 'queued', resumes = resumes + 1, pid = NULL, prompt = ? WHERE id = ?")
        .run(working ? 'The server restarted and your process was resumed. Continue where you left off.' : null, r.id)
      this.#note(r.id, 'supervisor', { subtype: 'resumed_after_restart', attempt: r.resumes + 1 })
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
