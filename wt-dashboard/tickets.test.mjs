// Run: node --test tickets.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Tickets, deriveKey, ticketRow } from './tickets.mjs'

const tmp = () => mkdtemp(join(tmpdir(), 'tickets-'))
const user = { name: 'Rep' }
const agent = { name: 'wt-pack-worker-01', pane: 'w1:p2' }

test('deriveKey', () => {
  assert.equal(deriveKey('wt-pack'), 'WP')
  assert.equal(deriveKey('umkmall'), 'UMK')
  assert.equal(deriveKey('umkmall', new Set(['UMK'])), 'UMKM')
  assert.equal(deriveKey('web-portal', new Set(['WP'])), 'WPB')
  assert.equal(deriveKey('my_app2'), 'MA')
})

test('create: sequential ids, history, board file', async () => {
  const dir = await tmp()
  const t = new Tickets({ dir, reserved: ['UMK'] })
  const a = await t.create('wt-pack', { title: ' First ', type: 'bug' }, user)
  const b = await t.create('wt-pack', { title: 'Second', column: 'ready' }, agent)
  assert.deepEqual([a.id, b.id, a.title, a.column, b.column], ['WP-1', 'WP-2', 'First', 'backlog', 'ready'])
  assert.equal(a.history[0].author, 'Rep')
  const file = JSON.parse(await readFile(join(dir, 'tickets', 'wt-pack.json'), 'utf8'))
  assert.equal(file.next, 3)
  assert.equal(ticketRow(a), 'WP-1 [backlog] (bug,P0) First')
  assert.deepEqual(await t.keys(), { 'wt-pack': 'WP' })
  assert.equal((await t.get('wp-2')).title, 'Second')
})

test('20 concurrent creates → 20 distinct ids and a valid file', async () => {
  const dir = await tmp()
  const t = new Tickets({ dir })
  const out = await Promise.all(Array.from({ length: 20 }, (_, i) => t.create('wt-pack', { title: `t${i}` }, user)))
  assert.equal(new Set(out.map((x) => x.id)).size, 20)
  const fresh = new Tickets({ dir })
  assert.equal((await fresh.list('wt-pack')).tickets.length, 20)
})

test('two concurrent first-board creates get distinct keys; Linear key refused', async () => {
  const t = new Tickets({ dir: await tmp(), reserved: ['UMK'] })
  const [a, b] = await Promise.all([t.board('web-portal'), t.board('wt-pack')])
  assert.notEqual(a.key, b.key)
  assert.equal((await t.board('umkmall')).key, 'UMKM')
})

test('move appends history; blocked needs a note; validation', async () => {
  const t = new Tickets({ dir: await tmp() })
  const { id } = await t.create('wt-pack', { title: 'x' }, user)
  const moved = await t.patch(id, { column: 'ready', bogus: 1 }, agent)
  assert.deepEqual(moved.history.at(-1), { ...moved.history.at(-1), kind: 'move', from: 'backlog', to: 'ready', author: 'wt-pack-worker-01' })
  assert.equal(moved.bogus, undefined)
  await assert.rejects(t.patch(id, { column: 'blocked' }, agent), { status: 400 })
  assert.equal((await t.patch(id, { column: 'blocked', note: 'needs keys' }, agent)).history.at(-1).text, 'needs keys')
  await assert.rejects(t.patch(id, { column: 'nope' }, agent), { status: 400 })
  await assert.rejects(t.patch(id, { links: ['javascript:alert(1)'] }, agent), { status: 400 })
  await assert.rejects(t.create('wt-pack', { title: '' }, user), { status: 400 })
  await assert.rejects(t.get('ZZ-1'), { status: 404 })
  const c = await t.comment(id, 'hello', user)
  assert.equal(c.history.at(-1).kind, 'comment')
})

test('claim: 409 when held by another agent, force takes it', async () => {
  const t = new Tickets({ dir: await tmp() })
  const { id } = await t.create('wt-pack', { title: 'x' }, user)
  await t.claim(id, agent)
  await assert.rejects(t.claim(id, { name: 'other', pane: 'w1:p3' }), { status: 409 })
  assert.equal((await t.claim(id, { name: 'other', pane: 'w1:p3' }, true)).assignee.name, 'other')
  assert.equal((await t.patch(id, {}, user, null)).assignee, null)
})

test('corrupt file is quarantined', async () => {
  const dir = await tmp()
  await mkdir(join(dir, 'tickets'), { recursive: true })
  await writeFile(join(dir, 'tickets', 'wt-pack.json'), '{nope')
  const t = new Tickets({ dir, log: () => {} })
  assert.equal((await t.board('wt-pack')).key, 'WP')
  assert.ok((await readdir(join(dir, 'tickets'))).some((f) => f.startsWith('wt-pack.json.corrupt-')))
})

test('needsSession: pane exempts ticket POST/PATCH only', async () => {
  const { needsSession } = await import('./server.mjs')
  const pane = { 'x-herdr-pane': 'w1:p1' }
  assert.equal(needsSession('PATCH', '/api/tickets/WP-1', pane), false)
  assert.equal(needsSession('POST', '/api/tickets', pane), false)
  assert.equal(needsSession('POST', '/api/tickets/WP-1/claim', pane), false)
  assert.equal(needsSession('PATCH', '/api/tickets/WP-1', {}), true)
  assert.equal(needsSession('DELETE', '/api/tickets/WP-1', pane), true)
})

test('list never creates a board', async () => {
  const dir = await tmp()
  const t = new Tickets({ dir })
  assert.deepEqual(await t.list('typo-proj'), { key: null, tickets: [] })
  assert.deepEqual(await t.keys(), {})
})
