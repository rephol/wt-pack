// Run: node --test asks.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Asks, clean, ping, ASK_MAX_AGE_MS } from './asks.mjs'

const tmp = () => mkdtemp(join(tmpdir(), 'asks-'))
const author = { pane: 'w1:p2', name: 'wt-pack-worker-01' }
const q = (over = {}) => ({ questions: [{ question: 'Which?', header: 'Pick one', options: [{ label: 'A' }, { label: 'B' }] }], room: 'wt-pack', ...over })

test('clean: rejects bad shapes', () => {
  assert.throws(() => clean({ questions: [] }), /questions: 1-4/)
  assert.throws(() => clean({ questions: [{ question: '', header: 'h', options: [{ label: 'A' }] }] }), /question/)
  assert.throws(() => clean({ questions: [{ question: 'q', header: 'h', options: [] }] }), /options/)
  assert.throws(() => clean({ questions: [{ question: 'q', header: 'h', options: [{ label: 'A' }], recommended: 'Z' }] }), /recommended/)
  assert.doesNotThrow(() => clean(q()))
})

test('create: notifies and stores an open ask', async () => {
  const dir = await tmp()
  const a = new Asks({ dir, notify: async (d) => ({ id: 'n1', ...d }) })
  const created = await a.create(q(), author)
  assert.equal(created.status, 'open')
  assert.equal(created.pane, author.pane)
  assert.equal((await a.get(created.id)).status, 'open')
})

test('answer: delivers, closes, and resolves the inbox item', async () => {
  const dir = await tmp()
  const delivered = []
  let resolvedKey
  const a = new Asks({ dir, notify: async (d) => ({ id: 'n1', ...d }), resolveNotify: async (k) => { resolvedKey = k }, deliver: async (pane, text) => delivered.push([pane, text]) })
  const created = await a.create(q(), author)
  const out = await a.answer(created.id, { selected: [['A']] }, { name: 'Rep' })
  assert.equal(out.status, 'answered')
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0][0], author.pane)
  assert.equal(resolvedKey, `ask:${created.id}`)
})

test('answer on a closed ask → 409', async () => {
  const dir = await tmp()
  const a = new Asks({ dir, notify: async (d) => ({ id: 'n1', ...d }) })
  const created = await a.create(q(), author)
  await a.answer(created.id, { selected: [['A']] }, { name: 'Rep' })
  await assert.rejects(a.answer(created.id, { selected: [['B']] }, { name: 'Rep' }), (e) => e.status === 409)
})

// WP-169: a second answer (e.g. one from the room chip, one from the Inbox, both reading status='open')
// must be rejected before it reaches `deliver` — otherwise the pane gets two conflicting replies even
// though only the first answer is ever saved.
test('answer on a closed ask → does not deliver a second time', async () => {
  const dir = await tmp()
  const delivered = []
  const a = new Asks({ dir, notify: async (d) => ({ id: 'n1', ...d }), deliver: async (pane, text) => delivered.push([pane, text]) })
  const created = await a.create(q(), author)
  await a.answer(created.id, { selected: [['A']] }, { name: 'Rep' })
  await assert.rejects(a.answer(created.id, { selected: [['B']] }, { name: 'Rep' }), (e) => e.status === 409)
  assert.equal(delivered.length, 1)
  assert.match(delivered[0][1], /A/)
})

test('resolve by a different pane → 403', async () => {
  const dir = await tmp()
  const a = new Asks({ dir, notify: async (d) => ({ id: 'n1', ...d }) })
  const created = await a.create(q(), author)
  await assert.rejects(a.resolve(created.id, 'w9:p9'), (e) => e.status === 403)
  const out = await a.resolve(created.id, author.pane)
  assert.equal(out.status, 'resolved')
})

test('answer: a gone pane → undeliverable, keeps the answer', async () => {
  const dir = await tmp()
  const a = new Asks({ dir, notify: async (d) => ({ id: 'n1', ...d }), deliver: async () => { throw new Error('unknown pane') } })
  const created = await a.create(q(), author)
  const out = await a.answer(created.id, { selected: [['A']] }, { name: 'Rep' })
  assert.equal(out.status, 'undeliverable')
  assert.deepEqual(out.answer.selected, [['A']])
})

// WP-206: the plugin mod waits on the ask and returns the answer as the tool result, so no wt-message goes out.
test('noDeliver: answer closes the ask without delivering', async () => {
  const dir = await tmp()
  const delivered = []
  const a = new Asks({ dir, notify: async (d) => ({ id: 'n1', ...d }), deliver: async (p, t) => delivered.push([p, t]) })
  const created = await a.create(q({ noDeliver: true }), author)
  const out = await a.answer(created.id, { selected: [['A']] }, { name: 'Rep' })
  assert.equal(out.status, 'answered')
  assert.equal(delivered.length, 0)
})

