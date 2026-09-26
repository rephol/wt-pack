// Run: node --test tickets.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Tickets, deriveKey, ticketRow } from './tickets.mjs'
import { exportTo } from './store.mjs'

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

test('create: sequential ids, history, next', async () => {
  const dir = await tmp()
  const t = new Tickets({ dir, reserved: ['UMK'] })
  const a = await t.create('wt-pack', { title: ' First ', type: 'bug' }, user)
  const b = await t.create('wt-pack', { title: 'Second', column: 'ready' }, agent)
  assert.deepEqual([a.id, b.id, a.title, a.column, b.column], ['WP-1', 'WP-2', 'First', 'backlog', 'ready'])
  assert.equal(a.history[0].author, 'Rep')
  assert.equal((await t.board('wt-pack')).next, 3)
  assert.equal(ticketRow(a), 'WP-1 [backlog] (bug) First') // priority 0 = none
  assert.equal(ticketRow({ ...a, priority: 2 }), 'WP-1 [backlog] (bug,P2) First')
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

const board = { key: 'WPK', next: 8, tickets: [{ id: 'WPK-6', title: 'six', column: 'done', history: [{ kind: 'create' }] }, { id: 'WPK-7', title: 'seven', column: 'ready', history: [] }] }
const legacy = async (files) => {
  const dir = await tmp()
  await mkdir(join(dir, 'tickets'), { recursive: true })
  for (const [f, text] of Object.entries(files)) await writeFile(join(dir, 'tickets', f), text)
  return dir
}

test('import: legacy board keeps ids, next and history; files move to pre-sqlite-*; no re-import', async () => {
  const dir = await legacy({ 'wt-pack.json': JSON.stringify(board) })
  const t = new Tickets({ dir, log: () => {} })
  assert.deepEqual(await t.list('wt-pack'), { key: 'WPK', auto: false, tickets: board.tickets })
  assert.equal((await t.create('wt-pack', { title: 'after' }, user)).id, 'WPK-8')
  const [backup] = (await readdir(dir)).filter((f) => f.startsWith('pre-sqlite-'))
  assert.deepEqual(JSON.parse(await readFile(join(dir, backup, 'tickets', 'wt-pack.json'), 'utf8')), board)
  assert.equal((await readdir(dir)).includes('tickets'), false)
  // export writes the old { key, next, tickets } shape
  const out = await tmp()
  exportTo(join(dir, 'wt.db'), out)
  const back = JSON.parse(await readFile(join(out, 'tickets', 'wt-pack.json'), 'utf8'))
  assert.deepEqual([back.key, back.next, back.tickets.map((x) => x.id)], ['WPK', 9, ['WPK-6', 'WPK-7', 'WPK-8']])
})

test('import: an unreadable board keeps its key and id range', async () => {
  const dir = await legacy({ 'wt-pack.json.corrupt-1': '{"key": "WPK", "next": 8, "tickets": [{"id": "WPK-7"}, {"id": "WPK-12", trunc', 'web.json': '{nope' })
  const logs = []
  const t = new Tickets({ dir, log: (m) => logs.push(m) })
  assert.equal((await t.create('wt-pack', { title: 'after' }, user)).id, 'WPK-13')
  assert.equal(logs.filter((m) => m.includes('unreadable')).length, 2)
})

test('no-op patch keeps updated and history', async () => {
  const t = new Tickets({ dir: await tmp() })
  const a = await t.create('wt-pack', { title: 'x', priority: 1 }, user)
  await new Promise((r) => setTimeout(r, 5))
  const b = await t.patch(a.id, { title: 'x', priority: 1, column: 'backlog' }, user)
  assert.equal(b.updated, a.updated)
  assert.equal(b.history.length, 1)
  assert.notEqual((await t.patch(a.id, { priority: 3 }, user)).updated, a.updated)
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
  assert.deepEqual(await t.list('typo-proj'), { key: null, auto: false, tickets: [] })
  assert.deepEqual(await t.keys(), {})
})

// The pane is verified before the body is parsed or the board touched: an unknown pane gets 403 even for a bad body.
test('server: unknown pane → 403 before body parsing, board unchanged', async () => {
  const { spawn } = await import('node:child_process')
  const root = await tmp()
  await mkdir(join(root, 'data', 'tickets'), { recursive: true })
  const file = join(root, 'data', 'tickets', 'wt-pack.json')
  const board = JSON.stringify({ key: 'WP', next: 2, tickets: [{ id: 'WP-1', title: 'x', column: 'backlog', history: [] }] })
  await writeFile(file, board)
  const port = 20000 + Math.floor(Math.random() * 20000)
  const srv = spawn(process.execPath, [new URL('./server.mjs', import.meta.url).pathname], {
    env: { ...process.env, PORT: String(port), WT_DASHBOARD_DATA: root, HOME: root }, stdio: 'ignore' })
  try {
    const call = async (method, path, body) => {
      for (let i = 0; ; i++) {
        try {
          return await fetch(`http://127.0.0.1:${port}${path}`, { method, body, headers: { 'x-herdr-pane': 'w999:p999', 'content-type': 'application/json' } })
        } catch (e) { if (i > 50) throw e; await new Promise((r) => setTimeout(r, 100)) }
      }
    }
    assert.equal((await call('PATCH', '/api/tickets/WP-1', '{"column":"done"}')).status, 403)
    assert.equal((await call('PATCH', '/api/tickets/WP-1', '{not json')).status, 403)
    assert.equal((await call('POST', '/api/tickets', '{"title":"t","project":"wt-pack"}')).status, 403)
    assert.equal((await call('POST', '/api/tickets/WP-1/claim', '{}')).status, 403)
    assert.deepEqual((await new Tickets({ dir: join(root, 'data') }).list('wt-pack')).tickets, JSON.parse(board).tickets)
  } finally { srv.kill() }
})

test('jevApply / jevUndo', async () => {
  const t = new Tickets({ dir: await tmp() })
  const a = await t.create('wt-pack', { title: 'A' }, user)
  await t.patch(a.id, { size: 'M' }, user) // edited before Jev answered: left alone
  await t.patch(a.id, { size: null }, user) // back at the default, still the user's
  const d = { type: 'bug', size: 'L', priority: 2, owner: 'worker', dupes: ['WP-9'] }
  const j = await t.jevApply(a.id, d, ['type', 'size', 'priority'])
  assert.deepEqual([j.type, j.size, j.priority], ['bug', null, 2])
  assert.deepEqual(j.jev.applied, { type: { from: 'feature', to: 'bug' }, priority: { from: 0, to: 2 } })
  assert.deepEqual([j.jev.owner, j.jev.dupes, j.history.at(-1).author], ['worker', ['WP-9'], 'jev'])
  const u = await t.jevUndo(a.id, 'type', user)
  assert.equal(u.type, 'feature')
  assert.deepEqual(Object.keys(u.jev.applied), ['priority'])
  await assert.rejects(t.jevUndo(a.id, 'type', user), /no Jev suggestion/)
  await assert.rejects(t.jevUndo(a.id, 'constructor', user), /no Jev suggestion/)
  const p = await t.patch(a.id, { priority: 3, jev: { applied: {} } }, user) // manual edit drops the badge; jev in a body is ignored
  assert.deepEqual([p.priority, p.jev.applied, p.jev.dupes], [3, {}, ['WP-9']])
  const b = await t.create('wt-pack', { title: 'B', type: 'ux' }, user) // set by the creator: never in `empty`, never changed
  assert.equal((await t.jevApply(b.id, d, ['size'])).type, 'ux')
})

test('jevApply re-triage (wt-ticket triage): keeps earlier undoable fields, never re-fills an undone one', async () => {
  const t = new Tickets({ dir: await tmp() })
  const a = await t.create('wt-pack', { title: 'A' }, user)
  assert.equal(await t.project(a.id.toLowerCase()), 'wt-pack')
  const all = ['type', 'size', 'priority']
  await t.jevApply(a.id, { type: 'bug', size: null, priority: 2, owner: 'worker', dupes: [] }, all)
  await t.jevUndo(a.id, 'priority', user)
  const j = await t.jevApply(a.id, { type: 'ux', size: 'S', priority: 3, owner: 'planner', dupes: ['WP-2'] }, all)
  assert.deepEqual([j.type, j.size, j.priority, j.jev.owner], ['bug', 'S', 0, 'planner']) // Jev's own edit entry does not block size
  assert.deepEqual(Object.keys(j.jev.applied).sort(), ['size', 'type'])
})

test('Auto defaults off; manual move drops a pending promotion undo', async () => {
  const t = new Tickets({ dir: await tmp() })
  const a = await t.create('wt-pack', { title: 'A' }, user)
  assert.equal(await t.auto('wt-pack'), false)
  assert.equal(await t.auto('nope'), false)
  await t.jevPromote(a.id, 0.7)
  const m = await t.patch(a.id, { column: 'building' }, user)
  assert.equal(m.jev.applied.column, undefined)
  await assert.rejects(t.jevUndo(a.id, 'column', user), /no Jev suggestion/)
  assert.equal((await t.jevPromote(a.id, 0.9)).column, 'building') // only from Backlog
})

test('setAuto never creates a board', async () => {
  const t = new Tickets({ dir: await tmp() })
  await assert.rejects(t.setAuto('typo-proj', true), (e) => e.status === 404)
  assert.deepEqual(await t.keys(), {})
})
