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
const plain = (t) => sent('send', t).filter((c) => !c.args.includes('--force'))
const forced = () => hc.calls().filter((c) => c.args.includes('--force'))
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

// F6: single-select, the cursor moved to the "Type something" row (the screen after key [n+1])
const onOther = (screen) => screen.replace('❯ 1. Red', '  1. Red').replace('  4. Type something.', '❯ 4. Type something.')
test('a free-text single-select picker answer: key [n+1] then ONE forced `hc send` (paste + Enter); a plain option is just keys (D26)', async () => {
  const screen = readFileSync(new URL('./test-fixtures/picker-single-question.txt', import.meta.url), 'utf8')
  const pk = parsePicker(screen)
  hc.screen('t3', screen)
  hc.screens('t3', [screen, onOther(screen)]) // the plan's read, then the re-read after key [n+1] (F6: the cursor must sit on the Other row)
  const r = await post(`/api/agents/${LABEL}/t3/answer`, { action: 'answer', question: pk.question, selected: [], other: 'my own words' })
  const out = await r.json()
  assert.equal(r.status, 200, JSON.stringify(out))
  assert.deepEqual(sent('keys', 't3').at(-1).args, ['keys', '--json', 't3', String(pk.options.length + 1)])
  const s = sent('send', 't3')
  assert.equal(s.length, 1)
  assert.deepEqual(s[0].args, ['send', '--json', '--force', 't3', 'my own words'])
  assert.equal(sent('keys', 't3').filter((c) => c.args.includes('enter')).length, 0, 'the forced send submits: no separate Enter')
  const ok = await post(`/api/agents/${LABEL}/t3/answer`, { action: 'answer', question: pk.question, selected: [pk.options[0].label] })
  assert.equal(ok.status, 200)
  assert.deepEqual(sent('keys', 't3').at(-1).args, ['keys', '--json', 't3', '1'])
  hc.screens('t3', [])
})

test('F6: a forced single-select text send needs the cursor on the Other row, and the SAME kind of question (a multiSelect-only change is a 409)', async () => {
  const single = readFileSync(new URL('./test-fixtures/picker-single-question.txt', import.meta.url), 'utf8')
  const sides = single.replace(/Which color\?(?![\s\S]*Which color\?)/, 'Pick sides?') // a single-select asking the multi screen's question text
  const ans = () => post(`/api/agents/${LABEL}/t3/answer`, { action: 'answer', question: 'Pick sides?', selected: [], other: 'sneaky' })
  const attempt = async (screens) => { hc.screens('t3', screens); const f0 = forced().length; const r = await ans(); return { status: r.status, body: await r.json(), forced: forced().slice(f0) } }
  // the cursor is still on option 1 when the text would be pasted: it would land on Red, not in the Other field
  let o = await attempt([sides, sides])
  assert.equal(o.status, 409, JSON.stringify(o.body)); assert.match(o.body.error, /cursor|free-text/); assert.deepEqual(o.forced, [])
  // same question text, but now a multi-select picker: nothing forced
  o = await attempt([sides, multi()])
  assert.equal(o.status, 409, JSON.stringify(o.body)); assert.deepEqual(o.forced, [], 'a multiSelect-only change: nothing forced')
  // control: cursor on Other, same kind → forced
  o = await attempt([sides, onOther(sides)])
  assert.equal(o.status, 200, JSON.stringify(o.body)); assert.equal(o.forced.length, 1)
  hc.screens('t3', []); hc.screen('t3', '')
})

// The multi-select picker as hc 0.1.16 draws it (captured live, D26): a forced paste+Enter commits the Other text but leaves its row unticked.
const LINE = '─'.repeat(100)
const multi = (other, onOther = false) => ['❯ Pick sides, please.', LINE, '←  ☐ Sides  ✔ Submit  →', 'Pick sides?', '',
  `${onOther ? ' ' : '❯'} 1. [ ] Fries`, '         Fries side', '  2. [ ] Salad', '         Salad side', `${onOther ? '❯' : ' '} 3. [${other?.[0] ?? ' '}] ${other?.[1] ?? 'Type something'}`, '     Submit', LINE, '  4. Chat about this', '', 'Enter to select · ↑/↓ to navigate · Esc to cancel', ''].join('\n')
test('a multi-select free-text answer: toggles, move to Other, ONE forced send, a re-read, Enter only if Other is not ticked, then Submit (D26)', async () => {
  const ask = () => post(`/api/agents/${LABEL}/t3/answer`, { action: 'answer', question: 'Pick sides?', selected: ['Salad'], other: 'no dressing' })
  const run = async (screens) => { hc.screens('t3', screens); const k0 = sent('keys', 't3').length; const f0 = forced().length; const r = await ask(); return { r, keys: sent('keys', 't3').slice(k0).map((c) => c.args.slice(3).join(' ')), forced: forced().slice(f0) } }
  // unticked after the paste: one more Enter ticks it, then down + enter
  let o = await run([multi(), multi(undefined, true), multi([' ', 'no dressing'], true), multi(['✔', 'no dressing'], true)])
  assert.equal(o.r.status, 200, JSON.stringify(await o.r.clone().json()))
  assert.deepEqual(o.keys, ['2', 'down down', 'enter', 'down enter'])
  assert.deepEqual(o.forced.map((c) => c.args), [['send', '--json', '--force', 't3', 'no dressing']])
  // already ticked: no extra Enter
  o = await run([multi(), multi(undefined, true), multi(['✔', 'no dressing'], true)])
  assert.equal(o.r.status, 200, JSON.stringify(await o.r.clone().json()))
  assert.deepEqual(o.keys, ['2', 'down down', 'down enter'])
  // never ticks: the answer stops before Submit
  o = await run([multi(), multi(undefined, true), multi([' ', 'no dressing'], true)])
  assert.equal(o.r.status, 409)
  assert.match((await o.r.json()).error, /terminal/)
  assert.deepEqual(o.keys, ['2', 'down down', 'enter'])
  // F7: the cursor is NOT on the Other row when the text would be pasted (the move did not land): nothing forced, 409
  o = await run([multi(), multi()])
  assert.equal(o.r.status, 409, JSON.stringify(await o.r.clone().json()))
  assert.match((await o.r.json()).error, /cursor|free-text/)
  assert.deepEqual(o.forced, [], 'multi-select: no forced send while the cursor is off the Other row')
  hc.screens('t3', [])
})

