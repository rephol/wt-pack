// node --test: WP-334 repo role files load only for a trusted project; the user folder always does.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'roles-trust-')))
process.env.WT_PACK_USER_DIR = join(tmp, 'user')
process.env.WT_TRUSTED_PROJECTS = join(tmp, 'trusted.json')
const { resolve, list, sections, untrustedNotice } = await import('./roles.mjs')
const mk = (dir) => { const r = join(tmp, dir, 'acme'); mkdirSync(r, { recursive: true }); execFileSync('git', ['init', '-q', r]); return r }
const put = (root, n, t) => { mkdirSync(join(root, 'roles'), { recursive: true }); writeFileSync(join(root, 'roles', `${n}.md`), t) }

const repo = mk('a')
put(join(repo, '.wt-pack'), 'worker', 'from repo')

test('missing trust file: repo roles do not load, the notice says so', () => {
  assert.equal(resolve(repo, 'worker'), null)
  assert.deepEqual(list(repo), [])
  assert.deepEqual(sections(repo, 'worker'), [])
  assert.match(untrustedNotice(repo), /not trusted; base roles apply\. Trust it in wt-dashboard Settings › acme\.$/)
})

test('a user-folder role still loads for an untrusted repo with a repo folder', () => {
  put(join(tmp, 'user', 'acme'), 'worker', 'from user')
  assert.deepEqual(list(repo).map((r) => r.body), ['from user'])
  assert.match(sections(repo, 'worker')[0][0], /user-level/)
})

test('a same-basename clone at another path is not trusted; the trusted path is', () => {
  const other = mk('b')
  put(join(other, '.wt-pack'), 'worker', 'other')
  writeFileSync(process.env.WT_TRUSTED_PROJECTS, JSON.stringify({ acme: repo }))
  assert.deepEqual(list(other).map((r) => r.body), ['from user']) // only the user folder (keyed by dir name) reads
  assert.notEqual(untrustedNotice(other), '')
  assert.equal(resolve(repo, 'worker').base, 'worker')
  assert.equal(untrustedNotice(repo), '')
})

test('malformed trust JSON means untrusted', () => {
  writeFileSync(process.env.WT_TRUSTED_PROJECTS, '{nope')
  assert.deepEqual(list(repo).map((r) => r.body), ['from user'])
})