test('get by another pane → 403; by the asking pane → the ask', async () => {
  const dir = await tmp()
  const a = new Asks({ dir, notify: async (d) => ({ id: 'n1', ...d }) })
  const created = await a.create(q(), author)
  await assert.rejects(a.get(created.id, 'w9:p9'), (e) => e.status === 403)
  assert.equal((await a.get(created.id, author.pane)).id, created.id)
})

// WP-209: GET /api/asks/:id passes the session (pane undefined) through to any ask, scopes an agent to its own,
// and 404s an unknown id — all of which `Asks.get` decides, as server.mjs's route calls it.
test('get: session (no pane) reads any ask; foreign pane 403; unknown id 404', async () => {
  const a = new Asks({ dir: await tmp(), notify: async (d) => ({ id: 'n1', ...d }) })
  const created = await a.create(q(), author)
  assert.equal((await a.get(created.id, undefined)).pane, author.pane)
  await assert.rejects(a.get(created.id, 'w9:p9'), (e) => e.status === 403)
  await assert.rejects(a.get('nope', author.pane), (e) => e.status === 404)
})

test('ping: the user and a role-tagged agent pane pass; a bare agent pane → 403', () => {
  assert.deepEqual(ping({ kind: 'user' }), { ok: true, kind: 'user' })
  assert.deepEqual(ping({ kind: 'agent' }, 'worker'), { ok: true, kind: 'agent' })
  assert.throws(() => ping({ kind: 'agent' }, undefined), (e) => e.status === 403 && /role token/.test(e.message))
})

// WP-209: an ask whose mod never got to --resolve (agent killed mid-wait, dashboard blip) is closed by the sweep.
test('expire: closes open noDeliver asks of a gone pane or past the age cap; leaves the rest', async () => {
  const resolved = [], events = []
  const a = new Asks({ dir: await tmp(), notify: async (d) => ({ id: 'n1', ...d }), resolveNotify: async (k) => { resolved.push(k) }, broadcast: (e, d) => events.push(d.action) })
  const gone = await a.create(q({ noDeliver: true }), { ...author, pane: 'w1:p9' })
  const live = await a.create(q({ noDeliver: true }), author)
  const plain = await a.create(q(), { ...author, pane: 'w1:p8' }) // delivered by wt-message: never swept
  const done = await a.create(q({ noDeliver: true }), { ...author, pane: 'w1:p7' })
  await a.answer(done.id, { selected: [['A']] }, { name: 'Rep' })
  assert.equal(await a.expire(new Set([author.pane])), 1)
  assert.equal((await a.get(gone.id)).status, 'resolved')
  assert.deepEqual([live, plain].map((x) => a.row(x.id).status), ['open', 'open'])
  assert.equal(a.row(done.id).status, 'answered')
  assert.ok(resolved.includes(`ask:${gone.id}`) && events.includes('resolved'))
  assert.equal(await a.expire(new Set([author.pane]), Date.now() + ASK_MAX_AGE_MS + 1000), 1) // live pane, but too old
  assert.equal(a.row(live.id).status, 'resolved')
  assert.equal(a.row(plain.id).status, 'open')
})

// WP-209: the ask routes verify the pane before anything else. Session-cookie paths are covered on `Asks`/`ping`
// directly (the cookie is minted per server process).
test('server: unknown pane → 403 on GET /api/asks/ping and /api/asks/:id', async () => {
  const { spawn } = await import('node:child_process')
  const root = await mkdtemp(join(tmpdir(), 'asks-srv-'))
  const port = 20000 + Math.floor(Math.random() * 20000)
  const srv = spawn(process.execPath, [new URL('./server.mjs', import.meta.url).pathname], {
    env: { ...process.env, PORT: String(port), WT_DASHBOARD_DATA: root, HOME: root }, stdio: ['ignore', 'pipe', 'pipe'] })
  try {
    await new Promise((res, rej) => {
      let out = '', err = ''
      srv.stdout.on('data', (d) => { out += d; if (out.includes('api →')) res() })
      srv.stderr.on('data', (d) => { err += d })
      srv.on('exit', (c) => rej(new Error(`server exited (${c}) before listening: ${err.slice(-400)}`)))
      setTimeout(() => rej(new Error('server not listening after 30s')), 30_000).unref()
    })
    const get = (path, headers) => fetch(`http://127.0.0.1:${port}${path}`, { headers })
    assert.equal((await get('/api/asks/ping', { 'x-herdr-pane': 'w999:p999' })).status, 403)
    assert.equal((await get('/api/asks/some-id', { 'x-herdr-pane': 'w999:p999' })).status, 403)
    assert.equal((await get('/api/asks/ping', {})).status, 403) // neither a session nor a pane
  } finally { srv.kill() }
})
