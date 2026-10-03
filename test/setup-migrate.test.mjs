// Run: node --test test/setup-migrate.test.mjs — WP-213: `./setup plugin` migrates to the one wt-pack plugin and
// `./setup plugin-check` verifies it, against a stubbed `claude` and a throwaway HOME (nothing real is touched).
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = join(import.meta.dirname, '..')
const SETUP = join(REPO, 'setup')

function rig(listed) {
  const home = mkdtempSync(join(tmpdir(), 'setup-migrate-'))
  const bin = join(home, 'bin'); mkdirSync(bin)
  const log = join(home, 'claude.log')
  writeFileSync(join(bin, 'claude'), `#!/bin/sh
echo "$*" >> "${log}"
[ "$1 $2 $3" = "plugin list --json" ] && cat "${home}/list.json"
exit 0
`)
  chmodSync(join(bin, 'claude'), 0o755)
  const setList = (ids) => writeFileSync(join(home, 'list.json'), JSON.stringify(ids.map((id) => ({ id, enabled: true }))))
  setList(listed)
  const skills = join(home, '.claude', 'skills'); mkdirSync(skills, { recursive: true })
  const run = (cmd) => { try { return execFileSync('sh', [SETUP, cmd], { encoding: 'utf8', env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` } }) } catch (e) { return String(e.stdout) } }
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [])
  return { home, skills, setList, run, calls, settings: () => JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8')) }
}

test('plugin: uninstalls the old plugins, adds the checkout to CLAUDE_CODE_PLUGIN_DIRS, removes skill links but wt-dashboard', () => {
  const r = rig(['wt-memory@wt-pack', 'wt-deliver-mod@wt-pack', 'wt-ask-mod@wt-pack', 'wt-pack@wt-pack', 'other@market'])
  symlinkSync(join(REPO, 'skills', 'wt-plan'), join(r.skills, 'wt-plan'))
  symlinkSync(join(REPO, 'skills', 'wt-dashboard'), join(r.skills, 'wt-dashboard'))
  writeFileSync(join(r.home, '.claude', 'settings.json'), JSON.stringify({ model: 'opus', env: { CLAUDE_CODE_PLUGIN_DIRS: '/somewhere/else' } }))
  r.run('plugin')
  const un = r.calls().filter((c) => c.startsWith('plugin uninstall')).map((c) => c.split(' ')[2]).sort()
  assert.deepEqual(un, ['wt-ask-mod@wt-pack', 'wt-deliver-mod@wt-pack', 'wt-memory@wt-pack', 'wt-pack@wt-pack'])
  assert.equal(r.settings().env.CLAUDE_CODE_PLUGIN_DIRS, `/somewhere/else:${REPO}`)
  assert.equal(r.settings().model, 'opus')
  assert.equal(existsSync(join(r.skills, 'wt-plan')), false)
  assert.equal(existsSync(join(r.skills, 'wt-dashboard')), true) // the desktop app launches it
})

test('plugin is idempotent: a second run uninstalls nothing and changes nothing', () => {
  const r = rig([])
  r.run('plugin')
  const first = JSON.stringify(r.settings())
  const out = r.run('plugin')
  assert.equal(JSON.stringify(r.settings()), first)
  assert.deepEqual(r.calls().filter((c) => c.startsWith('plugin uninstall')), [])
  assert.match(out, /already/)
})

test('plugin keeps another wt-pack checkout\'s plugin dir and skill links', () => {
  const r = rig(['wt-memory@wt-pack', 'wt-pack@wt-pack'])
  const other = join(r.home, 'other-pack')
  mkdirSync(join(other, '.claude-plugin'), { recursive: true }); mkdirSync(join(other, 'skills', 'wt-agents'), { recursive: true })
  writeFileSync(join(other, '.claude-plugin', 'marketplace.json'), '{ "name": "wt-pack" }')
  symlinkSync(join(other, 'skills', 'wt-agents'), join(r.skills, 'wt-agents'))
  writeFileSync(join(r.home, '.claude', 'settings.json'), JSON.stringify({ env: { CLAUDE_CODE_PLUGIN_DIRS: other } }))
  const out = r.run('plugin')
  assert.equal(r.settings().env.CLAUDE_CODE_PLUGIN_DIRS, other)
  assert.equal(existsSync(join(r.skills, 'wt-agents')), true)
  assert.match(out, /another wt-pack checkout/)
  assert.deepEqual(r.calls().filter((c) => c.startsWith('plugin uninstall')), []) // the live install is not touched
})

test('plugin-check: exactly one wt-pack plugin and none of the old four is clean; extras or none are failures', () => {
  const r = rig(['wt-pack@inline', 'other@market'])
  assert.match(r.run('plugin-check'), /✓ one wt-pack plugin: wt-pack@inline/)
  r.setList(['wt-pack@inline', 'wt-memory@wt-pack', 'wt-mods@skills-dir'])
  assert.match(r.run('plugin-check'), /✗ older plugins still loaded: wt-memory@wt-pack wt-mods@skills-dir/)
  r.setList(['wt-pack@inline', 'wt-pack@wt-pack'])
  assert.match(r.run('plugin-check'), /✗ 2 wt-pack plugins loaded/)
  r.setList([])
  assert.match(r.run('plugin-check'), /✗ no wt-pack plugin loaded/)
})

test('uninstall: removes this checkout\'s plugin dir and plugins, and leaves another checkout\'s alone', () => {
  const r = rig(['wt-memory@wt-pack', 'wt-pack@wt-pack'])
  writeFileSync(join(r.home, '.claude', 'settings.json'), JSON.stringify({ env: { CLAUDE_CODE_PLUGIN_DIRS: `/other:${REPO}` } }))
  r.run('uninstall')
  assert.equal(r.settings().env.CLAUDE_CODE_PLUGIN_DIRS, '/other')
  assert.deepEqual(r.calls().filter((c) => c.startsWith('plugin uninstall')).map((c) => c.split(' ')[2]).sort(), ['wt-memory@wt-pack', 'wt-pack@wt-pack'])
  const o = rig(['wt-memory@wt-pack'])
  writeFileSync(join(o.home, '.claude', 'settings.json'), JSON.stringify({ env: { CLAUDE_CODE_PLUGIN_DIRS: '/other' } }))
  o.run('uninstall')
  assert.equal(o.settings().env.CLAUDE_CODE_PLUGIN_DIRS, '/other')
  assert.deepEqual(o.calls().filter((c) => c.startsWith('plugin uninstall')), [])
})

test('plugin-check: an unreadable plugin list is reported as such, not as "no plugin"', () => {
  const r = rig([])
  writeFileSync(join(r.home, 'list.json'), 'not json')
  assert.match(r.run('plugin-check'), /could not read the plugin list/)
})
