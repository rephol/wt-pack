// WP-378 U5: test harness for the dashboard's hc reads. NOT a test file (no *.test.mjs): the route tests import it.
//  - terminal(over): a terminal.list row, a RECORDED claude row (wt-shared/scripts/fixtures/hc/connect.json, case claude_states,
//    t2) with the fields a test names overridden; shell()/finished() likewise from the recorded keep shell and finished one-offs.
//  - hcStub({root, terminals}): a PATH-first `hc` for a spawned server (a node script reading <dir>/terminals.json on every call:
//    `connect` terminal.list/terminal.run, `get`, `label`, `read`, `send`, `keys`, `kill`, `rm`, `server status`; anything else exits 99), a core.lock + listening socket so
//    the server's coreUp() says up (down() closes the socket: the core is "stopped"), and the call log.
//  Child env never carries HC_*/HERDR_* from the test process (CLAUDE.md: a child must not act as an agent terminal).
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const rec = (v, c) => JSON.parse(readFileSync(new URL(`../wt-shared/scripts/fixtures/hc/${v}.json`, import.meta.url), 'utf8')).cases[c]
const REC = JSON.parse(rec('connect', 'claude_states').stdout).result.terminals
const CLAUDE = REC.find((t) => t.address === 't2'), SHELL = REC.find((t) => t.keep), FIN = JSON.parse(rec('connect', 'terminal.list_all').stdout).result.terminals.find((t) => t.state === 'finished')
let seq = 100
export function terminal(over = {}) {
  const { status = 'working', labels = {}, ...rest } = over
  const n = seq++
  return { ...CLAUDE, address: `t${n}`, name: `agent-${n}`, labels, title: '', pid: 70000 + n, foreground: { ...CLAUDE.foreground, pid: 70000 + n }, status: status && { app: 'claude-code', state: status }, ...rest }
}
export const shell = (over = {}) => ({ ...SHELL, address: `t${seq++}`, labels: {}, ...over })
export const finished = (over = {}) => ({ ...FIN, address: `t${seq++}`, labels: {}, ...over })

