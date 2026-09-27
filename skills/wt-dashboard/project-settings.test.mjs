// Run: node --test project-settings.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { MIGRATIONS, open } from './store.mjs'
import { ProjectSettings } from './project-settings.mjs'
import { Config } from './config.mjs'

const tmp = () => mkdtemp(join(tmpdir(), 'pset-'))
const cfgOf = (env = {}, fileVals = {}) => {
  const c = new Config({ file: '/nonexistent/env', env, platform: 'linux' })
  c.fileVals = fileVals
  return c
}

test('project beats global beats default; reset falls back', async () => {
  const dir = await tmp()
  const ps = new ProjectSettings({ dir, cfg: cfgOf({}, { WT_AGENTS_MCP: 'lean' }) })
  assert.deepEqual(ps.resolve('p', 'baseBranch'), { value: 'main', source: 'default' })
  assert.deepEqual(ps.resolve('p', 'WT_AGENTS_MCP'), { value: 'lean', source: 'global' })
  assert.deepEqual(ps.resolve('p', 'maxWorking'), { value: '4', source: 'default' })
  ps.db.prepare("INSERT INTO routine_settings (k, v) VALUES ('maxWorking', '6')").run()
  assert.deepEqual(ps.resolve('p', 'maxWorking'), { value: '6', source: 'global' })
  assert.deepEqual(ps.set('p', 'maxWorking', 2), { value: '2', source: 'project' })
  assert.deepEqual(ps.set('p', 'WT_AGENTS_MCP', 'full'), { value: 'full', source: 'project' })
  assert.equal(ps.get('q', 'maxWorking'), '6') // other projects keep the global
  assert.deepEqual(ps.reset('p', 'maxWorking'), { value: '6', source: 'global' })
  ps.set('p', 'githubAccount', 'rephol')
  const row = ps.list('p').find((r) => r.key === 'githubAccount')
  assert.equal(row.value, 'rephol')
  assert.deepEqual(row.inherited, { value: null, source: 'default' })
})

test('a process env var wins over the project value', async () => {
  const ps = new ProjectSettings({ dir: await tmp(), cfg: cfgOf({ WT_AGENTS_MCP: 'lean' }) })
  ps.set('p', 'WT_AGENTS_MCP', 'full')
  assert.deepEqual(ps.resolve('p', 'WT_AGENTS_MCP'), { value: 'lean', source: 'env' })
})

test('invalid values are rejected', async () => {
  const ps = new ProjectSettings({ dir: await tmp(), cfg: cfgOf() })
  for (const [k, v] of [['githubAccount', 'a b'], ['githubAccount', 'x'.repeat(40)], ['baseBranch', 'a..b'], ['baseBranch', '-x'],
    ['WT_AGENTS_MCP', 'mid'], ['maxWorking', '101'], ['maxWorking', '-1'], ['nope', 'x'], ['baseBranch', '']])
    assert.throws(() => ps.set('p', k, v), (e) => e.status >= 400, `${k}=${v}`)
  assert.throws(() => ps.set('../x', 'baseBranch', 'main'), /bad project/)
  assert.equal(ps.set('p', 'baseBranch', 'develop').value, 'develop')
})

test('stage 8 creates project_settings on an existing v7 DB, other rows kept', async () => {
  const f = join(await tmp(), 'wt.db')
  const db = new DatabaseSync(f)
  MIGRATIONS.slice(0, 7).forEach((m) => db.exec(m.sql))
  db.exec("PRAGMA user_version = 7; INSERT INTO boards (project, key, next) VALUES ('wt-pack', 'WP', 9); INSERT INTO routine_settings (k, v) VALUES ('maxWorking', '3')")
  db.close()
  const up = open(f)
  assert.equal(up.prepare('PRAGMA user_version').get().user_version, 8)
  assert.equal(up.prepare('SELECT next FROM boards').get().next, 9)
  assert.equal(up.prepare('SELECT v FROM routine_settings').get().v, '3')
  assert.equal(up.prepare('SELECT count(*) n FROM project_settings').get().n, 0)
})
