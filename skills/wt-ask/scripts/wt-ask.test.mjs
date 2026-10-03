// Run: node --test wt-ask.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BIN = fileURLToPath(new URL('./wt-ask', import.meta.url))
const execFileP = promisify(execFile)

// A stub of just the two routes wt-ask calls, recording what it received.
async function stub(handler) {
  const server = createServer(async (req, res) => {
    let b = ''
    req.on('data', (c) => (b += c))
    req.on('end', () => handler(req, JSON.parse(b || '{}'), res))
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() }
}
// A synchronous execFileSync would block this process's event loop, starving the in-process stub server
// above of the callback that answers it — run() must be async so both sides of the loopback call proceed.
const run = (args, env) => execFileP(BIN, args, { encoding: 'utf8', env: { ...process.env, HERDR_PANE_ID: 'w1:p2', ...env } })

test('post: builds the questions shape, prints the id', async () => {
  let seen
  const s = await stub((req, body, res) => {
    seen = { method: req.method, url: req.url, pane: req.headers['x-herdr-pane'], body }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'ask-1', status: 'open' }))
  })
  try {
    const { stdout } = await run(['Which env?', '--option', 'staging', '--option', 'prod', '--recommend', 'staging', '--header', 'Env', '--ticket', 'WP-164'], { HERDR_DASH_URL: s.url })
    assert.equal(stdout.trim(), 'ask-1')
    assert.equal(seen.method, 'POST')
    assert.equal(seen.url, '/api/asks')
    assert.equal(seen.pane, 'w1:p2')
    assert.deepEqual(seen.body.questions, [{ question: 'Which env?', header: 'Env', options: [{ label: 'staging' }, { label: 'prod' }], multiSelect: false, recommended: 'staging' }])
    assert.equal(seen.body.ticket, 'WP-164')
    assert.equal(seen.body.room, 'wp-164') // defaulted from the ticket, lowercased
  } finally { s.close() }
})

test('post: --room overrides the ticket default', async () => {
  let seen
  const s = await stub((req, body, res) => { seen = body; res.writeHead(200).end(JSON.stringify({ id: 'ask-2' })) })
  try {
    await run(['Q?', '--option', 'A', '--ticket', 'WP-1', '--room', 'eng-1'], { HERDR_DASH_URL: s.url })
    assert.equal(seen.room, 'eng-1')
  } finally { s.close() }
})

test('post: --json sends the file verbatim, plus --ticket/--room', async () => {
  let seen
  const s = await stub((req, body, res) => { seen = body; res.writeHead(200).end(JSON.stringify({ id: 'ask-3' })) })
  const f = join(mkdtempSync(join(tmpdir(), 'wt-ask-')), 'q.json')
  writeFileSync(f, JSON.stringify({ questions: [{ question: 'A?', header: 'H', options: [{ label: 'x' }] }] }))
  try {
    await run(['--json', f, '--room', 'wt-pack'], { HERDR_DASH_URL: s.url })
    assert.equal(seen.questions[0].question, 'A?')
    assert.equal(seen.room, 'wt-pack')
  } finally { s.close() }
})

test('resolve: posts to the resolve route', async () => {
  let seen
  const s = await stub((req, body, res) => { seen = { method: req.method, url: req.url }; res.writeHead(200).end('{}') })
  try {
    const { stdout } = await run(['--resolve', 'ask-9'], { HERDR_DASH_URL: s.url })
    assert.equal(stdout.trim(), 'resolved ask-9')
    assert.deepEqual(seen, { method: 'POST', url: '/api/asks/ask-9/resolve' })
  } finally { s.close() }
})

test('bad args: no options, unreachable server, bad flag → exit 2/1', async () => {
  await assert.rejects(run(['Q?'], {}), (e) => e.code === 2)
  await assert.rejects(run(['Q?', '--option', 'A'], { HERDR_DASH_URL: 'http://127.0.0.1:1', MAXT: '1' }), (e) => e.code === 1)
  await assert.rejects(run(['Q?', '--nope'], {}), (e) => e.code === 2)
})

