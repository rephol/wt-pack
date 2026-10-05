// Run: node --test skills/wt-shared/mcp/wt-server.test.mjs — the wt MCP server (WP-255) against stub CLIs.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const tmp = mkdtempSync(join(tmpdir(), 'wt-mcp-srv-'))
const log = join(tmp, 'calls.log')
// One stub per CLI: it logs "<name> <args>|<stdin>" and behaves per the first arg, so a test picks the outcome by its input.
const stub = (name, body) => { const f = join(tmp, name); writeFileSync(f, `#!/bin/sh\nin=$(cat 2>/dev/null)\necho "${name} $*|$in" >> ${log}\n${body}\n`); chmodSync(f, 0o755); return f }
const ticket = stub('wt-ticket', `case "$1" in show) echo '{"id":"'"$2"'","column":"building"}' ;; new) echo '{"id":"WP-99"}' ;; move) [ "$2" = WP-13 ] && { echo "wt-ticket: 400 gate refused" >&2; exit 2; }; [ "$2" = WP-14 ] && { echo "wt-dashboard not reachable at x — wt-ticket needs it running" >&2; exit 1; }; echo '{"id":"'"$2"'"}' ;; list) echo '{"tickets":[]}' ;; *) echo '{}' ;; esac`)
const handoff = stub('handoff.sh', `case "$*" in *--dry-run*) echo "dry-run: would spawn a worker" ;; *--role\\ planner*) echo "pool full: 2/2 plain workers in demo" >&2; exit 3 ;; *--pane\\ w9:p9*) echo "demo-worker-09 is on team web; WP-1 is teamless" >&2; exit 2 ;; *--ack*) echo "m1 acknowledged" ;; *--reply*) echo "replied" ;; *slow*) sleep 5 ;; *) printf 'created demo-worker-03 w1:p3\\ntarget demo-worker-03 w1:p3\\nroute: worker\\n' ;; esac`)
const room = stub('room', `case "$1" in read) echo "[1] a: hi" ;; post) echo "posted to #$2" ;; list) echo "wp-1" ;; esac`)
const ask = stub('wt-ask', `case "$1" in --wait) [ "$2" = open ] && { echo "wt-ask: no answer to open within 1s" >&2; exit 3; }; [ "$2" = closed ] && { echo "wt-ask: closed was resolved without an answer" >&2; exit 3; }; echo '{"picked":"A"}' ;; *) echo '{"id":"ask1"}' ;; esac`)

