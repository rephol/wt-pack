// Run: node --test sessions.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseHead, listBuiltin, readPins, writePin, overlay, isUuid, roleFromAgent } from './sessions.mjs'

const u = (text, extra = {}) => JSON.stringify({ type: 'user', cwd: '/w/app', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: [{ type: 'text', text }] }, ...extra })

test('parseHead skips command lines and a cut-off tail', () => {
  const h = parseHead([u('<command-name>/x</command-name>'), u('fix the\n bug'), '{"type":"us'].join('\n'))
  assert.deepEqual(h, { cwd: '/w/app', started: '2026-01-01T00:00:00Z', tldr: 'fix the bug' })
})

test('listBuiltin: newest first, fields from the head', async () => {
  const d = await mkdtemp(join(tmpdir(), 'sess-'))
  await mkdir(join(d, 'p1'))
  const [a, b] = ['a', 'b'].map((x) => `${x.repeat(8)}-aaaa-bbbb-cccc-${x.repeat(12)}`)
  await writeFile(join(d, 'p1', `${a}.jsonl`), u('<command-name>/x</command-name>') + '\n' + u('older'))
  await writeFile(join(d, 'p1', `${b}.jsonl`), u('newer'))
  await utimes(join(d, 'p1', `${a}.jsonl`), 1000, 1000)
  const rows = await listBuiltin(d, 10)
  assert.deepEqual(rows.map((r) => [r.id, r.tldr, r.proj]), [[b, 'newer', 'app'], [a, 'older', 'app']])
})

test('pin round-trip keeps other entries; overlay puts pinned first', async () => {
  const f = join(await mkdtemp(join(tmpdir(), 'pin-')), 'frozen.json')
  await writeFile(f, JSON.stringify({ keep: { note: 'k' } }))
  await writePin(f, 'x', { note: 'n', proj: 'app' })
  assert.deepEqual(Object.keys(await readPins(f)), ['keep', 'x'])
  const rows = overlay([{ id: 'new', mtime: 9 }, { id: 'x', mtime: 1 }], await readPins(f), new Set(['new']))
  assert.deepEqual(rows.map((r) => [r.id, r.frozen, r.live]), [['x', true, false], ['new', false, true]])
  await writePin(f, 'x', null)
  assert.deepEqual(Object.keys(JSON.parse(await readFile(f, 'utf8'))), ['keep'])
})

test('helpers', () => {
  assert.equal(roleFromAgent('wt-pack-worker-07'), 'worker')
  assert.equal(roleFromAgent('foo'), null)
  assert.ok(isUuid('aaaaaaaa-aaaa-bbbb-cccc-aaaaaaaaaaaa'))
  assert.ok(!isUuid('../etc'))
})
