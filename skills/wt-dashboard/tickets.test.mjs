// Run: node --test tickets.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Tickets, deriveKey, ticketRow, ticketMatches } from './tickets.mjs'
import { exportTo } from './store.mjs'

const tmp = () => mkdtemp(join(tmpdir(), 'tickets-'))
const user = { name: 'Rep' }
const agent = { name: 'wt-pack-worker-01', pane: 'w1:p2' }

test('deriveKey', () => {
  assert.equal(deriveKey('wt-pack'), 'WP')
  assert.equal(deriveKey('acmeapp'), 'ACM')
  assert.equal(deriveKey('acmeapp', new Set(['ACM'])), 'ACME')
  assert.equal(deriveKey('web-portal', new Set(['WP'])), 'WPB')
  assert.equal(deriveKey('my_app2'), 'MA')
})

test('create: sequential ids, history, next', async () => {
  const dir = await tmp()
  const t = new Tickets({ dir, reserved: ['ACM'] })
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
  const t = new Tickets({ dir: await tmp(), reserved: ['ACM'] })
  const [a, b] = await Promise.all([t.board('web-portal'), t.board('wt-pack')])
  assert.notEqual(a.key, b.key)
  assert.equal((await t.board('acmeapp')).key, 'ACME')
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
  assert.deepEqual(await t.list('wt-pack'), { key: 'WPK', auto: false, minPriority: 2, dispatch: false, stallMin: 45, reportRoom: null, reportOrch: true, tickets: board.tickets })
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

test('import: a bad-shape board is skipped and salvaged, not blocking the rest; a keyless one is reported (WP-25)', async () => {
  const dup = JSON.stringify({ key: 'BAD', next: 4, tickets: [{ id: 'BAD-3' }, { id: 'BAD-3' }] })
  const ok = JSON.stringify({ key: 'OK', next: 2, tickets: [{ id: 'OK-1', title: 'kept' }] })
  const dir = await legacy({ 'bad.json': dup, 'ok.json': ok, 'web.json': '{nope' })
  const logs = []
  const t = new Tickets({ dir, log: (m) => logs.push(m) })
  assert.equal((await t.create('bad', { title: 'after' }, user)).id, 'BAD-4')
  assert.equal((await t.create('ok', { title: 'after' }, user)).id, 'OK-2')
  assert.ok(logs.some((m) => /bad\.json has a bad shape/.test(m)))
  assert.ok(logs.some((m) => /tickets\/web has no recoverable key/.test(m)))
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
  assert.equal(needsSession('DELETE', '/api/rooms/tmp-wp-42-w', pane), false) // WP-42; owner checked by agentMayDelete
  assert.equal(needsSession('DELETE', '/api/rooms/wt-pack', pane), true)
})

test('list never creates a board', async () => {
  const dir = await tmp()
  const t = new Tickets({ dir })
  assert.deepEqual(await t.list('typo-proj'), { key: null, auto: false, minPriority: 2, dispatch: false, stallMin: 45, reportRoom: null, reportOrch: true, tickets: [] })
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
    env: { ...process.env, PORT: String(port), WT_DASHBOARD_DATA: root, HOME: root }, stdio: ['ignore', 'pipe', 'pipe'] })
  try {
    // Wait for the server's own "listening" line (WP-40): under a loaded `npm test` startup took > 5s, which a
    // fixed connect-retry budget read as a failure. Exit or 30s without it is a real failure.
    await new Promise((res, rej) => {
      let out = '', err = ''
      srv.stdout.on('data', (d) => { out += d; if (out.includes('api →')) res() })
      srv.stderr.on('data', (d) => { err += d })
      srv.on('exit', (c) => rej(new Error(`server exited (${c}) before listening: ${err.slice(-400)}`)))
      setTimeout(() => rej(new Error('server not listening after 30s')), 30_000).unref()
    })
    const call = (method, path, body) => fetch(`http://127.0.0.1:${port}${path}`, { method, body, headers: { 'x-herdr-pane': 'w999:p999', 'content-type': 'application/json' } })
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
  assert.deepEqual(Object.keys(j.jev.applied).sort(), ['labels', 'size', 'type'])
  assert.deepEqual(j.labels, ['needs-plan']) // owner planner → the label Dispatch routes on
  const u = await t.jevUndo(a.id, 'labels', user)
  assert.deepEqual(u.labels, [])
  const r = await t.jevApply(a.id, { owner: 'planner', dupes: [] }, all) // undone: never re-added
  assert.deepEqual(r.labels, [])
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

test('list: an unknown column is a 400, not an empty list', async () => {
  const t = new Tickets({ dir: await tmp() })
  await assert.rejects(t.list('wt-pack', 'nope'), (e) => e.status === 400 && /column: backlog\|ready/.test(e.message))
})

test('board settings: minPriority defaults to High, partial updates, validated (WP-46)', async () => {
  const t = new Tickets({ dir: await tmp() })
  await t.create('wt-pack', { title: 'A' }, user)
  const rep = { reportRoom: null, reportOrch: true }
  assert.deepEqual(await t.settings('wt-pack'), { auto: false, minPriority: 2, dispatch: false, stallMin: 45, ...rep })
  assert.deepEqual(await t.setSettings('wt-pack', { auto: true }), { auto: true, minPriority: 2, dispatch: false, stallMin: 45, ...rep })
  assert.deepEqual(await t.setSettings('wt-pack', { minPriority: 3, dispatch: false, stallMin: 45 }), { auto: true, minPriority: 3, dispatch: false, stallMin: 45, ...rep }) // auto untouched
  await assert.rejects(t.setSettings('wt-pack', { minPriority: 5 }), (e) => e.status === 400)
  await assert.rejects(t.setSettings('nope', { minPriority: 3 }), (e) => e.status === 404)
})

test('moving back to Backlog clears the assignee (WP-49)', async () => {
  const t = new Tickets({ dir: await tmp() })
  const a = await t.create('wt-pack', { title: 'x', column: 'building' }, user)
  await t.patch(a.id, {}, user, { name: 'w-01', pane: 'p' })
  const b = await t.patch(a.id, { column: 'backlog' }, user)
  assert.deepEqual([b.assignee, b.history.at(-1).kind], [null, 'assign'])
  assert.equal((await t.patch(a.id, { column: 'ready' }, user)).assignee, null)
})

test('dispatch settings: default off, stallMin validated', async () => {
  const t = new Tickets({ dir: await tmp() })
  await t.create('wt-pack', { title: 'x' }, user)
  assert.deepEqual(await t.settings('wt-pack'), { auto: false, minPriority: 2, dispatch: false, stallMin: 45, reportRoom: null, reportOrch: true })
  assert.equal((await t.setSettings('wt-pack', { dispatch: true, stallMin: 30 })).dispatch, true)
  assert.equal((await t.settings('wt-pack')).stallMin, 30)
  await assert.rejects(t.setSettings('wt-pack', { stallMin: 0 }), /stallMin/)
})

test('dispatchClaim: one winner in a race; refused on assigned, non-Ready or claimed cards; failed retried after 2 min', async () => {
  const t = new Tickets({ dir: await tmp() })
  const a = await t.create('wt-pack', { title: 'a', column: 'ready' }, user)
  const wins = (await Promise.all([t.dispatchClaim(a.id), t.dispatchClaim(a.id)])).filter(Boolean)
  assert.equal(wins.length, 1)
  assert.equal(wins[0].dispatch.state, 'dispatching')
  assert.equal(await t.dispatchClaim(a.id), null) // already claimed
  await assert.rejects(t.claim(a.id, agent), /being dispatched/) // claim window closed
  const b = await t.create('wt-pack', { title: 'b', column: 'ready' }, user)
  await t.claim(b.id, agent)
  assert.equal(await t.dispatchClaim(b.id), null) // assigned
  const c = await t.create('wt-pack', { title: 'c' }, user)
  assert.equal(await t.dispatchClaim(c.id), null) // backlog
  const now = Date.now()
  await t.setDispatch(a.id, { state: 'failed', at: new Date(now).toISOString(), fails: 1 })
  assert.equal(await t.dispatchClaim(a.id, now + 60_000), null)
  assert.equal((await t.dispatchClaim(a.id, now + 180_000)).dispatch.fails, 1)
})

test('dispatch cleared only on a move into Ready or Backlog', async () => {
  const t = new Tickets({ dir: await tmp() })
  const a = await t.create('wt-pack', { title: 'a', column: 'ready' }, user)
  await t.setDispatch(a.id, { state: 'sent', at: 'x', agent: 'w' })
  assert.equal((await t.patch(a.id, { column: 'building' }, user)).dispatch.state, 'sent')
  assert.equal((await t.patch(a.id, { column: 'review' }, user)).dispatch.state, 'sent')
  assert.equal((await t.patch(a.id, { column: 'ready' }, user)).dispatch, undefined)
  await t.setDispatch(a.id, { state: 'held', at: 'x', fails: 3 })
  assert.equal((await t.patch(a.id, { column: 'ready' }, user)).dispatch.state, 'held') // Ready → Ready: no-op
  assert.equal((await t.patch(a.id, { column: 'backlog' }, user)).dispatch, undefined)
})

test('board settings: Report to — defaults, slug, none, back to null, validated (WP-75)', async () => {
  const t = new Tickets({ dir: await tmp() })
  await t.create('wt-pack', { title: 'A' }, user)
  const pick = async (b) => { const s = await t.setSettings('wt-pack', b); return [s.reportRoom, s.reportOrch] }
  assert.deepEqual(await pick({}), [null, true])
  assert.deepEqual(await pick({ reportRoom: 'ops', reportOrch: false }), ['ops', false])
  assert.deepEqual(await pick({ reportRoom: '' }), ['', false])
  assert.deepEqual(await pick({ reportRoom: 'none' }), ['none', false]) // a room slugged 'none' stays selectable
  assert.deepEqual(await pick({ reportRoom: null }), [null, false])
  await assert.rejects(t.setSettings('wt-pack', { reportRoom: 'x'.repeat(65) }), (e) => e.status === 400)
  await assert.rejects(t.setSettings('wt-pack', { reportRoom: 5 }), (e) => e.status === 400)
})

test('ticketMatches: id, title, body, label, comment and move note; never authors or edits; AND of words (WP-90)', () => {
  const t = {
    id: 'WP-3', title: 'Dispatch report target', body: 'Pick the room', labels: ['needs-plan'],
    history: [
      { kind: 'create', author: 'jev' },
      { kind: 'edit', author: 'Rep', text: 'priority, size' },
      { kind: 'comment', author: 'Quinn', text: 'Workers stopped posting' },
      { kind: 'move', author: 'w', to: 'blocked', text: 'waiting on herdr' },
    ],
  }
  for (const q of ['wp-3', 'DISPATCH', 'the room', 'needs-plan', 'stopped posting', 'herdr', '', '  ', 'report  room']) assert.equal(ticketMatches(t, q), true, q)
  for (const q of ['jev', 'quinn', 'priority', 'dispatch nowhere']) assert.equal(ticketMatches(t, q), false, q)
  assert.equal(ticketMatches({ id: 'WP-4', title: 'x' }, 'x'), true) // no body, labels or history
})

test('list: column and query combine (WP-90)', async () => {
  const t = new Tickets({ dir: await tmp() })
  await t.create('wt-pack', { title: 'foo ready', column: 'ready' }, user)
  await t.create('wt-pack', { title: 'foo backlog' }, user)
  await t.create('wt-pack', { title: 'bar ready', column: 'ready' }, user)
  assert.deepEqual((await t.list('wt-pack', 'ready', 'foo')).tickets.map((x) => x.title), ['foo ready'])
  assert.deepEqual((await t.list('wt-pack', undefined, 'foo')).tickets.map((x) => x.title), ['foo ready', 'foo backlog'])
  assert.equal((await t.list('wt-pack')).tickets.length, 3)
})
