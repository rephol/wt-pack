// Run: node --test skills/wt-dashboard/uploads.test.mjs — WP-170 upload/room-attachment type + security checks.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'

const tmp = mkdtempSync(join(tmpdir(), 'wt-uploads-'))
const agentDir = mkdtempSync('/tmp/wt-uploads-agent-') // an agent may attach only from its cwd or /tmp
process.on('exit', () => rmSync(agentDir, { recursive: true, force: true }))
process.env.WT_DASHBOARD_DATA = tmp
const { saveUpload, roomAttachments, sanitizeFilename } = await import('./server.mjs')

// A fake req: an EventEmitter carrying `headers`, feeding a body through data/end like rawBody expects.
function fakeReq(headers, body) {
  const r = new EventEmitter()
  r.headers = headers
  process.nextTick(() => { if (body.length) r.emit('data', Buffer.from(body)); r.emit('end') })
  return r
}

test('sanitizeFilename: basename only, control chars stripped, trimmed, capped, never empty', () => {
  assert.equal(sanitizeFilename('../../etc/passwd'), 'passwd')
  assert.equal(sanitizeFilename('a\u0000b\u001fc.txt'), 'abc.txt')
  assert.equal(sanitizeFilename('  spaced.txt  '), 'spaced.txt')
  assert.equal(sanitizeFilename(''), 'file')
  assert.equal(sanitizeFilename(undefined), 'file')
  assert.equal(sanitizeFilename('x'.repeat(300) + '.txt').length, 200)
})

test('saveUpload: a text file needs no magic bytes, stored under a uuid name, served attachment-only', async () => {
  const [code, out] = await saveUpload(fakeReq({ 'x-filename': encodeURIComponent('notes.txt') }, 'hello world'))
  assert.equal(code, 200)
  assert.equal(out.name, 'notes.txt')
  assert.equal(out.size, 11)
  assert.equal(out.mime, 'text/plain')
  assert.match(out.path, /\/[0-9a-f-]{36}\.txt$/) // never the client filename on disk
})

test('saveUpload: a .jpeg extension still resolves to a real image, not just .jpg (WP-170 filename-based lookup)', async () => {
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from('rest')])
  const [code, out] = await saveUpload(fakeReq({ 'x-filename': encodeURIComponent('photo.jpeg') }, jpg))
  assert.equal(code, 200)
  assert.equal(out.mime, 'image/jpeg')
  assert.match(out.path, /\/[0-9a-f-]{36}\.jpg$/)
})

test('saveUpload: csv and json get their own safe download mime, still attachment-only', async () => {
  const csv = await saveUpload(fakeReq({ 'x-filename': encodeURIComponent('a.csv') }, 'a,b\n1,2'))
  assert.equal(csv[1].mime, 'text/csv')
  const json = await saveUpload(fakeReq({ 'x-filename': encodeURIComponent('a.json') }, '{}'))
  assert.equal(json[1].mime, 'application/json')
})

test('saveUpload: html/svg are refused outright — no way to get one served, inline or otherwise (WP-170)', async () => {
  const [code, out] = await saveUpload(fakeReq({ 'x-filename': encodeURIComponent('page.html') }, '<html></html>'))
  assert.equal(code, 415)
  assert.ok(out.error)
  const svg = await saveUpload(fakeReq({ 'x-filename': encodeURIComponent('x.svg') }, '<svg></svg>'))
  assert.equal(svg[0], 415)
})

test('saveUpload: pdf/zip must actually match their signature, not just their extension', async () => {
  const fake = await saveUpload(fakeReq({ 'x-filename': encodeURIComponent('doc.pdf') }, 'not a real pdf'))
  assert.equal(fake[0], 400)
  const real = await saveUpload(fakeReq({ 'x-filename': encodeURIComponent('doc.pdf') }, '%PDF-1.4 fake-but-signed'))
  assert.equal(real[0], 200)
})

test('saveUpload: a path-y or control-char filename is sanitized before it is stored/echoed', async () => {
  const [code, out] = await saveUpload(fakeReq({ 'x-filename': encodeURIComponent('../../evil\u0000.txt') }, 'x'))
  assert.equal(code, 200)
  assert.equal(out.name, 'evil.txt')
})

test('roomAttachments: a user can attach an uploaded text file; the original name rides along', async () => {
  const [, up] = await saveUpload(fakeReq({ 'x-filename': encodeURIComponent('report.csv') }, 'a,b\n1,2'))
  const out = await roomAttachments({ kind: 'user' }, { attachments: [{ path: up.path, name: 'report.csv' }] })
  assert.equal(out.length, 1)
  assert.equal(out[0].type, 'text/csv')
  assert.equal(out[0].name, 'report.csv')
  // a bare-string attachment (an agent's own wt-room --attach shape) still works, just with no name.
})

test('roomAttachments: an agent can attach a .md/.txt file under its cwd/tmp (copied, name kept); non-text is refused', async () => {
  const md = join(agentDir, 'notes.md')
  writeFileSync(md, '# hi\nplain *markdown*')
  const out = await roomAttachments({ kind: 'agent', key: 'x' }, { attach: [md] })
  assert.equal(out.length, 1)
  assert.equal(out[0].name, 'notes.md')
  assert.match(out[0].path, /\.md$/)
  assert.notEqual(out[0].path, md)
  for (const [n, body] of [['bad.html', '<script>1</script>'], ['bad.svg', '<svg/>'], ['bad.zip', 'PK']]) {
    const f = join(agentDir, n); writeFileSync(f, body)
    await assert.rejects(roomAttachments({ kind: 'agent', key: 'x' }, { attach: [f] }), /unsupported file type or too large/)
  }
})

test('roomAttachments: an agent text attachment is refused when binary, invalid UTF-8 or over 1MB', async () => {
  const bin = join(agentDir, 'bin.md'); writeFileSync(bin, Buffer.from([0x23, 0x00, 0x41]))
  await assert.rejects(roomAttachments({ kind: 'agent', key: 'x' }, { attach: [bin] }), /does not match its type/)
  const bad = join(agentDir, 'bad.txt'); writeFileSync(bad, Buffer.from([0xff, 0xfe, 0x41]))
  await assert.rejects(roomAttachments({ kind: 'agent', key: 'x' }, { attach: [bad] }), /does not match its type/)
  const big = join(agentDir, 'big.md'); writeFileSync(big, 'a'.repeat(1024 * 1024 + 1))
  await assert.rejects(roomAttachments({ kind: 'agent', key: 'x' }, { attach: [big] }), /unsupported file type or too large/)
})

test('roomAttachments: only a file already inside UPLOADS is attachable for a user (no arbitrary path)', async () => {
  const outside = join(tmp, 'outside.txt')
  writeFileSync(outside, 'x')
  await assert.rejects(roomAttachments({ kind: 'user' }, { attachments: [{ path: outside, name: 'outside.txt' }] }), /attach uploaded files only/)
})
