// node --test: wt-roles new/list/check against a temp repo.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, realpathSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BIN = new URL('./wt-roles', import.meta.url).pathname
const repo = realpathSync(mkdtempSync(join(tmpdir(), 'wt-roles-')))
execFileSync('git', ['init', '-q', repo])
const run = (...a) => { try { return { out: execFileSync(BIN, [...a, '--cwd', repo], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), code: 0 } } catch (e) { return { out: e.stdout + e.stderr, code: e.status } } }
const f = (n) => join(repo, '.wt-pack', 'roles', `${n}.md`)

test('new: persona from the template, override from a default, refuses clobber and bad input', () => {
  assert.equal(run('new', 'frontend-worker', '--base', 'worker').code, 0)
  assert.match(readFileSync(f('frontend-worker'), 'utf8'), /^---\nbase: worker\n/)
  assert.equal(run('new', 'worker', '--from-default').code, 0)
  assert.doesNotMatch(readFileSync(f('worker'), 'utf8'), /^---/)
  assert.equal(run('new', 'worker').code, 1)
  assert.equal(run('new', 'qa').code, 2) // persona without --base
  assert.equal(run('new', '../x', '--base', 'worker').code, 2)
  assert.ok(!existsSync(join(repo, '.wt-pack', 'x.md')))
})

test('check ok for the fresh files; errors exit 1; list shows kind and status', () => {
  assert.match(run('check').out, /^ok$|warn/m)
  assert.equal(run('check').code, 0)
  writeFileSync(f('frontend-worker'), '---\nbase: worker\nmcp: [nope]\n---\nx')
  const c = run('check')
  assert.equal(c.code, 1)
  assert.match(c.out, /unknown MCP server `nope`/)
  const l = run('list').out
  assert.match(l, /frontend-worker\s+persona\s+base=worker\s+\d+ B\s+ERROR/)
  assert.match(l, /^worker\s+override/m)
})

test('new --user writes to the user folder (WP-234); refused while the repo has a .wt-pack/ folder', () => {
  const r2 = realpathSync(mkdtempSync(join(tmpdir(), 'wt-roles-u-')))
  execFileSync('git', ['init', '-q', r2])
  const user = realpathSync(mkdtempSync(join(tmpdir(), 'wt-roles-home-')))
  const go = (...a) => { try { return { out: execFileSync(BIN, [...a, '--cwd', r2], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WT_PACK_USER_DIR: user } }), code: 0 } } catch (e) { return { out: e.stdout + e.stderr, code: e.status } } }
  assert.equal(go('new', 'worker', '--user', '--from-default').code, 0)
  assert.ok(existsSync(join(user, r2.split('/').pop(), 'roles', 'worker.md')))
  assert.ok(!existsSync(join(r2, '.wt-pack')))
  assert.match(go('list').out, /worker\s+override/) // read back from the user folder
  execFileSync('mkdir', ['-p', join(r2, '.wt-pack')])
  assert.equal(go('new', 'auditor', '--user', '--from-default').code, 1)
})

test('WP-237 team: new from a template, list, check; refuses clobber, bad template and a member with no role file', () => {
  const t = (n) => join(repo, '.wt-pack', 'teams', `${n}.md`)
  assert.equal(run('team', 'new', 'pod', '--template', 'full').code, 0)
  assert.match(readFileSync(t('pod'), 'utf8'), /members: \[planner, worker x2, reviewer, auditor\]/)
  assert.equal(run('team', 'new', 'pod').code, 1)
  assert.equal(run('team', 'new', 'x', '--template', 'huge').code, 2)
  assert.match(run('team', 'list').out, /^pod\s+ok\s+planner, worker x2, reviewer, auditor/m)
  assert.equal(run('team', 'check').code, 0)
  writeFileSync(t('pod'), '---\nmembers: [ghost]\n---\n')
  const c = run('team', 'check')
  assert.equal(c.code, 1)
  assert.match(c.out, /`ghost` has no role file/)
})