const FAKE = `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path')
const dir = process.env.FAKE_HC_DIR, args = process.argv.slice(2)
const rd = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) } catch { return d } }
const wr = (f, v) => fs.writeFileSync(path.join(dir, f), JSON.stringify(v))
const stdin = args[0] === 'connect' ? fs.readFileSync(0, 'utf8') : ''
fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify({ args, stdin: stdin || undefined, env: { HC_TERMINAL_ID: process.env.HC_TERMINAL_ID } }) + '\\n')
const rows = rd('terminals.json', [])
const bad = (kind, message, exit) => { process.stderr.write(JSON.stringify({ error: { kind, message } }) + '\\n'); process.exit(exit) }
const find = (t) => rows.find((r) => r.address === t || r.name === t)
if (args[0] === 'connect') {
  const q = JSON.parse(stdin.split('\\n')[0])
  if (q.method === 'terminal.run') {
    const pr = q.params || {}
    if (rows.some((r) => r.state === 'live' && r.name === pr.name)) { process.stdout.write(JSON.stringify({ id: q.id, jsonrpc: '2.0', error: { code: -1, message: 'a live terminal is already named ' + pr.name, data: { kind: 'name_taken' } } }) + '\\n'); process.exit(0) }
    const n = 200 + rows.length
    const row = { address: 't' + n, name: pr.name, cwd: pr.cwd || '/', state: 'live', labels: pr.labels || {}, argv: pr.argv, status: null, turn: 0, foreground: { name: 'zsh', argv: pr.argv, pid: 5000 + n }, keep: false }
    rows.push(row); wr('terminals.json', rows)
    process.stdout.write(JSON.stringify({ id: q.id, jsonrpc: '2.0', result: row }) + '\\n'); process.exit(0)
  }
  if (q.method !== 'terminal.list') bad('method_not_found', q.method, 99)
  const list = q.params?.all ? rows : rows.filter((r) => r.state === 'live')
  process.stdout.write(JSON.stringify({ id: q.id, jsonrpc: '2.0', result: { hidden_finished: 0, terminals: list } }) + '\\n')
} else if (args[0] === 'get') {
  const r = find(args[args.length - 1]); if (!r) bad('not_found', 'no terminal', 3)
  process.stdout.write(JSON.stringify(r) + '\\n')
} else if (args[0] === 'label') {
  const r = find(args[2]); if (!r) bad('not_found', 'no terminal', 3)
  for (const kv of args.slice(3)) { const i = kv.indexOf('='); const k = kv.slice(0, i), v = kv.slice(i + 1); if (v === '') delete r.labels[k]; else r.labels[k] = v }
  wr('terminals.json', rows)
  process.stdout.write(JSON.stringify(r) + '\\n')
} else if (args[0] === 'send') {
  // hc send [--json] [--if idle|working] <t> <text>: the recorded refusals (blocked 9, status_mismatch 10, finished 11); a shell has no status
  const rest = args.slice(1).filter((a) => a !== '--json'); let cond = null
  const force = rest.includes('--force'); if (force) rest.splice(rest.indexOf('--force'), 1)
  if (rest[0] === '--if') { cond = rest[1]; rest.splice(0, 2) }
  const r = find(rest[0]); if (!r) bad('not_found', 'no terminal', 3)
  const st = r.status && r.status.state
  if (r.state === 'finished') bad('finished', r.address + ' has finished', 11)
  if (st === 'blocked' && !force) bad('blocked', r.address + ' is blocked (' + (r.status.kind || 'permission') + ')', 9)
  if (cond && st !== cond) bad('status_mismatch', r.address + ' is ' + (st || 'silent') + ', not ' + cond, 10)
  process.stdout.write(JSON.stringify({ started: true, status: st || null, turn: r.turn || 0 }) + '\\n')
} else if (args[0] === 'keys') {
  const r = find(args[2]); if (!r) bad('not_found', 'no terminal', 3)
  process.stdout.write(JSON.stringify({ status: (r.status && r.status.state) || null, turn: r.turn || 0 }) + '\\n')
} else if (args[0] === 'kill') {
  const r = find(args[2]); if (!r) bad('not_found', 'no terminal', 3)
  if (r.state === 'finished') bad('finished', r.address + ' has finished', 11)
  r.state = 'finished'; wr('terminals.json', rows); process.stdout.write(JSON.stringify(r) + '\\n')
} else if (args[0] === 'rm') {
  const i = rows.findIndex((r) => r.address === args[2] || r.name === args[2]); if (i < 0) bad('not_found', 'no terminal', 3)
  const [r] = rows.splice(i, 1); wr('terminals.json', rows); process.stdout.write(JSON.stringify({ removed: r.address }) + '\\n')
} else if (args[0] === 'read') {
  // screens/<t>.seq.json (an array): one screen per --lines 80 read (the picker answer's own; background reads of the pane get the .txt screen), the last one stays (a screen that changes while the server works)
  const q = path.join(dir, 'screens', args[1] + '.seq.json'), seq = rd('screens/' + args[1] + '.seq.json', null)
  if (seq && seq.length && args.includes('80')) { process.stdout.write(seq.length > 1 ? seq.shift() : seq[0]); if (fs.existsSync(q)) wr('screens/' + args[1] + '.seq.json', seq); process.exit(0) }
  const f = path.join(dir, 'screens', args[1] + '.txt'); process.stdout.write(fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '')
} else if (args[0] === 'server' && args[1] === 'status') {
  process.stdout.write(JSON.stringify({ core: rd('core.json', { id: 'core-a', name: 'host' }), live: rows.length, pid: 1, uptime_ms: 1, version: '0.1.16' }) + '\\n')
} else bad('failed', 'fake hc: unrecorded ' + args.join(' '), 99)
`
// A claude on the PATH that lists the sessions a test names: [{sessionId, pid}] in <dir>/claude-agents.json.
const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path')
const a = process.argv.slice(2).join(' ')
if (a === 'agents --json') process.stdout.write(fs.existsSync(path.join(process.env.FAKE_HC_DIR, 'claude-agents.json')) ? fs.readFileSync(path.join(process.env.FAKE_HC_DIR, 'claude-agents.json'), 'utf8') : '[]')
else process.exit(1)
`

export async function hcStub({ root, terminals = [], sessions = {}, core = { id: 'core-a', name: 'host' } } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hcs-')), bin = join(dir, 'bin'), state = join(dir, 'st')
  mkdirSync(bin); mkdirSync(join(dir, 'screens')); mkdirSync(join(state, 'herdr-core', 'default'), { recursive: true })
  writeFileSync(join(bin, 'hc'), FAKE); writeFileSync(join(bin, 'claude'), FAKE_CLAUDE); chmodSync(join(bin, 'hc'), 0o755); chmodSync(join(bin, 'claude'), 0o755)
  const sock = join(dir, 'c.sock'), lock = join(state, 'herdr-core', 'default', 'core.lock')
  let srv = null
  const up = () => new Promise((resolve) => { srv = createServer((c) => c.end()); srv.listen(sock, () => { writeFileSync(lock, sock); resolve() }) })
  const down = () => new Promise((resolve) => { if (!srv) return resolve(); const s = srv; srv = null; s.close(() => { rmSync(sock, { force: true }); resolve() }) })
  const api = {
    dir,
    // env for the spawned server: the stub first on PATH; the real core's session/state never reached
    env: { PATH: `${bin}:${process.env.PATH}`, HC_BIN: join(bin, 'hc'), FAKE_HC_DIR: dir, XDG_STATE_HOME: state, HC_SESSION: 'default', WT_HC_TIMEOUT_SCALE: '5', HC_TERMINAL_ID: '', HC_SCOPE: '', HC_TERMINAL_SOCKET: '' },
    set: (t) => writeFileSync(join(dir, 'terminals.json'), JSON.stringify(t)),
    rows: () => JSON.parse(readFileSync(join(dir, 'terminals.json'), 'utf8')),
    screen: (t, text) => writeFileSync(join(dir, 'screens', `${t}.txt`), text),
    screens: (t, list) => writeFileSync(join(dir, 'screens', `${t}.seq.json`), JSON.stringify(list)),
    sessions: (list) => writeFileSync(join(dir, 'claude-agents.json'), JSON.stringify(list)),
    core: (c) => writeFileSync(join(dir, 'core.json'), JSON.stringify(c)),
    calls: () => (existsSync(join(dir, 'calls.jsonl')) ? readFileSync(join(dir, 'calls.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []),
    up, down,
    close: async () => { await down(); rmSync(dir, { recursive: true, force: true }) },
  }
  api.set(terminals); api.core(core)
  api.sessions(Object.entries(sessions).map(([sessionId, pid]) => ({ sessionId, pid })))
  await up()
  return api
}
