import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, symlinkSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validName, validCloneUrl, underHome } from './projectPaths.mjs'

test('validName', () => {
  for (const ok of ['qa-proj', 'a', 'app_2', '0x']) assert.ok(validName(ok), ok)
  for (const bad of ['QA', 'Foo', '-x', '', 'a b', 'a/b', '..', 'x'.repeat(33), null]) assert.ok(!validName(bad), String(bad))
})
test('validCloneUrl', () => {
  for (const ok of ['https://github.com/a/b.git', 'git@github.com:a/b.git', 'ssh://git@host/a/b']) assert.ok(validCloneUrl(ok), ok)
  for (const bad of ['file:///x', 'ext::sh -c id', '-uevil', 'http://h/a', 'https://h/a b', '/local/path', 'https://h', '', 'ftp://h/a']) assert.ok(!validCloneUrl(bad), bad)
})
test('underHome', () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'wt-home-')))
  const out = realpathSync(mkdtempSync(join(tmpdir(), 'wt-out-')))
  mkdirSync(join(home, 'code'))
  symlinkSync(out, join(home, 'link'))
  assert.ok(underHome(join(home, 'code', 'new'), home))
  assert.ok(!underHome(home, home))
  assert.ok(!underHome(join(home, '..', 'etc'), home))
  assert.ok(!underHome(join(home, 'link', 'x'), home))
  assert.ok(!underHome(join(home + '-evil', 'x'), home))
  assert.ok(!underHome('rel/path', home))
  assert.ok(!underHome(join(home, 'a\0b'), home))
})
