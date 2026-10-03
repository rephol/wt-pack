// Run: node --test project-roles.test.mjs — the Roles editor's API core: listing, check status, path confinement.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rolesState, writeRole } from './project-roles.mjs'

const repo = realpathSync(mkdtempSync(join(tmpdir(), 'proles-')))
execFileSync('git', ['init', '-q', repo])
const git = async (r, ...a) => execFileSync('git', ['-C', r, ...a], { encoding: 'utf8' })

test('write then list: a persona with an unknown MCP shows its finding, and git status shows the new file', async () => {
  assert.deepEqual((await rolesState(repo, git)).files, [])
  writeRole(repo, 'frontend-worker', '---\nbase: worker\nmcp: [nope]\n---\nUI.')
  const s = await rolesState(repo, git)
  assert.equal(s.files[0].kind, 'persona')
  assert.match(s.files[0].findings[0].msg, /unknown MCP/)
  assert.match(s.git, /\?\? \.wt-pack\//)
  assert.equal(readFileSync(join(repo, '.wt-pack/roles/frontend-worker.md'), 'utf8').endsWith('UI.'), true)
})

test('path confinement: traversal, slashes, uppercase, dots and oversize are 400 and write nothing', () => {
  for (const n of ['../x', '../../etc/passwd', 'a/b', 'A', '.hidden', '', 'x.md', undefined]) {
    assert.throws(() => writeRole(repo, n, 'x'), (e) => e.status === 400, String(n))
  }
  assert.throws(() => writeRole(repo, 'big', 'x'.repeat(70_000)), (e) => e.status === 400)
  assert.ok(!existsSync(join(repo, '.wt-pack', 'x.md')) && !existsSync(join(repo, 'x.md')))
})

test('a non-repo is a 404', async () => {
  await assert.rejects(rolesState(tmpdir(), git), (e) => e.status === 404)
})

test('a symlinked role file or roles dir is never written through', async () => {
  const { symlinkSync, mkdirSync: mk, writeFileSync: wf } = await import('node:fs')
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'proles-out-')))
  wf(join(outside, 'x.md'), 'orig')
  symlinkSync(join(outside, 'x.md'), join(repo, '.wt-pack/roles/linked.md'))
  assert.throws(() => writeRole(repo, 'linked', 'pwn'), (e) => e.status === 400)
  assert.equal(readFileSync(join(outside, 'x.md'), 'utf8'), 'orig')
  const repo2 = realpathSync(mkdtempSync(join(tmpdir(), 'proles2-')))
  execFileSync('git', ['init', '-q', repo2])
  mk(join(repo2, '.wt-pack'))
  symlinkSync(outside, join(repo2, '.wt-pack/roles'))
  assert.throws(() => writeRole(repo2, 'y', 'pwn'), (e) => e.status === 400)
  assert.ok(!existsSync(join(outside, 'y.md')))
})
