// WP-189: setup's plugin_current compares the installed plugin by content (paths that ship), not by git sha.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const setup = readFileSync(join(import.meta.dirname, '../../../setup'), 'utf8')
const fns = ['checkout_commit() {', 'plugin_current() {'].map((h) => {
  const from = setup.indexOf(h), end = h.startsWith('plugin') ? setup.indexOf('\n}\n', from) + 3 : setup.indexOf('\n', from) + 1
  return setup.slice(from, end)
}).join('\n')

const dir = mkdtempSync(join(tmpdir(), 'wt-setup-cur-'))
const g = (...a) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' }).trim()
const commit = (file, msg) => { mkdirSync(join(dir, file, '..'), { recursive: true }); writeFileSync(join(dir, file), msg); g('add', file); g('commit', '-qm', msg); return g('rev-parse', 'HEAD') }
const current = (iv) => spawnSync('bash', ['-c', `${fns}\nplugin_current "$1" "$2" skills/wt-memory`, 'x', iv, dir]).status === 0

test('plugin_current: current at HEAD or after unrelated commits; stale after a shipped-path commit or unknown sha', () => {
  g('init', '-q'); const base = commit('skills/wt-memory/a.txt', 'a')
  assert.ok(current(base), 'installed == HEAD')
  assert.ok(current(base.slice(0, 12)), 'short sha at HEAD')
  commit('skills/wt-watch-prs/b.txt', 'unrelated'); commit('docs/c.md', 'docs')
  assert.ok(current(base.slice(0, 12)), 'commits outside the plugin do not make it stale')
  commit('skills/wt-memory/a.txt', 'changed')
  assert.ok(!current(base.slice(0, 12)), 'a commit under the plugin path does')
  assert.ok(!current('deadbeefdead'), 'a commit this clone does not have')
  assert.ok(!current(''), 'no installed version')
})

test.after(() => rmSync(dir, { recursive: true, force: true }))
