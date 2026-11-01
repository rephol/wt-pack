#!/usr/bin/env node
// WP-378: the one place node code talks to hc (herdr-core). No deps. Shell callers call `hc` directly, except spawn:
//   node hc.mjs spawn --name N | --prefix P  --cwd D  [--label k=v]...  [--launch <script> --env-names A,B]  [--taken a,b]  [--roles r,r] -- <argv...>
//   node hc.mjs core-up        exit 0 when the core answers, 1 when it is down (never starts it)
// Import it DYNAMICALLY inside the subcommand that needs it (CLAUDE.md: a top-level import makes every subcommand depend on it).
//
// What the recordings (fixtures/hc, hc 0.1.16) taught, and the code below relies on:
//  - `hc ls --json` is a slim summary (no labels, no foreground); the full rows (labels, status object, foreground, argv)
//    are `terminal.list` over `hc connect`, ONE call for the whole tick: list() uses that.
//  - errors are `{"error":{kind,message,hint}}` on STDERR; exit 9 blocked, 10 status_mismatch, 11 finished, 3 not_found.
//  - an agent that finished a turn rests at status `done`, and `--if idle` refuses `done`: send({ifIdle}) retries a plain send.
//  - hc stores any label (no limits): the pack's 32 labels / 80-char values / key shape / known roles are enforced here.
//  - a kept (recovered) terminal is a login shell at the same address and has lost its labels.
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { connect as netConnect } from 'node:net'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

export const MAX_LABELS = 32
export const MAX_VALUE = 80
export const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/
export const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/
// Per-verb budgets (ms). `wait` has none: the caller's deadline decides.
export const TIMEOUT = { list: 2000, get: 2000, label: 2000, send: 8000, keys: 2000, read: 5000, kill: 5000, rm: 5000, interrupt: 12_000, run: 15_000, server: 3000 }
const EXIT_KIND = { 3: 'not_found', 6: 'invalid_params', 7: 'needs_target', 9: 'blocked', 10: 'status_mismatch', 11: 'finished', 124: 'timeout' }
const SHELLS = new Set(['sh', 'bash', 'zsh', 'fish', 'nu', 'dash', 'ksh', 'tcsh', 'csh', 'login'])

export class HcError extends Error {
  constructor(kind, message, { hint, exit, args } = {}) {
    super(message)
    this.name = 'HcError'
    this.kind = kind
    this.hint = hint
    this.exit = exit
    this.args = args
  }
}

const bin = (env) => (env ?? process.env).HC_BIN || 'hc'
// hc's own --timeout is whole seconds; ours is ms. The process timeout sits above it so hc reports its own check-in.
export const secondsOf = (ms) => Math.max(1, Math.ceil(ms / 1000))

function parseError(stderr, stdout, exit) {
  for (const s of [stderr, stdout]) {
    try { const e = JSON.parse(String(s).trim().split('\n').pop()).error; if (e?.kind) return e } catch {}
  }
  return { kind: EXIT_KIND[exit] ?? 'failed', message: String(stderr || stdout).trim().slice(0, 300) || `hc exited ${exit}` }
}

// hc(args, {timeoutMs, input, text, env}) -> parsed JSON (default) or raw text. Throws HcError.
export function hc(args, { timeoutMs = TIMEOUT.get, input, text = false, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(bin(env), args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: env ?? process.env }, (err, stdout, stderr) => {
      if (!err) {
        if (text) return resolve(stdout)
        try { return resolve(JSON.parse(stdout)) } catch { return reject(new HcError('bad_output', `hc ${args[0]}: not JSON: ${stdout.slice(0, 120)}`, { args })) }
      }
      if (err.code === 'ENOENT') return reject(new HcError('unavailable', 'hc is not installed (not on PATH)', { args }))
      if (err.killed || err.signal) return reject(new HcError('timeout', `hc ${args[0]} timed out after ${timeoutMs} ms`, { exit: -1, args }))
      const e = parseError(stderr, stdout, err.code)
      reject(new HcError(e.kind, e.message, { hint: e.hint, exit: err.code, args }))
    })
    if (input != null) child.stdin.end(input)
  })
}

// ---- terminals --------------------------------------------------------------------------------------------------------

