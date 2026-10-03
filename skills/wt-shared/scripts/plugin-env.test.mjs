// Run: node --test plugin-env.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { edit, entries } from './plugin-env.mjs'

const BIN = join(import.meta.dirname, 'plugin-env.mjs')
const run = (...a) => execFileSync(process.execPath, [BIN, ...a], { encoding: 'utf8' })
const tmp = () => join(mkdtempSync(join(tmpdir(), 'plugin-env-')), 'settings.json')

test('add is idempotent and keeps other entries and settings', () => {
  const s = { model: 'opus', env: { A: '1', CLAUDE_CODE_PLUGIN_DIRS: '/x:/y' } }
  const a = edit(s, 'add', '/repo')
  assert.deepEqual(entries(a), ['/x', '/y', '/repo'])
  assert.deepEqual(edit(a, 'add', '/repo'), a)
  assert.equal(a.model, 'opus')
  assert.equal(a.env.A, '1')
})

test('remove drops one entry; an emptied variable (and env) disappears', () => {
  assert.deepEqual(entries(edit({ env: { CLAUDE_CODE_PLUGIN_DIRS: '/x:/repo' } }, 'remove', '/repo')), ['/x'])
  assert.deepEqual(edit({ env: { CLAUDE_CODE_PLUGIN_DIRS: '/repo' } }, 'remove', '/repo'), {})
  assert.deepEqual(edit({ env: { B: '2', CLAUDE_CODE_PLUGIN_DIRS: '/repo' } }, 'remove', '/repo'), { env: { B: '2' } })
})

test('CLI: creates a missing settings file, lists, removes; refuses a non-JSON file untouched', () => {
  const p = tmp()
  run('add', p, '/repo')
  assert.equal(run('list', p), '/repo\n')
  assert.equal(JSON.parse(readFileSync(p, 'utf8')).env.CLAUDE_CODE_PLUGIN_DIRS, '/repo')
  run('remove', p, '/repo')
  assert.equal(run('list', p), '')
  writeFileSync(p, '{ not json')
  assert.throws(() => run('add', p, '/repo'), (e) => e.status === 1)
  assert.equal(readFileSync(p, 'utf8'), '{ not json')
})
