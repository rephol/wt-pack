// Run: node --test skills/wt-dashboard/uploads.test.mjs — WP-170 upload/room-attachment type + security checks.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'

const tmp = mkdtempSync(join(tmpdir(), 'wt-uploads-'))
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

test('roomAttachments: an agent room --attach stays images-only, unchanged (a text file is refused)', async () => {
  const [, up] = await saveUpload(fakeReq({ 'x-filename': encodeURIComponent('notes2.txt') }, 'hi'))
  await assert.rejects(roomAttachments({ kind: 'agent', key: 'x' }, { attach: [up.path] }), /unsupported file type or too large/)
})

test('roomAttachments: only a file already inside UPLOADS is attachable for a user (no arbitrary path)', async () => {
  const outside = join(tmp, 'outside.txt')
  writeFileSync(outside, 'x')
  await assert.rejects(roomAttachments({ kind: 'user' }, { attachments: [{ path: outside, name: 'outside.txt' }] }), /attach uploaded files only/)
})