const baseName = (p) => basename(String(p ?? ''))
// One row of terminal.list / terminal.get -> the shape the pack uses.
export function normalise(r) {
  const fg = r.foreground ?? null
  const argv0 = baseName((fg?.argv ?? r.argv ?? [])[0])
  const st = r.status && typeof r.status === 'object' ? r.status : null
  return {
    id: r.address,
    name: r.name ?? null,
    cwd: r.cwd ?? null,
    status: st?.state ?? null, // idle | working | done | blocked | error | null (a plain program reports none)
    statusKind: st?.kind ?? null, // permission | question when blocked
    statusMsg: st?.msg ?? null,
    app: st?.app ?? null,
    labels: r.labels ?? {},
    alive: r.state === 'live',
    state: r.state,
    exitCode: r.exit_code ?? null,
    reason: r.reason ?? null,
    foreground: fg ? { name: fg.name ?? null, argv: fg.argv ?? [], pid: fg.pid ?? null } : null,
    program: argv0 || null, // basename of argv[0]: `claude` (the foreground's own `name` is its version string), `zsh`, ...
    turn: r.turn ?? 0,
    title: r.title ?? '',
    keep: !!r.keep,
    parent: r.parent ?? null,
    createdMs: r.created_ms ?? null,
  }
}
// agent = a live terminal running claude or reporting a status; shell = a live login shell (a keep shell at an agent's address).
export const isAgent = (t) => t.alive && (t.status != null || t.program === 'claude')
export const isShell = (t) => t.alive && t.status == null && SHELLS.has((t.program ?? '').replace(/^-/, ''))

// JSON-RPC over `hc connect` (one process, one request). Returns the result or throws HcError.
export async function rpc(method, params = {}, { timeoutMs = TIMEOUT.list, env } = {}) {
  const line = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) + '\n'
  const out = await hc(['connect'], { timeoutMs, input: line, text: true, env })
  let msg
  try { msg = JSON.parse(out.split('\n').find((l) => l.trim())) } catch { throw new HcError('bad_output', `hc connect ${method}: not JSON`) }
  if (msg.error) throw new HcError(msg.error.data?.kind ?? 'failed', msg.error.message ?? String(msg.error.data?.kind), { hint: msg.error.data?.hint })
  return msg.result
}

// Every terminal in ONE call. A `machine/t7` row (another machine's terminal) is dropped: the pack has no remote support.
export async function list({ all = false, env } = {}) {
  const res = await rpc('terminal.list', { all }, { env })
  return (res.terminals ?? []).filter((r) => !String(r.address).includes('/')).map(normalise)
}
export async function get(t, { env } = {}) {
  return normalise(await hc(['get', '--json', t], { timeoutMs: TIMEOUT.get, env }))
}

// ---- labels (the pack's pane tokens) -----------------------------------------------------------------------------------
const cut = (v) => [...String(v)].slice(0, MAX_VALUE).join('')
// Pure: which of `want` can be set on a terminal that already carries `current`. '' (or null) clears.
export function planLabels(want, current = {}, { roles } = {}) {
  const set = {}, clear = [], dropped = []
  const known = roles ? new Set(roles) : null
  for (const [k, v] of Object.entries(want)) {
    if (!KEY_RE.test(k)) throw new HcError('invalid_label', `bad label key ${JSON.stringify(k)}`)
    if (v === '' || v == null) { clear.push(k); continue }
    if (k === 'role' && known && !known.has(String(v))) { dropped.push(k); continue }
    set[k] = cut(v)
  }
  const final = { ...current, ...set }
  for (const k of clear) delete final[k]
  if (Object.keys(final).length > MAX_LABELS) throw new HcError('too_many_labels', `a terminal carries at most ${MAX_LABELS} labels`)
  return { set, clear, dropped }
}
export async function setLabels(t, want, { current, roles, env } = {}) {
  const cur = current ?? (Object.keys(want).some((k) => want[k] !== '' && want[k] != null) ? (await get(t, { env })).labels : {})
  const { set, clear, dropped } = planLabels(want, cur, { roles })
  const args = [...Object.entries(set).map(([k, v]) => `${k}=${v}`), ...clear.map((k) => `${k}=`)]
  if (!args.length) return { labels: cur, dropped }
  const row = normalise(await hc(['label', '--json', t, ...args], { timeoutMs: TIMEOUT.label, env }))
  return { labels: row.labels, dropped }
}
export const clearLabel = (t, ...keys) => setLabels(t, Object.fromEntries(keys.map((k) => [k, ''])), { current: {} })