// F4 (security): a forced send / an Enter in `ensure` only goes to the SAME picker the plan was computed for; anything else is 409 and nothing is sent.
test('a forced free-text send is refused (409, no --force, no Enter) when the picker is gone or changed between the plan and the send', async () => {
  const single = readFileSync(new URL('./test-fixtures/picker-single-question.txt', import.meta.url), 'utf8')
  const pk = parsePicker(single)
  const ans = (q, other) => post(`/api/agents/${LABEL}/t3/answer`, { action: 'answer', question: q, selected: [], other })
  const attempt = async (q, screens, body) => {
    hc.screens('t3', screens); const f0 = forced().length, k0 = sent('keys', 't3').length
    const r = await body(); return { status: r.status, forced: forced().slice(f0), keys: sent('keys', 't3').slice(k0).map((c) => c.args.slice(3).join(' ')) }
  }
  const NOPICKER = '$ ls\nfoo\n$ '
  let o = await attempt(pk.question, [single, NOPICKER], () => ans(pk.question, 'sneaky'))
  assert.equal(o.status, 409); assert.deepEqual(o.forced, [], 'no picker on screen: nothing forced'); assert.ok(!o.keys.includes('enter'))
  o = await attempt(pk.question, [single, single.slice(0, single.lastIndexOf('Which color?')) + 'Delete everything?' + single.slice(single.lastIndexOf('Which color?') + 12)], () => ans(pk.question, 'sneaky'))
  assert.equal(o.status, 409); assert.deepEqual(o.forced, [], 'a different question: nothing forced')
  const ask = () => post(`/api/agents/${LABEL}/t3/answer`, { action: 'answer', question: 'Pick sides?', selected: ['Salad'], other: 'no dressing' })
  // multi-select: the picker disappears after the forced send, before the ensure Enter
  o = await attempt('Pick sides?', [multi(), multi(undefined, true), NOPICKER], ask)
  assert.equal(o.status, 409)
  assert.ok(!o.keys.slice(o.keys.indexOf('down down') + 1).includes('enter'), 'no Enter into a screen with no picker: ' + o.keys)
  o = await attempt('Pick sides?', [multi(), multi(undefined, true), multi(undefined, true).replace('Pick sides?', 'Run rm -rf?')], ask)
  assert.equal(o.status, 409); assert.ok(!o.keys.slice(o.keys.indexOf('down down') + 1).includes('enter'), 'no Enter into another question: ' + o.keys)
  // multi-select: gone before the forced send itself
  o = await attempt('Pick sides?', [multi(), NOPICKER], ask)
  assert.equal(o.status, 409); assert.deepEqual(o.forced, [])
  hc.screens('t3', []); hc.screen('t3', '')
})

test('a server send to a blocked agent is queued: no send, the row stays queued with 0 attempts; once unblocked it is typed and counted', async () => {
  const r = await fetch(`${base}/api/watch-prs/event`, { method: 'POST', headers: { ...J, 'x-wt-poller': '1' }, body: JSON.stringify({ pane: 't3', event: 'resumed', minutes: '5' }) })
  const ev = await r.json()
  assert.equal(r.status, 200, JSON.stringify(ev))
  assert.equal(ev.delivery, 'queued')
  assert.equal(plain('t3').length, 0)
  assert.deepEqual(forced().map((c) => c.args.at(-1)), ['my own words', 'sneaky', 'no dressing', 'no dressing', 'no dressing', 'no dressing', 'no dressing'], 'a delivery to a blocked target never carries --force: only the picker answers did')
  const rows = await (await fetch(`${base}/api/messages`, { headers: { cookie } })).json()
  const row = rows.find((m) => m.target === 't3')
  assert.ok(row, JSON.stringify(rows))
  assert.deepEqual([row.state, row.attempts], ['queued', 0])
  // the agent answers its dialog and goes idle; the queue (flushed every 10 s) types it, once
  const rowsT = hc.rows(); rowsT.find((t) => t.address === 't3').status = { app: 'claude-code', state: 'idle' }; hc.set(rowsT)
  hc.screen('t3', '❯ earlier prompt\n\n──────────────────────────────\n❯ \n──────────────────────────────\n')
  for (let i = 0; i < 40 && !plain('t3').length; i++) await sleep(500)
  assert.equal(plain('t3').length, 1)
  assert.deepEqual([...new Set(forced().map((c) => c.args.at(-1)))], ['my own words', 'sneaky', 'no dressing'])
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
  assert.equal((await inp({ text: 'Ls' })).status, 200) // a capital is shift+<letter>
  assert.deepEqual(sent('keys', made.pane)[2].args, ['keys', '--json', made.pane, 'shift+l', 's'])
  assert.equal((await inp({ text: 'a_b' })).status, 400) // shifted punctuation is refused, not changed
  assert.equal(sent('keys', made.pane).length, 3)
  assert.equal((await inp({ submit: true })).status, 200)
  assert.deepEqual(sent('keys', made.pane)[3].args.slice(-1), ['enter'])
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
