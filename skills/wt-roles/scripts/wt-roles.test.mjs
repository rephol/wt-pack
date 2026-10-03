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