// ---- talking ------------------------------------------------------------------------------------------------------------
// Never --force: a blocked agent throws kind `blocked` and the caller queues the message. ifIdle types only while the agent
// is idle, or rests at `done` (hc refuses `--if idle` for done, which is the normal resting state after a turn); a shell
// has no status, so hc refuses it too and nothing is typed into it.
export async function send(t, text, { ifIdle = false, ifWorking = false, env } = {}) {
  const args = ['send', '--json', ...(ifIdle ? ['--if', 'idle'] : ifWorking ? ['--if', 'working'] : []), t, text]
  try {
    return await hc(args, { timeoutMs: TIMEOUT.send, env })
  } catch (e) {
    if (ifIdle && e.kind === 'status_mismatch' && /\bis done, not idle\b/.test(e.message)) {
      return { ...(await hc(['send', '--json', t, text], { timeoutMs: TIMEOUT.send, env })), restedAsDone: true }
    }
    throw e
  }
}
export const keys = (t, ...k) => hc(['keys', '--json', t, ...k], { timeoutMs: TIMEOUT.keys })
// Plain text only (no ANSI): `lines` of history above the screen.
export async function read(t, { lines = 0, env } = {}) {
  return hc(['read', t, '--lines', String(lines)], { timeoutMs: TIMEOUT.read, text: true, env })
}
export const interrupt = (t, { timeoutMs = 10_000 } = {}) => hc(['interrupt', '--json', t, '--timeout', String(secondsOf(timeoutMs))], { timeoutMs: timeoutMs + 3000 })
export const kill = (t) => hc(['kill', '--json', t], { timeoutMs: TIMEOUT.kill })
export const rm = (t) => hc(['rm', '--json', t], { timeoutMs: TIMEOUT.rm })
// Retire a terminal: end its program, then remove the record. Already gone / already finished is fine.
export async function killRm(t) {
  try { await kill(t) } catch (e) { if (!['not_found', 'finished'].includes(e.kind)) throw e }
  try { await rm(t) } catch (e) { if (e.kind !== 'not_found') throw e }
}

// One hc wait of at most `timeoutMs` (hc takes seconds; our process timeout is above it).
export function wait(t, { timeoutMs = 60_000, output, children, env } = {}) {
  const args = ['wait', '--json', ...(t ? [t] : []), ...(children ? ['--children', children] : []), ...(output ? ['--output', output] : []), '--timeout', String(secondsOf(timeoutMs))]
  return hc(args, { timeoutMs: secondsOf(timeoutMs) * 1000 + 3000, env })
}
// Wait until the deadline: a check-in (`ended:false`) or a message to the waiter ends one hc wait, not ours.
export async function waitUntil(t, { deadlineMs, until = (r) => r.ended && r.reason !== 'message', ...o } = {}) {
  const end = Date.now() + deadlineMs
  for (;;) {
    const left = end - Date.now()
    if (left <= 0) return { ended: false, reason: 'timeout' }
    const r = await wait(t, { ...o, timeoutMs: Math.min(left, 60_000) })
    if (until(r)) return r
  }
}

// ---- names and spawn ----------------------------------------------------------------------------------------------------
// <prefix>-NN with the lowest free NN; `taken` = every name that must not be reused (hc ls --all names, agents-table names).
export function nextName(prefix, taken = []) {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(prefix)) throw new HcError('invalid_params', `bad name prefix ${JSON.stringify(prefix)}`)
  const used = new Set(taken)
  for (let n = 1; n < 1000; n++) {
    const name = `${prefix}-${String(n).padStart(2, '0')}`
    if (!NAME_RE.test(name)) throw new HcError('invalid_params', `name ${JSON.stringify(name)} is longer than 32 characters`)
    if (!used.has(name)) return name
  }
  throw new HcError('invalid_params', `no free name under ${prefix}`)
}

