import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, utimes, readFile, readdir, symlink, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { housekeep, cleanSettings } from './housekeeping.mjs'
import { Inbox } from './inbox.mjs'
import { Rooms } from './rooms.mjs'

const DAY = 86_400_000
const now = Date.parse('2026-09-26T00:00:00Z')
const age = (f, days) => utimes(f, (now - days * DAY) / 1000, (now - days * DAY) / 1000)

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'hk-'))
  const up = join(root, 'uploads', '2026-08-01')
  await mkdir(up, { recursive: true })
  for (const f of ['old.png', 'ref.png', 'archref.png', 'new.png']) await writeFile(join(up, f), 'x'.repeat(10))
  for (const f of ['old.png', 'ref.png', 'archref.png']) await age(join(up, f), 40)
  const mem = join(root, 'mem'); const ag = join(root, 'ag')
  await mkdir(mem); await mkdir(ag)
  for (const f of ['dead.hash', 'live.hash']) { await writeFile(join(mem, f), 'h'); await age(join(mem, f), 10) }
  await writeFile(join(mem, 'fresh-dead.hash'), 'h')
  for (const f of ['mcp-gone.json', 'mcp-alive.json']) { await writeFile(join(ag, f), '{}'); await age(join(ag, f), 10) }
  const log = join(root, 'server.log')
  await writeFile(log, 'L'.repeat(2 * 1024 * 1024))
  await writeFile(log + '.1', 'one'); await writeFile(log + '.2', 'two')
  const audit = join(root, 'audit.jsonl')
  await writeFile(audit, 'A'.repeat(2 * 1024 * 1024))
  // The inbox and its rooms live in <nf>/wt.db; the live room names ref.png, the archived one archref.png.
  const nf = join(root, 'data')
  const rooms = new Rooms({ dir: nf, agents: async () => [], prompt: async () => {}, log: () => {} })
  for (const [slug, text] of [['live', 'see /x/uploads/2026-08-01/ref.png'], ['gone', 'archref.png']]) {
    await rooms.create({ title: slug, slug })
    await rooms.post(slug, { author: { kind: 'user', name: 'you' }, text })
  }
  await rooms.update('gone', { archived: true })
  const ins = new Inbox(nf).db.prepare('INSERT INTO notifications (id, json) VALUES (?, ?)')
  for (const [id, resolvedAt] of [['a', '2026-08-01T00:00:00Z'], ['b', null], ['c', '2026-09-25T00:00:00Z']]) ins.run(id, JSON.stringify({ id, ts: '2026-08-01T00:00:00Z', resolvedAt }))
  const ctx = (extra = {}) => ({
    roots: [root], uploads: join(root, 'uploads'),
    roomRefs: rooms.liveText(),
    inbox: new Inbox(nf),
    rotate: [{ file: log, mode: 'copytruncate' }, { file: audit, mode: 'rename' }],
    memCache: mem, agentsCache: ag, live: { sessions: new Set(['live']), names: new Set(['alive']) },
    settings: { rotateMB: 1 }, now, ...extra,
  })
  return { root, up, mem, ag, log, audit, nf, ctx }
}

test('dry run reports but touches nothing', async () => {
  const f = await fixture()
  const count = () => new Inbox(f.nf).db.prepare('SELECT count(*) n FROM notifications').get().n
  const before = count()
  const s = await housekeep(f.ctx({ dryRun: true }))
  assert.ok(s.files >= 4 && s.actions.length >= 6, JSON.stringify(s))
  assert.deepEqual((await readdir(f.up)).sort(), ['archref.png', 'new.png', 'old.png', 'ref.png'])
  assert.equal(count(), before)
  assert.equal((await stat(f.log)).size, 2 * 1024 * 1024)
  assert.ok(existsSync(join(f.mem, 'dead.hash')))
})

test('real run: uploads, inbox, rotation, caches', async () => {
  const f = await fixture()
  const inbox = new Inbox(f.nf)
  const s = await housekeep(f.ctx({ inbox }))
  assert.deepEqual(s.errors, [])
  assert.deepEqual((await readdir(f.up)).sort(), ['new.png', 'ref.png']) // archived room's ref doesn't keep it
  assert.deepEqual(inbox.items.map((i) => i.id), ['b', 'c'])
  const re = new Inbox(f.nf); await re.load()
  assert.deepEqual(re.items.map((i) => [i.id, i.resolvedAt]), [['b', null], ['c', '2026-09-25T00:00:00Z']])
  assert.equal((await stat(f.log)).size, 0) // copytruncate
  assert.equal((await stat(f.log + '.1')).size, 2 * 1024 * 1024)
  assert.equal(await readFile(f.log + '.2', 'utf8'), 'one') // kept 2; 'two' dropped
  assert.ok(!existsSync(f.log + '.3'))
  assert.ok(!existsSync(f.audit) && existsSync(f.audit + '.1'))
  assert.deepEqual((await readdir(f.mem)).sort(), ['fresh-dead.hash', 'live.hash'])
  assert.deepEqual(await readdir(f.ag), ['mcp-alive.json'])
  assert.equal(s.files, 5) // 2 uploads, server.log.2, dead.hash, mcp-gone.json (rotation moves, it does not free)
})

test('unknown liveness leaves caches alone', async () => {
  const f = await fixture()
  await housekeep(f.ctx({ live: null }))
  assert.equal((await readdir(f.mem)).length, 3)
})

test('path guard: nothing outside the roots, no symlinks', async () => {
  const f = await fixture()
  const outside = await mkdtemp(join(tmpdir(), 'hk-out-'))
  await writeFile(join(outside, 'victim.png'), 'v'); await age(join(outside, 'victim.png'), 99)
  await symlink(join(outside, 'victim.png'), join(f.up, 'link.png'))
  const s = await housekeep(f.ctx({ roots: [join(f.root, 'uploads')], rotate: [{ file: f.log, mode: 'copytruncate' }], inbox: null, live: null }))
  assert.ok(existsSync(join(outside, 'victim.png')))
  assert.ok(s.errors.some((e) => e.includes('outside the allowed dirs')), JSON.stringify(s.errors)) // server.log is outside uploads/
  assert.equal((await stat(f.log)).size, 2 * 1024 * 1024)
})

test('settings validation', () => {
  assert.deepEqual(cleanSettings({}), { uploadsDays: 30, resolvedDays: 14, rotateMB: 5, rotateKeep: 2, cacheDays: 7 })
  assert.throws(() => cleanSettings({ uploadsDays: 0 }))
  assert.throws(() => cleanSettings({ rotateMB: '5' }))
})
