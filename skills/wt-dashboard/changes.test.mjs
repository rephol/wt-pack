// Run: node --test changes.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Changes } from './changes.mjs'

const conn = (c, lastId) => {
  const req = new EventEmitter(), out = []
  const res = { writeHead: (code, h) => out.push({ code, h }), write: (s) => out.push(s) }
  c.stream(req, res, lastId)
  const events = () => out.filter((x) => typeof x === 'string' && !x.startsWith(':')).map((s) => ({ id: /^id: (.*)$/m.exec(s)?.[1], event: /^event: (.*)$/m.exec(s)?.[1], data: JSON.parse(/^data: (.*)$/m.exec(s)[1]) }))
  return { out, events, close: () => req.emit('close') }
}

test('events carry <epoch>:<seq> ids and reach every live subscriber', () => {
  const c = new Changes(); const a = conn(c), b = conn(c)
  assert.deepEqual(a.events().map((e) => e.event), ['reset']) // a fresh client: refetch everything, then live
  c.add('tickets', { project: 'wt-pack' })
  for (const s of [a, b]) { const e = s.events().at(-1); assert.deepEqual([e.event, e.id, e.data], ['change', `${c.epoch}:1`, { topic: 'tickets', project: 'wt-pack' }]) }
  assert.equal(a.out[0].h['content-type'], 'text/event-stream')
  b.close(); c.add('inbox'); assert.equal(c.subs.size, 1); assert.equal(b.events().length, 2) // a closed client gets nothing more
})

test('a reconnect with the last id replays exactly the missed events, in order', () => {
  const c = new Changes(); c.add('tickets', { project: 'a' }); c.add('inbox'); c.add('rooms', { slug: 'x' })
  const r = conn(c, `${c.epoch}:1`)
  assert.deepEqual(r.events().map((e) => [e.id.split(':')[1], e.event, e.data.topic]), [['2', 'change', 'inbox'], ['3', 'change', 'rooms']])
  assert.deepEqual(conn(c, c.id).events(), []) // up to date: nothing, no reset
})

test('reset when it cannot resume: no id, another epoch, a gap past the ring, an id from the future', () => {
  const c = new Changes(3)
  for (let i = 0; i < 5; i++) c.add('tickets')
  assert.equal(c.ring.length, 3) // trimmed
  assert.deepEqual(c.since(`${c.epoch}:2`)?.map((e) => e.seq), [3, 4, 5]) // exactly what the ring still holds
  for (const id of [undefined, '', 'junk', `zzzz:3`, `${c.epoch}:1`, `${c.epoch}:99`]) {
    const e = conn(c, id).events(); assert.deepEqual(e.map((x) => x.event), ['reset'], String(id)); assert.equal(e[0].id, c.id)
  }
  assert.equal(c.since(`${c.epoch}:2`) !== null, true)
})

test('a new server (new epoch) never resumes an old id', async () => {
  let t = 1_000_000; const old = new Changes(10, () => t); old.add('tickets'); t += 5000; const next = new Changes(10, () => t)
  assert.notEqual(old.epoch, next.epoch); next.add('tickets')
  assert.deepEqual(conn(next, `${old.epoch}:1`).events().map((e) => e.event), ['reset'])
})

// The write paths that feed the stream (WP-253): every real write calls onChange once, a no-op write does not.
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Tickets } from './tickets.mjs'
import { Inbox } from './inbox.mjs'
import { Rooms } from './rooms.mjs'

test('tickets: create, a real patch and settings emit {project}; a no-op patch does not', async () => {
  const seen = []; const t = new Tickets({ dir: await mkdtemp(join(tmpdir(), 'chg-t-')), onChange: (p) => seen.push(p) })
  const card = await t.create('demo', { title: 'one' }, { name: 'u' })
  assert.deepEqual(seen, ['demo'])
  await t.patch(card.id, { column: 'ready' }, { name: 'u' }); assert.deepEqual(seen, ['demo', 'demo'])
  await t.patch(card.id, { column: 'ready' }, { name: 'u' }); assert.equal(seen.length, 2) // already there: no write, no event
  await t.setSettings('demo', { auto: true }); assert.equal(seen.length, 3)
})

test('inbox: add, patch and compact emit; a patch that hits nothing does not', async () => {
  let n = 0; const ib = new Inbox(await mkdtemp(join(tmpdir(), 'chg-i-')), () => n++)
  const it = await ib.add({ kind: 'server', key: 'k1', title: 't', body: 'b', target: {} }); assert.equal(n, 1)
  await ib.patch(['nope'], { read: true }); assert.equal(n, 1)
  await ib.patch([it.id], { read: true }); assert.equal(n, 2)
  await ib.compact(() => true, { dryRun: true }); assert.equal(n, 2)
  await ib.compact(() => true); assert.equal(n, 3)
})

test('rooms: a room event carries its slug, an index or settings write carries none', async () => {
  const seen = []; const r = new Rooms({ dir: await mkdtemp(join(tmpdir(), 'chg-r-')), onChange: (d) => seen.push(d) })
  r.emit('wp-1', 'message', { id: 1 }); r.notify({})
  assert.deepEqual(seen, [{ slug: 'wp-1' }, {}])
})