function start(env = {}) {
  const p = spawn(process.execPath, [new URL('./wt-server.mjs', import.meta.url).pathname], {
    env: { PATH: process.env.PATH, HOME: tmp, WT_RECEIPTS_DIR: join(tmp, 'receipts'), WT_MCP_TICKET: ticket, WT_MCP_HANDOFF: handoff, WT_MCP_ROOM: room, WT_MCP_ASK: ask, ...env } })
  const pending = new Map(); let n = 0
  createInterface({ input: p.stdout }).on('line', (l) => { const m = JSON.parse(l); pending.get(m.id)?.(m); pending.delete(m.id) })
  const rpc = (method, params) => new Promise((res) => { const id = ++n; pending.set(id, res); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n') })
  const callTool = async (name, args) => { const r = (await rpc('tools/call', { name, arguments: args })).result; return { ...r, data: JSON.parse(r.content[0].text) } }
  return { rpc, callTool, stop: () => p.kill() }
}
const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [])

test('initialize + tools/list: every tool has a typed schema; mutating ones take idempotency_key', async () => {
  const s = start()
  const init = (await s.rpc('initialize', { protocolVersion: '2025-06-18' })).result
  assert.equal(init.serverInfo.name, 'wt')
  const tools = (await s.rpc('tools/list')).result.tools
  assert.deepEqual(tools.map((t) => t.name), ['ticket_list', 'ticket_show', 'ticket_new', 'ticket_move', 'ticket_comment', 'handoff', 'handoff_reply', 'handoff_ack', 'room_list', 'room_read', 'room_post', 'ask', 'ask_answer'])
  for (const t of tools) { assert.equal(t.inputSchema.type, 'object'); assert.equal(t.inputSchema.additionalProperties, false); assert.ok(t.description.length > 20) }
  const by = Object.fromEntries(tools.map((t) => [t.name, t.inputSchema]))
  for (const m of ['ticket_new', 'ticket_move', 'ticket_comment', 'handoff', 'handoff_reply', 'room_post', 'ask']) assert.ok(by[m].properties.idempotency_key, m)
  for (const r of ['ticket_show', 'ticket_list', 'room_read', 'handoff_ack', 'ask_answer']) assert.ok(!by[r].properties.idempotency_key, r)
  assert.deepEqual(by.ticket_move.properties.column.enum, ['backlog', 'ready', 'planning', 'building', 'review', 'done', 'blocked'])
  s.stop()
})

test('a call runs the CLI with the typed args and returns its JSON; handoff parses the target', async () => {
  const s = start()
  const r = await s.callTool('ticket_show', { id: 'WP-12' })
  assert.equal(r.isError, undefined); assert.deepEqual(r.data, { id: 'WP-12', column: 'building' }); assert.deepEqual(r.structuredContent, r.data)
  assert.ok(calls().includes('wt-ticket show WP-12 --json|'))
  const nw = await s.callTool('ticket_new', { title: 'Do it', type: 'bug', priority: 2, labels: ['a', 'b'] })
  assert.equal(nw.data.id, 'WP-99'); assert.ok(calls().some((l) => l.startsWith('wt-ticket new Do it --type bug --priority 2 --label a --label b --json')))
  const h = await s.callTool('handoff', { prompt: 'Implement WP-1', role: 'worker', task: 'WP-1 x' })
  assert.deepEqual([h.data.created, h.data.pane, h.data.target, h.data.route], [true, 'w1:p3', 'demo-worker-03', 'route: worker'])
  assert.ok(calls().some((l) => l.startsWith('handoff.sh --role worker --task WP-1 x|Implement WP-1'))) // the prompt goes on stdin, never as an argument
  assert.equal((await s.callTool('handoff', { prompt: 'x', dry_run: true })).data.dry_run, true)
  assert.equal((await s.callTool('room_post', { room: 'wp-1', text: 'hello' })).data.output, 'posted to #wp-1')
  assert.deepEqual((await s.callTool('ask', { question: 'Which?', options: ['A', 'B'], recommend: 'A' })).data, { id: 'ask1' })
  assert.ok(calls().some((l) => l.startsWith('wt-ask Which? --option A --option B --recommend A')))
  s.stop()
})

test('typed errors: bad arguments never reach a CLI; CLI failures become codes with retryable', async () => {
  const s = start(); const before = calls().length
  for (const [tool, args, msg] of [['ticket_show', { id: 'nope' }, /wrong shape/], ['ticket_show', {}, /id is required/], ['ticket_move', { id: 'WP-1', column: 'nowhere' }, /one of/],
    ['ticket_comment', { id: 'WP-1', text: '--force' }, /must not start with/], ['ticket_show', { id: 'WP-1', extra: 1 }, /unknown argument/], ['room_post', { room: 'A/B', text: 'x' }, /wrong shape/],
    ['ticket_new', { title: 'x', priority: 9 }, /integer/], ['ask', { question: 'q', options: [] }, /at least one/], ['ticket_list', { query: 'x', mine: true }, /cannot be combined/]]) {
    const r = await s.callTool(tool, args)
    assert.equal(r.isError, true, tool); assert.equal(r.data.error.code, 'invalid_argument'); assert.match(r.data.error.message, msg); assert.equal(r.data.error.retryable, false)
  }
  assert.equal(calls().length, before) // none of them ran a CLI
  const unknown = await s.callTool('nope', {}); assert.equal(unknown.data.error.code, 'unknown_tool')
  const code = async (tool, args) => (await s.callTool(tool, args)).data.error
  assert.deepEqual(await code('handoff', { prompt: 'x', role: 'planner' }), { code: 'pool_full', message: 'pool full: 2/2 plain workers in demo', retryable: true, exit: 3 })
  const refused = await code('handoff', { prompt: 'x', pane: 'w9:p9' }); assert.equal(refused.code, 'refused'); assert.equal(refused.retryable, false); assert.match(refused.message, /is on team web/)
  const down = await code('ticket_move', { id: 'WP-14', column: 'review' }); assert.equal(down.code, 'dashboard_unreachable'); assert.equal(down.retryable, true)
  assert.equal((await code('ticket_move', { id: 'WP-13', column: 'review' })).code, 'refused')
  s.stop()
})

test('idempotency_key: a repeat returns the first result and runs nothing; handoff passes it as --request-id; a failure is retried', async () => {
  const s = start()
  const a = await s.callTool('ticket_comment', { id: 'WP-5', text: 'once', idempotency_key: 'k1' }); const n = calls().length
  const b = await s.callTool('ticket_comment', { id: 'WP-5', text: 'once', idempotency_key: 'k1' })
  assert.deepEqual(b.data, a.data); assert.equal(calls().length, n)
  await s.callTool('ticket_comment', { id: 'WP-5', text: 'again', idempotency_key: 'k2' }); assert.equal(calls().length, n + 1) // another key runs
  await s.callTool('ticket_comment', { id: 'WP-5', text: 'again' }); await s.callTool('ticket_comment', { id: 'WP-5', text: 'again' }); assert.equal(calls().length, n + 3) // no key, no dedupe
  await s.callTool('handoff', { prompt: 'p', idempotency_key: 'h1' }); assert.ok(calls().some((l) => l.includes('--request-id mcp:h1|p')))
  const m1 = await s.callTool('ticket_move', { id: 'WP-14', column: 'review', idempotency_key: 'f1' }); assert.equal(m1.isError, true)
  const m = calls().length; await s.callTool('ticket_move', { id: 'WP-14', column: 'review', idempotency_key: 'f1' }); assert.equal(calls().length, m + 1) // the failed call was not remembered
  s.stop()
})

test('deadline: a CLI still running at WT_MCP_TIMEOUT_MS is killed and the call fails timeout (retryable); ask_answer maps open/resolved', async () => {
  const s = start({ WT_MCP_TIMEOUT_MS: '300' })
  const t0 = Date.now(); const r = await s.callTool('handoff', { prompt: 'p', task: 'slow' })
  assert.ok(Date.now() - t0 < 3000); assert.equal(r.data.error.code, 'timeout'); assert.equal(r.data.error.retryable, true); assert.match(r.data.error.message, /same idempotency_key/)
  assert.deepEqual((await s.callTool('ask_answer', { id: 'done1' })).data, { answered: true, answer: { picked: 'A' } })
  assert.deepEqual((await s.callTool('ask_answer', { id: 'open', timeout_s: 1 })).data, { answered: false })
  assert.equal((await s.callTool('ask_answer', { id: 'closed' })).data.error.code, 'resolved')
  assert.equal((await s.callTool('ask_answer', { id: 'x', timeout_s: 90 })).data.error.code, 'invalid_argument') // over the MCP call limit
  s.stop()
})
