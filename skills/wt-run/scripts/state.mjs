#!/usr/bin/env node
// state.mjs — the wt-lead's resumable run-state for one ticket (WP-368): ~/.local/share/wt-lead/<repo>/<TICKET>.json
//   init <T> [--repo r]      create the file (no-op when it exists), print its path
//   path <T>                 print the file's path
//   get <T> [dotted.key]     print the state, or one key (JSON)
//   set <T> <dotted.key> <value|--file f>   set a key (value parsed as JSON, else a string)
//   start <T> <phase> | done <T> <phase>    mark a phase running / done (sets `phase`)
//   gate <T> <A|B|C> [open [--packet p]|approve|reject ["why"]]   no verb: print the gate's status
//   next <T>                 print the next step: `run <phase>`, `open gate X`, `wait gate X` or `finished`
// Dir: $WT_LEAD_DIR (tests) else ~/.local/share/wt-lead. Repo: --repo, else the main checkout's dir name. No network.
// Exit: 0 ok, 1 error, 2 usage.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

export const PHASES = ['plan', 'gateA', 'work', 'review', 'qa', 'gateB', 'ship', 'babysit', 'gateC']
const REDO = { A: ['plan'], B: ['work', 'review', 'qa'], C: ['babysit'] } // a rejected gate reruns these
const gateOf = (p) => (p.startsWith('gate') ? p.slice(4) : null)
const die = (msg, code = 1) => { process.stderr.write(`state: ${msg}\n`); process.exit(code) }

export function repoName(cwd = process.cwd()) {
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    return basename(dirname(common))
  } catch { return basename(resolve(cwd)) }
}
const safe = (s, what) => { if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(s) || s.includes('..')) die(`bad ${what}: ${s}`, 2); return s }
export const ticketId = (t) => { if (!/^[A-Za-z][A-Za-z0-9]*-\d+$/.test(t || '')) die(`bad ticket id: ${t}`, 2); return t }
export const dirFor = (repo) => join(process.env.WT_LEAD_DIR || join(homedir(), '.local', 'share', 'wt-lead'), safe(repo, 'repo'))
export const fileFor = (repo, ticket) => join(dirFor(repo), `${ticketId(ticket)}.json`)

export function fresh(ticket, repo) {
  const now = new Date().toISOString()
  return {
    ticket, repo, createdAt: now, updatedAt: now, phase: null,
    phases: Object.fromEntries(PHASES.map((p) => [p, { status: 'pending' }])),
    gates: Object.fromEntries(['A', 'B', 'C'].map((g) => [g, { status: 'pending' }])),
    worktree: null, branch: null, plan: null, units: [], open_questions: [],
  }
}
export function load(file) {
  if (!existsSync(file)) die(`no run-state at ${file} (state.mjs init first)`)
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch (e) { die(`unreadable ${file}: ${e.message}`) }
}
export function save(file, st) {
  st.updatedAt = new Date().toISOString()
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(st, null, 2) + '\n')
  renameSync(tmp, file)
}
const BAD = new Set(['__proto__', 'constructor', 'prototype'])
export function setPath(obj, key, value) {
  const parts = key.split('.')
  if (parts.some((p) => !p || BAD.has(p))) die(`bad key: ${key}`, 2)
  let o = obj
  for (const p of parts.slice(0, -1)) { if (typeof o[p] !== 'object' || o[p] === null) o[p] = {}; o = o[p] }
  o[parts.at(-1)] = value
}
export const getPath = (obj, key) => key.split('.').reduce((o, p) => (o == null || BAD.has(p) ? undefined : o[p]), obj)

// next(st) → the one step the lead takes now.
export function next(st) {
  for (const p of PHASES) {
    const g = gateOf(p)
    const s = st.phases[p].status
    if (g) {
      const gs = st.gates[g].status
      if (gs === 'approved') continue
      return gs === 'open' ? `wait gate ${g}` : `open gate ${g}`
    }
    if (s !== 'done') return `run ${p}`
  }
  return 'finished'
}

function main(argv) {
  let repo = null
  const a = []
  for (let i = 0; i < argv.length; i++) { if (argv[i] === '--repo') repo = argv[++i]; else a.push(argv[i]) }
  const [cmd, t, ...rest] = a
  if (!cmd || cmd === '-h' || cmd === '--help') { process.stderr.write(readFileSync(import.meta.filename, 'utf8').split('\n').slice(1, 12).map((l) => l.replace(/^\/\/ ?/, '')).join('\n') + '\n'); process.exit(2) }
  const file = fileFor(repo || repoName(), t)
  const out = (v) => console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2))
  if (cmd === 'path') return out(file)
  if (cmd === 'init') {
    if (!existsSync(file)) save(file, fresh(t, repo || repoName()))
    return out(file)
  }
  const st = load(file)
  if (cmd === 'get') return out(rest[0] ? getPath(st, rest[0]) ?? null : st)
  if (cmd === 'next') return out(next(st))
  if (cmd === 'set') {
    if (!rest[0]) die('set <T> <key> <value|--file f>', 2)
    let raw = rest[1]
    if (rest[1] === '--file') raw = readFileSync(rest[2], 'utf8')
    if (raw === undefined) die('set needs a value', 2)
    let v = raw
    try { v = JSON.parse(raw) } catch { /* a plain string */ }
    setPath(st, rest[0], v); save(file, st); return out('ok')
  }
  if (cmd === 'start' || cmd === 'done') {
    const p = rest[0]
    if (!PHASES.includes(p) || gateOf(p)) die(`phase must be one of ${PHASES.filter((x) => !gateOf(x)).join(' ')}`, 2)
    st.phases[p] = { ...st.phases[p], status: cmd === 'start' ? 'running' : 'done', [cmd === 'start' ? 'startedAt' : 'doneAt']: new Date().toISOString() }
    st.phase = p; save(file, st); return out('ok')
  }
  if (cmd === 'gate') {
    const g = rest[0]
    if (!REDO[g]) die('gate <T> <A|B|C> [open|approve|reject]', 2)
    const verb = rest[1]
    const gate = st.gates[g]
    if (!verb) return out(gate.status)
    if (verb === 'open') {
      const i = rest.indexOf('--packet')
      Object.assign(gate, { status: 'open', openedAt: new Date().toISOString(), ...(i > 0 ? { packet: rest[i + 1] } : {}) })
      st.phase = `gate${g}`
    } else if (verb === 'approve') {
      if (gate.status !== 'open') die(`gate ${g} is ${gate.status}, not open`)
      Object.assign(gate, { status: 'approved', decidedAt: new Date().toISOString() })
      st.phases[`gate${g}`] = { status: 'done' }
    } else if (verb === 'reject') {
      if (gate.status !== 'open') die(`gate ${g} is ${gate.status}, not open`)
      Object.assign(gate, { status: 'pending', rejected: rest[2] || true, decidedAt: new Date().toISOString() })
      for (const p of REDO[g]) st.phases[p] = { status: 'pending' }
    } else die(`unknown gate verb: ${verb}`, 2)
    save(file, st); return out(gate.status)
  }
  die(`unknown command: ${cmd}`, 2)
}
if (import.meta.filename === process.argv[1]) main(process.argv.slice(2))
