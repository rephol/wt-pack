// Run: node --test resting.test.mjs — WP-378 F6: `done` is an agent's resting state under hc (a turn ends at `done`, not `idle`), so every place that
// asked "is it idle?" asks `resting(status)`. One test per call site: reverting any of them to `=== 'idle'` fails here.
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deriveTasks, judgeNeedsYou, resting, stallLong, STALL_MS, waitsOnUser } from './server.mjs'
import { hcStub, terminal } from './test-hc.mjs'

test('resting is idle or done, nothing else', () => {
  assert.deepEqual(['idle', 'done', 'working', 'blocked', 'exited', ''].map(resting), [true, true, false, false, false, false])
})

test('the Jev NEEDS_YOU gate (listAgents): a resting (idle OR done) or blocked agent whose tail shows no picker is judged', () => {
  for (const st of ['idle', 'done', 'blocked']) assert.equal(judgeNeedsYou(st, 'Want me to continue?', null), true, st)
  for (const st of ['working', 'exited']) assert.equal(judgeNeedsYou(st, 'Want me to continue?', null), false, st)
  assert.equal(judgeNeedsYou('done', '', null), false); assert.equal(judgeNeedsYou('done', 'x', { question: 'q' }), false)
})

test('the Jev STALL rule (listAgents): long = sat resting (idle OR done) or working for STALL_MS', () => {
  const now = 10 * STALL_MS
  for (const st of ['idle', 'done', 'working']) { assert.equal(stallLong(st, now - STALL_MS - 1, now), true, st); assert.equal(stallLong(st, now - 1000, now), false, `${st} recently`) }
  for (const st of ['blocked', 'exited']) assert.equal(stallLong(st, now - STALL_MS - 1, now), false, st)
})

const agent = (over) => ({ key: 'local/t1', id: 't1', name: 'w-01', machine: 'local', local: true, pool: 'worker', status: 'done', statusSince: Date.now(), cwd: '/nowhere/main',
  tags: { ticket: 'WP-9' }, asks: false, project: 'p', recap: null, lastPrompt: null, ...over })
test('deriveTasks: an agent that finished its turn (done) and sat for STALL_MS is stalled (idle-long), like an idle one; a recent one is not', () => {
  const st = (a) => deriveTasks({ agents: [a], worktrees: [], prs: [], issues: [] })[0].state
  assert.equal(st(agent({ status: 'done', statusSince: Date.now() - STALL_MS - 5000 })), 'stalled')
  assert.equal(st(agent({ status: 'idle', statusSince: Date.now() - STALL_MS - 5000 })), 'stalled')
  assert.notEqual(st(agent({ status: 'done', statusSince: Date.now() - 1000 })), 'stalled')
})
test('deriveTasks / waitsOnUser: a done agent that asks needs you', () => {
  assert.equal(waitsOnUser(agent({ status: 'done', asks: true })), true)
  assert.equal(deriveTasks({ agents: [agent({ status: 'done', asks: true })], worktrees: [], prs: [], issues: [] })[0].state, 'needs_you')
})

// The overview's idleAgents count and the machine summary's idle count, through the real route on a stubbed core: 2 done + 1 idle + 1 working.
let hc, child, base, cookie
const PORT = 30000 + Math.floor(Math.random() * 20000)
const claude = (n, status) => terminal({ address: `t${n}`, name: `demo-worker-0${n}`, status, cwd: '/tmp', labels: { role: 'worker', 'wt.pool': 'demo-workers' }, pid: 40 + n, foreground: { name: '2.1', argv: ['claude'], cwd: '/tmp', pid: 40 + n } })
before(async () => {
  const root = mkdtempSync(join(tmpdir(), 'wt-resting-'))
  mkdirSync(join(root, 'data'), { recursive: true })
  hc = await hcStub({ terminals: [claude(1, 'done'), claude(2, 'done'), claude(3, 'idle'), claude(4, 'working')] })
  child = spawn(process.execPath, ['server.mjs'], { cwd: import.meta.dirname, stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, PORT: String(PORT), WT_DASHBOARD_DATA: root, HOME: root, ...hc.env } })
  base = `http://127.0.0.1:${PORT}`
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/api/push`)).ok) break } catch { /* not up yet */ } await new Promise((r) => setTimeout(r, 100)) }
  cookie = `hd_session=${readFileSync(join(root, 'session'), 'utf8').trim()}`
})
after(async () => { child?.kill(); await hc?.close() })
test('overview: counts.idleAgents and the machine summary count a done agent as idle', async () => {
  let o
  for (let i = 0; i < 80; i++) { o = await (await fetch(`${base}/api/overview`, { headers: { cookie } })).json().catch(() => null); if (o?.agents?.length === 4) break; await new Promise((r) => setTimeout(r, 250)) }
  assert.equal(o?.agents?.length, 4, JSON.stringify(o?.sourceIssues))
  assert.deepEqual(o.agents.map((a) => a.status).sort(), ['done', 'done', 'idle', 'working'])
  assert.equal(o.counts.idleAgents, 3)
  assert.equal(o.machines[0].idle, 3); assert.equal(o.machines[0].working, 1); assert.equal(o.machines[0].total, 4)
})