// terminal.run over `hc connect` (WP-378 D3): the one spawn shape. Always detached from the spawner (`outlive_parent`) and silent
// towards its parent (`no_notify`). `runEnv` is the terminal's environment on top of the core's: it travels in the request body
// (stdin of the hc process), so a secret is in neither a command line nor a file. With `launch` (hc-launch) the program is
// `<launch> -- <argv>` and `WT_LAUNCH_KEYS` names the keys the spawner set, so the launcher keeps those and scrubs the rest.
export async function spawn({ name, cwd, labels = {}, argv, launch, runEnv = {}, roles, env } = {}) {
  if (!NAME_RE.test(name ?? '')) throw new HcError('invalid_params', `bad name ${JSON.stringify(name)}`)
  if (!argv?.length) throw new HcError('invalid_params', 'spawn needs a program')
  const { set } = planLabels(labels, {}, { roles })
  const termEnv = { ...runEnv }
  if (launch) termEnv.WT_LAUNCH_KEYS = Object.keys(runEnv).join(',')
  const params = { argv: launch ? [launch, '--', ...argv] : argv, env: termEnv, labels: set, name, no_notify: true, outlive_parent: true }
  if (cwd) params.cwd = cwd
  const row = await rpc('terminal.run', params, { timeoutMs: TIMEOUT.run, env })
  return { id: row.address, name: row.name ?? name }
}
// Pick the next free <prefix>-NN and spawn it; on `name_taken` (a race with another spawner) take the next number, max 3 tries.
export async function spawnNumbered({ prefix, taken = [], ...o } = {}) {
  const used = new Set(taken)
  for (let i = 0; ; i++) {
    const name = nextName(prefix, used)
    try { return await spawn({ ...o, name }) } catch (e) {
      if (e.kind !== 'name_taken' || i >= 2) throw e
      used.add(name)
    }
  }
}

// ---- the core ------------------------------------------------------------------------------------------------------------
// Is the core up? Does NOT start it (`hc server status`, `ls`, `get` all start a stopped core on macOS — spike S5): reads the
// socket path from core.lock and connects to it. HC_SESSION / XDG_STATE_HOME pick the same core hc would.
export function coreUp({ env = process.env, timeoutMs = 400 } = {}) {
  const state = env.XDG_STATE_HOME || join(homedir(), '.local', 'state')
  const session = env.HC_SESSION || 'default'
  let sock
  try { sock = readFileSync(join(state, 'herdr-core', session, 'core.lock'), 'utf8').trim() } catch { return Promise.resolve(false) }
  if (!sock) return Promise.resolve(false)
  return new Promise((resolve) => {
    const s = netConnect(sock)
    const done = (ok) => { s.destroy(); resolve(ok) }
    s.setTimeout(timeoutMs, () => done(false))
    s.once('connect', () => done(true))
    s.once('error', () => done(false))
  })
}

// ---- CLI (agents.sh spawn, core-up) -------------------------------------------------------------------------------------
const EXIT_OF_KIND = { invalid_params: 6, not_found: 3 }
async function cli(argv) {
  const [cmd, ...rest] = argv
  if (cmd === 'core-up') process.exit((await coreUp()) ? 0 : 1)
  if (cmd !== 'spawn') { console.error('usage: hc.mjs spawn --name N | --prefix P --cwd D [--label k=v]... [--launch S --env-names A,B] [--taken a,b] [--roles r,r] -- <argv...> | core-up'); process.exit(2) }
  const dd = rest.indexOf('--')
  const flags = rest.slice(0, dd < 0 ? rest.length : dd), prog = dd < 0 ? [] : rest.slice(dd + 1)
  const o = { labels: {}, runEnv: {} }, taken = []
  for (let i = 0; i < flags.length; i++) {
    const f = flags[i], v = flags[i + 1]
    if (f === '--name') { o.name = v; i++ } else if (f === '--prefix') { o.prefix = v; i++ } else if (f === '--cwd') { o.cwd = v; i++ }
    else if (f === '--label') { const k = v.indexOf('='); o.labels[v.slice(0, k)] = v.slice(k + 1); i++ }
    else if (f === '--launch') { o.launch = v; i++ }
    // the VALUES come from this process's own environment (set by the caller for this one call), never from argv
    else if (f === '--env-names') { for (const n of v.split(',').filter(Boolean)) { if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(n) || process.env[n] == null) { console.error(`hc.mjs: --env-names: ${n} is not set`); process.exit(2) } o.runEnv[n] = process.env[n] } i++ }
    else if (f === '--taken') { taken.push(...v.split(',').filter(Boolean)); i++ } else if (f === '--roles') { o.roles = v.split(',').filter(Boolean); i++ }
    else { console.error(`hc.mjs: unknown flag ${f}`); process.exit(2) }
  }
  try {
    const r = o.prefix ? await spawnNumbered({ ...o, taken, argv: prog }) : await spawn({ ...o, argv: prog })
    console.log(JSON.stringify(r))
  } catch (e) {
    console.error(JSON.stringify({ error: { kind: e.kind ?? 'failed', message: e.message, hint: e.hint } }))
    process.exit(e.exit > 0 ? e.exit : EXIT_OF_KIND[e.kind] ?? 1)
  }
}
if (import.meta.url === `file://${process.argv[1]}`) cli(process.argv.slice(2))
