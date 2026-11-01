// Run: node --test hcwrite.routes.test.mjs — WP-378 U6: the dashboard's WRITE side on hc. Real server process, isolated data dir and HOME, stubbed hc core
// (test-hc.mjs, with send/keys/kill/rm/terminal.run). Agents: t1 working, t2 idle, t3 blocked on a permission dialog, t4 a plain login shell (no status).
// The pack never forces a send; a blocked agent waits (queued, not counted); a shell is never typed into; a stopped core is 503.
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { hcStub, terminal, shell } from './test-hc.mjs'
import { parsePicker } from './server.mjs'

const claude = (address, name, status, extra = {}) => terminal({ address, name, status, cwd: '/tmp', labels: { role: 'worker' }, pid: 40 + Number(address.slice(1)), foreground: { name: '2.1', argv: ['claude'], cwd: '/tmp', pid: 40 + Number(address.slice(1)) }, ...extra })
const T = () => [
  claude('t1', 'demo-worker-01', 'working'),
  claude('t2', 'demo-worker-02', 'idle'),
  { ...claude('t3', 'demo-worker-03', 'idle'), status: { app: 'claude-code', state: 'blocked', kind: 'permission', msg: 'approve Write: x' } },
  shell({ address: 't4', name: 'plain-sh', cwd: '/tmp' }),
]
const K1 = 'a'.repeat(64)
let hc, child, base, cookie, root
const PORT = 30000 + Math.floor(Math.random() * 20000)
const LABEL = hostname()
const J = { 'content-type': 'application/json' }
const post = (path, body, headers = {}) => fetch(`${base}${path}`, { method: 'POST', headers: { ...J, cookie, ...headers }, body: JSON.stringify(body ?? {}) })
const sent = (verb, t) => hc.calls().filter((c) => c.args[0] === verb && c.args.includes(t))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'wt-hcw-'))
  mkdirSync(join(root, 'data'), { recursive: true }); mkdirSync(join(root, 'pane-keys'))
  writeFileSync(join(root, 'pane-keys', 't1'), K1)
  hc = await hcStub({ terminals: T() })
  child = spawn(process.execPath, ['server.mjs'], { cwd: import.meta.dirname, stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, PORT: String(PORT), WT_DASHBOARD_DATA: root, HOME: root, ...hc.env } })
  base = `http://127.0.0.1:${PORT}`
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/api/push`)).ok) break } catch { /* not up yet */ } await sleep(100) }
  cookie = `hd_session=${readFileSync(join(root, 'session'), 'utf8').trim()}`
  await fetch(`${base}/api/rooms`, { headers: { cookie } }) // loads the rooms (roomAuthor needs them)
  for (let i = 0; i < 20; i++) { if ((await fetch(`${base}/api/agents`)).status === 200) break; await sleep(250) }
})
after(async () => { child?.kill(); await hc?.close() })

test('a user message to an idle agent is ONE plain `hc send` (never --force)', async () => {
  const r = await post(`/api/agents/${LABEL}/t2`, { text: 'hello there' })
  assert.equal(r.status, 200)
  const s = sent('send', 't2')
  assert.equal(s.length, 1)
  assert.deepEqual(s[0].args, ['send', '--json', 't2', 'hello there'])
  assert.ok(!hc.calls().some((c) => c.args.includes('--force')))
})

test('a user message to a BLOCKED agent is refused (409) and nothing is typed into its dialog', async () => {
  const r = await post(`/api/agents/${LABEL}/t3`, { text: 'yes do it' })
  assert.equal(r.status, 409)
  assert.match((await r.json()).error, /blocked/)
  assert.equal(sent('send', 't3').length, 0)
})

test('a plain shell is never typed into through the agent route (409, no send)', async () => {
  const r = await post(`/api/agents/${LABEL}/t4`, { text: 'rm -rf /' })
  assert.equal(r.status, 409)
  assert.match((await r.json()).error, /not an agent/)
  assert.equal(sent('send', 't4').length, 0)
})

test('keys and Stop go through `hc keys` (hc names), Stop only to a working agent', async () => {
  assert.equal((await post(`/api/agents/${LABEL}/t2`, { keys: ['esc', 'enter'] })).status, 200)
  assert.deepEqual(sent('keys', 't2')[0].args, ['keys', '--json', 't2', 'esc', 'enter'])
  assert.equal((await post(`/api/agents/${LABEL}/t1/stop`, {})).status, 200)
  assert.deepEqual(sent('keys', 't1')[0].args, ['keys', '--json', 't1', 'esc'])
  assert.equal((await post(`/api/agents/${LABEL}/t2/stop`, {})).status, 409) // idle: Esc would clear its input
})

test('a free-text picker answer is refused before any key (it would have to be typed into a blocked agent); a plain option is just keys', async () => {
  const screen = readFileSync(new URL('./test-fixtures/picker-single-question.txt', import.meta.url), 'utf8')
  const pk = parsePicker(screen)
  hc.screen('t3', screen)
  const before = sent('keys', 't3').length
  const r = await post(`/api/agents/${LABEL}/t3/answer`, { action: 'answer', question: pk.question, selected: [], other: 'my own words' })
  const out = await r.json()
  assert.equal(r.status, 409, JSON.stringify(out))
  assert.match(out.error, /terminal/)
  assert.equal(sent('keys', 't3').length, before, 'no key pressed')
  assert.equal(sent('send', 't3').length, 0)
  const ok = await post(`/api/agents/${LABEL}/t3/answer`, { action: 'answer', question: pk.question, selected: [pk.options[0].label] })
  assert.equal(ok.status, 200)
  assert.deepEqual(sent('keys', 't3').at(-1).args, ['keys', '--json', 't3', '1'])
})

test('a server send to a blocked agent is queued: no send, the row stays queued with 0 attempts; once unblocked it is typed and counted', async () => {
  const r = await fetch(`${base}/api/watch-prs/event`, { method: 'POST', headers: { ...J, 'x-wt-poller': '1' }, body: JSON.stringify({ pane: 't3', event: 'resumed', minutes: '5' }) })
  const ev = await r.json()
  assert.equal(r.status, 200, JSON.stringify(ev))
  assert.equal(ev.delivery, 'queued')
  assert.equal(sent('send', 't3').length, 0)
  const rows = await (await fetch(`${base}/api/messages`, { headers: { cookie } })).json()
  const row = rows.find((m) => m.target === 't3')
  assert.ok(row, JSON.stringify(rows))
  assert.deepEqual([row.state, row.attempts], ['queued', 0])
  // the agent answers its dialog and goes idle; the queue (flushed every 10 s) types it, once
  const rowsT = hc.rows(); rowsT.find((t) => t.address === 't3').status = { app: 'claude-code', state: 'idle' }; hc.set(rowsT)
  hc.screen('t3', '❯ earlier prompt\n\n──────────────────────────────\n❯ \n──────────────────────────────\n')
  for (let i = 0; i < 40 && !sent('send', 't3').length; i++) await sleep(500)
  assert.equal(sent('send', 't3').length, 1)
  assert.ok(!hc.calls().some((c) => c.args.includes('--force')))
  for (let i = 0; i < 20; i++) { const m = (await (await fetch(`${base}/api/messages`, { headers: { cookie } })).json()).find((x) => x.target === 't3'); if (m.state === 'delivered') { assert.equal(m.attempts, 1); return } await sleep(250) }
  assert.fail('the queued row was never marked delivered')
})

test('Terminals: create, list, type, keys, rename and close a shell on hc (plain text); an agent is never a Terminal', async () => {
  assert.equal((await post('/api/terminal-settings', { enabled: true })).status, 200)
  const c = await post('/api/terminals', { cwd: root, name: 'build' })
  const made = await c.json()
  assert.equal(c.status, 200, JSON.stringify(made))
  assert.match(made.pane, /^t\d+$/)
  const run = hc.calls().find((x) => x.stdin?.includes('terminal.run'))
  const params = JSON.parse(run.stdin.split('\n')[0]).params
  assert.match(params.name, /^sh-[a-z0-9_-]+-\d\d$/)
  assert.deepEqual([params.labels['wt.pool'].endsWith('-shells'), params.labels['wt.title'], params.argv.at(-1)], [true, 'build', '-l'])
  const list = await (await fetch(`${base}/api/terminals`, { headers: { cookie } })).json()
  assert.deepEqual(list.map((s) => [s.pane, s.name]), [[made.pane, 'build']])
  const inp = (body) => post(`/api/terminals/${made.pane}/input`, body)
  assert.equal((await inp({ text: 'ls -la', submit: true })).status, 200)
  assert.deepEqual(sent('send', made.pane)[0].args, ['send', '--json', made.pane, 'ls -la'])
  assert.equal((await inp({ keys: ['C-c'] })).status, 200)
  assert.deepEqual(sent('keys', made.pane)[0].args, ['keys', '--json', made.pane, 'ctrl+c'])
  assert.equal((await inp({ text: 'ls' })).status, 200) // no Enter: key by key
  assert.deepEqual(sent('keys', made.pane)[1].args, ['keys', '--json', made.pane, 'l', 's'])
  assert.equal((await inp({ text: 'Ls' })).status, 400) // a capital would arrive lowercase: refused, not changed
  assert.equal(sent('keys', made.pane).length, 2)
  assert.equal((await inp({ submit: true })).status, 200)
  assert.deepEqual(sent('keys', made.pane)[2].args.slice(-1), ['enter'])
  assert.equal((await post(`/api/terminals/t1/input`, { text: 'x', submit: true })).status, 404) // t1 is an agent
  assert.equal((await post(`/api/terminals/t4/input`, { text: 'x', submit: true })).status, 404) // t4 is somebody's shell, not ours
  assert.equal(sent('send', 't1').length + sent('send', 't4').length, 0)
  const ren = await fetch(`${base}/api/terminals/${made.pane}`, { method: 'PATCH', headers: { ...J, cookie }, body: JSON.stringify({ name: 'tests' }) })
  assert.equal(ren.status, 200)
  assert.ok(hc.calls().some((x) => x.args[0] === 'label' && x.args.includes('wt.title=tests')))
  const del = await fetch(`${base}/api/terminals/${made.pane}`, { method: 'DELETE', headers: { cookie } })
  assert.equal(del.status, 200)
  assert.ok(sent('kill', made.pane).length === 1 && sent('rm', made.pane).length === 1)
  assert.deepEqual(await (await fetch(`${base}/api/terminals`, { headers: { cookie } })).json(), [])
})

test('a stopped hc core is 503, not 500 (a route that calls agents() uncaught)', async () => {
  rowsExited()
  await hc.down()
  await sleep(1200) // coreUp() answers once a second
  const r = await post('/api/agents/by-name/demo-worker-08/forget', {}, { 'x-herdr-pane': 't1', 'x-wt-pane-key': K1 })
  const body = await r.json()
  assert.equal(r.status, 503, JSON.stringify(body))
  assert.match(body.error, /hc core not running/)
  await hc.up()
})
function rowsExited() {
  // an exited row so the forget route reaches agents()
  const { DatabaseSync } = require_sqlite()
  const db = new DatabaseSync(join(root, 'data', 'wt.db'))
  db.prepare('INSERT OR IGNORE INTO agents (name, state, created_at) VALUES (?, ?, 1)').run('demo-worker-08', 'exited'); db.close()
}
function require_sqlite() { return globalThis.__sqlite ??= { DatabaseSync: _DatabaseSync } }
import { DatabaseSync as _DatabaseSync } from 'node:sqlite'