test('server error: prints the body and exits 1', async () => {
  const s = await stub((req, body, res) => res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'questions: 1-4' })))
  try {
    await assert.rejects(run(['Q?', '--option', 'A'], { HERDR_DASH_URL: s.url }), (e) => e.code === 1 && e.stderr.includes('questions: 1-4'))
  } finally { s.close() }
})

test('post --no-deliver sends noDeliver; --ping hits the ping route', async () => {
  const seen = []
  const s = await stub((req, body, res) => { seen.push({ url: req.url, body }); res.writeHead(200).end(JSON.stringify({ id: 'ask-4', ok: true })) })
  try {
    await run(['Q?', '--option', 'A', '--no-deliver'], { HERDR_DASH_URL: s.url })
    assert.equal(seen[0].body.noDeliver, true)
    await run(['--ping'], { HERDR_DASH_URL: s.url })
    assert.equal(seen[1].url, '/api/asks/ping')
  } finally { s.close() }
})

test('--wait: prints the answer JSON once answered', async () => {
  let n = 0
  const s = await stub((req, body, res) => {
    n++
    res.writeHead(200).end(JSON.stringify(n < 2 ? { status: 'open' } : { status: 'answered', answer: { selected: [['A']] } }))
  })
  try {
    const { stdout } = await run(['--wait', 'ask-5'], { HERDR_DASH_URL: s.url, WAIT_POLL: '0.1' })
    assert.deepEqual(JSON.parse(stdout), { selected: [['A']] })
    assert.equal(n, 2)
  } finally { s.close() }
})

test('--wait: exits 3 on resolved and on timeout', async () => {
  let status = 'resolved'
  const s = await stub((req, body, res) => res.writeHead(200).end(JSON.stringify({ status })))
  try {
    await assert.rejects(run(['--wait', 'ask-6'], { HERDR_DASH_URL: s.url, WAIT_POLL: '0.1' }), (e) => e.code === 3)
    status = 'open'
    await assert.rejects(run(['--wait', 'ask-6', '--timeout', '1'], { HERDR_DASH_URL: s.url, WAIT_POLL: '0.2' }), (e) => e.code === 3)
  } finally { s.close() }
})

test('--wait: an undeliverable ask still prints its saved answer', async () => {
  const s = await stub((req, body, res) => res.writeHead(200).end(JSON.stringify({ status: 'undeliverable', answer: { selected: [['B']] } })))
  try {
    const { stdout } = await run(['--wait', 'ask-7'], { HERDR_DASH_URL: s.url, WAIT_POLL: '0.1' })
    assert.deepEqual(JSON.parse(stdout), { selected: [['B']] })
  } finally { s.close() }
})

test('--ping: exits 1 on a 403 (unknown pane); --json - reads stdin', async () => {
  let seen
  const s = await stub((req, body, res) => {
    if (req.url === '/api/asks/ping') return res.writeHead(403).end(JSON.stringify({ error: 'unknown pane' }))
    seen = body; res.writeHead(200).end(JSON.stringify({ id: 'ask-8' }))
  })
  try {
    await assert.rejects(run(['--ping'], { HERDR_DASH_URL: s.url }), (e) => e.code === 1)
    const child = execFile(BIN, ['--json', '-', '--no-deliver'], { encoding: 'utf8', env: { ...process.env, HERDR_PANE_ID: 'w1:p2', HERDR_DASH_URL: s.url } })
    const done = new Promise((r) => child.on('close', r))
    child.stdin.end(JSON.stringify({ questions: [{ question: 'Q?', header: 'H', options: [{ label: 'x' }] }] }))
    assert.equal(await done, 0)
    assert.equal(seen.noDeliver, true)
    assert.equal(seen.questions[0].question, 'Q?')
  } finally { s.close() }
})
