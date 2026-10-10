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
  assert.equal(r.code, 1); assert.match(r.stderr, /403.*dashboard only.*dashboard session/)
  r = await run(['list', '--headless'], { HERDR_DASH_URL: 'http://127.0.0.1:1' })
  assert.equal(r.code, 1); assert.match(r.stderr, /wt-dashboard not reachable/)
  r = await run(['spawn', '--headless'])
  assert.equal(r.code, 2)
})

test('list --headless prints rows; rm --headless POSTs stop', async () => {
  reqs = []; reply = () => [200, [{ name: 'a', id: 'hl-1', state: 'idle', cwd: '/x' }, { name: 'b', id: 'hl-2', state: 'queued', cwd: '/y' }]]
  let r = await run(['list', '--headless'])
  assert.equal(r.stdout, 'a hl-1 idle /x\nb hl-2 queued /y\n')
  assert.deepEqual([reqs[0].method, reqs[0].path], ['GET', '/api/headless'])
  reqs = []; reply = () => [200, { name: 'a', id: 'hl-1', state: 'ended' }]
  r = await run(['rm', '--headless', 'hl-1'])
  assert.equal(r.stdout, 'a hl-1 ended\n')
  assert.deepEqual([reqs[0].method, reqs[0].path], ['POST', '/api/headless/hl-1/stop'])
  r = await run(['rm', '--headless', 'w1:p2'])
  assert.equal(r.code, 2)
})
