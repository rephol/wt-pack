// Run: node --test headless-cli.test.mjs — WP-293 `agents.sh spawn|list|rm --headless` against an in-process stub of
// wt-dashboard's /api/headless. execFile is async on purpose: a sync child would block this process's stub (CLAUDE.md trap).
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import http from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const SH = join(import.meta.dirname, 'agents.sh')
let server, url, reqs = [], reply = () => [200, {}]
before(async () => {
  server = http.createServer((req, res) => {
    let b = ''
    req.on('data', (d) => { b += d }).on('end', () => {
      reqs.push({ method: req.method, path: req.url, pane: req.headers['x-herdr-pane'] ?? null, type: req.headers['content-type'], body: b ? JSON.parse(b) : null })
      const [code, out] = reply(req)
      res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(out))
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  url = `http://127.0.0.1:${server.address().port}`
})
after(() => server.close())
const run = (args, env = {}) => promisify(execFile)('sh', [SH, ...args], { env: { PATH: process.env.PATH, HOME: process.env.HOME, HERDR_DASH_URL: url, ...env } })
  .then((r) => ({ code: 0, ...r }), (e) => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }))

test('spawn --headless POSTs role/cwd/options with the pane header and prints "<name> <id> <state>"', async () => {
  reqs = []; reply = () => [200, { name: 'worker-ab12', id: 'hl-ab12cd34ef', state: 'queued' }]
  const dir = mkdtempSync(join(tmpdir(), 'wt-hlcli-'))
  const r = await run(['spawn', '--headless', 'worker', dir, '--prompt', 'do "it" now', '--model', 'sonnet', '--name', 'w1'], { HERDR_PANE_ID: 'w1:p2' })
  assert.equal(r.code, 0, r.stderr)
  assert.equal(r.stdout, 'worker-ab12 hl-ab12cd34ef queued\n')
  assert.equal(reqs.length, 1)
  const q = reqs[0]
  assert.deepEqual([q.method, q.path, q.pane, q.type], ['POST', '/api/headless', 'w1:p2', 'application/json'])
  assert.deepEqual(q.body, { role: 'worker', cwd: (await promisify(execFile)('sh', ['-c', `cd '${dir}' && pwd`])).stdout.trim(), prompt: 'do "it" now', model: 'sonnet', name: 'w1' })
})

test('spawn --headless: cwd defaults to $PWD, no pane header outside a pane', async () => {
  reqs = []; reply = () => [200, { name: 'n', id: 'hl-1', state: 'starting' }]
  const r = await promisify(execFile)('sh', [SH, 'spawn', '--headless', 'reviewer'], { cwd: tmpdir(), env: { PATH: process.env.PATH, HERDR_DASH_URL: url } })
  assert.equal(r.stdout, 'n hl-1 starting\n')
  assert.equal(reqs[0].pane, null)
  assert.equal(reqs[0].body.role, 'reviewer'); assert.ok(reqs[0].body.cwd.startsWith('/'))
  assert.deepEqual(Object.keys(reqs[0].body).sort(), ['cwd', 'role'])
})

test('a server error is printed and exits 1; 403 says it needs the dashboard; unreachable says so', async () => {
  reply = () => [400, { error: 'role: 1-40 chars of [\\w.-]' }]
  let r = await run(['spawn', '--headless', 'x'])
  assert.equal(r.code, 1); assert.match(r.stderr, /role: 1-40 chars/)
  reply = () => [403, { error: 'dashboard only' }]
  r = await run(['rm', '--headless', 'hl-abc'])
  assert.equal(r.code, 1); assert.match(r.stderr, /403.*dashboard only.*spawned the run.*orchestrator/)
  r = await run(['list', '--headless'], { HERDR_DASH_URL: 'http://127.0.0.1:1' })
  assert.equal(r.code, 1); assert.match(r.stderr, /wt-dashboard not reachable/)
  r = await run(['spawn', '--headless'])
  assert.equal(r.code, 2)
})

test('list --headless prints rows; rm --headless POSTs stop', async () => {
  reqs = []; reply = () => [200, [{ name: 'a', id: 'hl-1', state: 'idle', cwd: '/x' }, { name: 'b', id: 'hl-2', state: 'queued', cwd: '/y' }]]
  let r = await run(['list', '--headless'])
  assert.equal(r.stdout, 'a hl-1 idle /x -\nb hl-2 queued /y -\n')
  assert.deepEqual([reqs[0].method, reqs[0].path], ['GET', '/api/headless'])
  reqs = []; reply = () => [200, { name: 'a', id: 'hl-1', state: 'ended' }]
  r = await run(['rm', '--headless', 'hl-1'])
  assert.equal(r.stdout, 'a hl-1 ended\n')
  assert.deepEqual([reqs[0].method, reqs[0].path], ['POST', '/api/headless/hl-1/stop'])
  r = await run(['stop', '--headless', 'hl-1'], { HERDR_PANE_ID: 'w1:p2' }) // stop is rm
  assert.equal(r.stdout, 'a hl-1 ended\n'); assert.deepEqual([reqs.at(-1).path, reqs.at(-1).pane], ['/api/headless/hl-1/stop', 'w1:p2'])
  r = await run(['rm', '--headless', 'w1:p2'])
  assert.equal(r.code, 2)
})

test('context (WP-312): the caller\'s AgentInfo context for a headless run or a pane; exit 1 when unknown', async () => {
  const row = (id, kind, extra, used) => ({ id, info: { kind, ...extra, contextUsed: used, contextWindow: 200000, contextPct: 50, model: { id: 'claude-opus-5-5', name: 'Opus 5.5' } } })
  reply = () => [200, [row('w9:p9', 'pane', { pane: { id: 'w9:p9' } }, 100000), row('hl-aa', 'headless', { run: { id: 'hl-aa' } }, 100000), row('hl-bb', 'headless', { run: { id: 'hl-bb' } }, null)]]
  const want = { used: 100000, window: 200000, pct: 50, model: 'claude-opus-5-5' }
  for (const env of [{ WT_HEADLESS_ID: 'hl-aa' }, { HERDR_PANE_ID: 'w9:p9' }]) {
    const r = await run(['context'], env)
    assert.equal(r.code, 0, r.stderr); assert.deepEqual(JSON.parse(r.stdout), want)
  }
  assert.equal((await run(['context'], { WT_HEADLESS_ID: 'hl-bb' })).code, 1) // no turn yet
  assert.equal((await run(['context'], {})).code, 1) // neither a pane nor a run
})

test('send --headless (WP-317): a live run by name beats the ended one sharing it; id prefix; ambiguity and no live run exit 1', async () => {
  const rows = [{ name: 'p-01', id: 'hl-old1', state: 'ended', cwd: '/x', role: 'planner' }, { name: 'p-01', id: 'hl-new2', state: 'idle', cwd: '/x', role: 'planner' },
    { name: 'q', id: 'hl-new3', state: 'working', cwd: '/x', role: 'worker' }]
  reply = (req) => (req.method === 'GET' ? [200, rows] : [200, { ok: true }])
  reqs = []
  let r = await run(['send', '--headless', 'p-01', 'next "task"'], { HERDR_PANE_ID: 'w1:p2' })
  assert.equal(r.code, 0, r.stderr); assert.equal(r.stdout, 'sent hl-new2\n')
  assert.deepEqual([reqs[1].method, reqs[1].path, reqs[1].pane, reqs[1].body], ['POST', '/api/headless/hl-new2/message', 'w1:p2', { text: 'next "task"' }])
  reqs = []; r = await run(['send', '--headless', 'hl-new3', 'x'])
  assert.equal(r.stdout, 'sent hl-new3\n')
  r = await run(['send', '--headless', 'hl-new', 'x']) // prefix matches two live runs
  assert.equal(r.code, 1); assert.match(r.stderr, /no live headless run \(or ambiguous\)/)
  r = await run(['send', '--headless', 'hl-old1', 'x']); assert.equal(r.code, 1) // ended
  assert.equal((await run(['send', '--headless'])).code, 2)
  reply = (req) => (req.method === 'GET' ? [200, rows] : [409, { error: 'the agent is queued' }])
  r = await run(['send', '--headless', 'q', 'x']); assert.equal(r.code, 1); assert.match(r.stderr, /the agent is queued/)
})

test('spawn --headless --reuse (WP-317): an idle run of the same role + cwd gets the prompt; otherwise a new run is spawned', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wt-hlreuse-'))
  const cwd = (await promisify(execFile)('sh', ['-c', `cd '${dir}' && pwd`])).stdout.trim()
  const rows = [{ name: 'busy', id: 'hl-b', state: 'working', cwd, role: 'worker' }, { name: 'other', id: 'hl-o', state: 'idle', cwd: '/elsewhere', role: 'worker' },
    { name: 'free', id: 'hl-f', state: 'idle', cwd, role: 'worker' }]
  reply = (req) => (req.method === 'GET' ? [200, rows] : [200, { name: 'fresh', id: 'hl-n', state: 'queued' }])
  reqs = []
  let r = await run(['spawn', '--headless', 'worker', dir, '--reuse', '--prompt', 'again'])
  assert.equal(r.stdout, 'free hl-f idle reused\n')
  assert.deepEqual([reqs[1].path, reqs[1].body], ['/api/headless/hl-f/message', { text: 'again' }]); assert.equal(reqs.length, 2)
  reqs = []; r = await run(['spawn', '--headless', 'planner', dir, '--reuse', '--prompt', 'p']) // no idle planner there
  assert.equal(r.stdout, 'fresh hl-n queued\n'); assert.equal(reqs[1].method, 'POST'); assert.equal(reqs[1].path, '/api/headless')
})
