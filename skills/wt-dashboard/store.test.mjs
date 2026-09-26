// Run: node --test store.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readdir, utimes } from 'node:fs/promises'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { open, tx, MIGRATIONS } from './store.mjs'

const tmp = () => mkdtemp(join(tmpdir(), 'store-'))
const version = (db) => db.prepare('PRAGMA user_version').get().user_version

test('migrations run once; reopen keeps user_version', async () => {
  const f = join(await tmp(), 'wt.db')
  const db = open(f)
  assert.equal(version(db), MIGRATIONS.length)
  db.close()
  const out = execFileSync(process.execPath, ['-e', `import('./store.mjs').then((s) => console.log(s.open(${JSON.stringify(f)}).prepare('PRAGMA user_version').get().user_version))`], { cwd: import.meta.dirname, encoding: 'utf8' })
  assert.equal(Number(out), MIGRATIONS.length)
})

test('tx rolls back on throw and refuses an async fn', () => {
  const db = open(':memory:')
  db.exec('CREATE TABLE t (x)')
  assert.throws(() => tx(db, () => { db.exec('INSERT INTO t VALUES (1)'); throw new Error('boom') }), /boom/)
  assert.throws(() => tx(db, async () => db.exec('INSERT INTO t VALUES (2)')), /synchronous/)
  assert.equal(db.prepare('SELECT count(*) n FROM t').get().n, 0)
})

test('loading node:sqlite prints no ExperimentalWarning', () => {
  const r = spawnSync(process.execPath, ['-e', "import('./store.mjs').then((s) => s.open(':memory:'))"], { cwd: import.meta.dirname, encoding: 'utf8' })
  assert.equal(r.status, 0)
  assert.equal(r.stderr, '')
})

test('a legacy file left behind by an interrupted move is moved on reopen, not re-imported', async () => {
  const dir = await tmp()
  const board = (next) => JSON.stringify({ key: 'WP', next, tickets: [] })
  await mkdir(join(dir, 'tickets'))
  await writeFile(join(dir, 'tickets', 'wt-pack.json'), board(5))
  open(join(dir, 'wt.db'), { log: () => {} }).close()
  // simulate the crash: the file is back in DATA, older than wt.db
  await mkdir(join(dir, 'tickets'))
  await writeFile(join(dir, 'tickets', 'wt-pack.json'), board(99))
  for (const f of ['tickets/wt-pack.json', 'tickets']) await utimes(join(dir, f), new Date(0), new Date(0))
  const r = spawnSync(process.execPath, ['-e', `import('./store.mjs').then((s) => console.log(s.open(${JSON.stringify(join(dir, 'wt.db'))}).prepare('SELECT next FROM boards').get().next))`], { cwd: import.meta.dirname, encoding: 'utf8' })
  assert.equal(Number(r.stdout), 5)
  assert.match(r.stderr, /finishing the move/)
  assert.equal((await readdir(dir)).includes('tickets'), false)
  // newer than wt.db (a rollback wrote it): left in place, loudly
  for (const f of await readdir(dir)) if (f.startsWith('wt.db')) await utimes(join(dir, f), new Date(1000), new Date(1000))
  await mkdir(join(dir, 'tickets'))
  await writeFile(join(dir, 'tickets', 'wt-pack.json'), board(99))
  const r2 = spawnSync(process.execPath, ['-e', `import('./store.mjs').then((s) => s.open(${JSON.stringify(join(dir, 'wt.db'))}))`], { cwd: import.meta.dirname, encoding: 'utf8' })
  assert.match(r2.stderr, /rolled back/)
  assert.equal((await readdir(dir)).includes('tickets'), true)
})

test('export: exits 1 without wt.db and never creates one', async () => {
  const root = await tmp()
  const r = spawnSync(process.execPath, ['store.mjs', 'export', '--to', root], { cwd: import.meta.dirname, env: { ...process.env, WT_DASHBOARD_DATA: root }, encoding: 'utf8' })
  assert.equal(r.status, 1)
  assert.deepEqual(await readdir(root), [])
})

test('import stage 2: rooms fold delivered lines, skip torn ones, keep orphan files; inbox folds updates; export round-trips', async () => {
  const { Rooms } = await import('./rooms.mjs')
  const { Inbox } = await import('./inbox.mjs')
  const { readFile } = await import('node:fs/promises')
  const { exportTo } = await import('./store.mjs')
  const dir = await tmp()
  const m = (id, text) => JSON.stringify({ id, ts: 't', author: { kind: 'user', name: 'you' }, text, mentions: [], deliveredTo: [] })
  await mkdir(join(dir, 'rooms'))
  await writeFile(join(dir, 'rooms.json'), JSON.stringify([{ slug: 'ops', title: 'Ops', members: [], archived: false }]))
  await writeFile(join(dir, 'rooms', 'ops.jsonl'), [m('1', 'hi'), JSON.stringify({ type: 'delivered', id: '1', to: 'w1', dropped: 2 }), '{"torn', m('2', 'yo')].join('\n') + '\n')
  await writeFile(join(dir, 'rooms', 'orphan.jsonl'), m('3', 'lost') + '\n')
  await writeFile(join(dir, 'notifications.jsonl'), [JSON.stringify({ id: 'n1', kind: 'server', read: false }), JSON.stringify({ type: 'update', id: 'n1', patch: { read: true } })].join('\n') + '\n')
  const rooms = new Rooms({ dir, agents: async () => [], prompt: async () => {}, log: () => {} })
  assert.deepEqual((await rooms.list()).map((r) => r.slug), ['ops', 'orphan'])
  const ops = await rooms.messages('ops')
  assert.deepEqual(ops.map((x) => [x.id, x.deliveredTo, x.undelivered]), [['1', ['w1'], [{ to: 'w1', n: 2 }]], ['2', [], undefined]])
  const box = new Inbox(dir); await box.load()
  assert.deepEqual(box.items.map((i) => [i.id, i.read]), [['n1', true]])
  const [backup] = (await readdir(dir)).filter((f) => f.startsWith('pre-sqlite-'))
  assert.deepEqual((await readdir(join(dir, backup))).sort(), ['notifications.jsonl', 'rooms', 'rooms.json'])
  const out = await tmp()
  exportTo(join(dir, 'wt.db'), out)
  assert.deepEqual(JSON.parse(await readFile(join(out, 'rooms.json'), 'utf8')).map((r) => r.slug), ['ops', 'orphan'])
  assert.equal((await readFile(join(out, 'rooms', 'ops.jsonl'), 'utf8')).trim().split('\n').length, 2)
  assert.equal(JSON.parse(await readFile(join(out, 'notifications.jsonl'), 'utf8')).read, true)
})

test('migration 6 (WP-52) upgrades a v5 db: dispatch off on every board, stall_min 45, board_events', async () => {
  const f = join(await tmp(), 'wt.db')
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite')
  const old = new DatabaseSync(f)
  MIGRATIONS.slice(0, 5).forEach((m) => old.exec(m.sql))
  old.exec("PRAGMA user_version = 5; INSERT INTO boards (project, key, next, auto) VALUES ('wt-pack', 'WP', 3, 1)")
  old.close()
  const db = open(f)
  assert.equal(version(db), 7)
  assert.deepEqual({ ...db.prepare('SELECT auto, dispatch, stall_min, report_room, report_orch FROM boards').get() }, { auto: 1, dispatch: 0, stall_min: 45, report_room: null, report_orch: 1 })
  assert.equal(db.prepare('SELECT count(*) n FROM board_events').get().n, 0)
})
