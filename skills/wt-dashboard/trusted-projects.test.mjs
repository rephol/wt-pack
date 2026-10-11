// node --test: WP-334 the trustRepoRoles mirror (trusted-projects.json) and its one-time grandfathering.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectSettings } from './project-settings.mjs'
import { grandfather, syncTrusted } from './trusted-projects.mjs'

const cfgOf = () => ({ source: () => 'default', get: () => null, override: () => null })
const fixture = () => {
  const dataRoot = realpathSync(mkdtempSync(join(tmpdir(), 'trust-')))
  mkdirSync(join(dataRoot, 'data'))
  const mk = (name, roles) => { const r = join(dataRoot, name); mkdirSync(join(r, '.wt-pack', 'roles'), { recursive: true }); if (roles) writeFileSync(join(r, '.wt-pack', 'roles', 'worker.md'), 'x'); execFileSync('git', ['init', '-q', r]); return r }
  return { dataRoot, mk, ps: new ProjectSettings({ dir: join(dataRoot, 'data'), cfg: cfgOf() }), file: join(dataRoot, 'trusted-projects.json') }
}

test('toggling writes the mirror (realpath, 0600); off removes it; an unknown checkout keeps its old entry', () => {
  const { dataRoot, mk, ps, file } = fixture()
  const a = mk('a', true)
  assert.equal(ps.get('a', 'trustRepoRoles'), 'off')
  ps.set('a', 'trustRepoRoles', 'on')
  syncTrusted({ dataRoot, db: ps.db, roots: new Map([['a', a]]) })
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { a })
  assert.equal(statSync(file).mode & 0o777, 0o600)
  syncTrusted({ dataRoot, db: ps.db, roots: new Map() }) // checkout not derivable right now
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { a })
  ps.set('a', 'trustRepoRoles', 'off')
  syncTrusted({ dataRoot, db: ps.db, roots: new Map([['a', a]]) })
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {})
  assert.throws(() => ps.set('a', 'trustRepoRoles', 'maybe'), /one of/)
})

test('grandfather: trusts a project with role files and wt-pack, not an empty one; runs once; never overwrites a choice', () => {
  const { dataRoot, mk, ps } = fixture()
  const roots = new Map([['with', mk('with', true)], ['without', mk('without', false)], ['wt-pack', mk('wt-pack', false)], ['chosen', mk('chosen', true)]])
  ps.set('chosen', 'trustRepoRoles', 'off')
  const log = () => {}
  assert.deepEqual(grandfather({ dataRoot, psettings: ps, roots, log }).sort(), ['with', 'wt-pack'])
  assert.equal(ps.get('without', 'trustRepoRoles'), 'off')
  assert.equal(ps.get('chosen', 'trustRepoRoles'), 'off')
  assert.ok(existsSync(join(dataRoot, 'trust-grandfathered')))
  ps.set('with', 'trustRepoRoles', 'off') // the user untrusts; a restart must not re-trust
  assert.deepEqual(grandfather({ dataRoot, psettings: ps, roots, log }), [])
  assert.equal(ps.get('with', 'trustRepoRoles'), 'off')
})
