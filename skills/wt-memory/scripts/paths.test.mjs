// Run: node --test skills/wt-memory/scripts/paths.test.mjs — WP-122 sibling-skill paths for the hooks.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { skillPath } from '../claude-plugin/hooks/paths.mjs'

test('skillPath: sibling skill when present (root plugin / checkout), else the ./setup link', () => {
  const root = mkdtempSync(join(tmpdir(), 'wt-paths-'))
  const hooks = join(root, 'skills', 'wt-memory', 'claude-plugin', 'hooks')
  mkdirSync(hooks, { recursive: true }); mkdirSync(join(root, 'skills', 'wt-room', 'scripts'), { recursive: true })
  writeFileSync(join(root, 'skills', 'wt-room', 'scripts', 'room'), '')
  const from = pathToFileURL(join(hooks, 'inject.mjs')).href
  assert.equal(skillPath('wt-room/scripts/room', from), join(root, 'skills', 'wt-room', 'scripts', 'room'))
  assert.equal(skillPath('wt-handoff/scripts/handoff.sh', from), join(homedir(), '.claude', 'skills', 'wt-handoff', 'scripts', 'handoff.sh'))
  // this checkout: the real sibling
  assert.match(skillPath('wt-room/scripts/room'), /skills\/wt-room\/scripts\/room$/)
  assert.doesNotMatch(skillPath('wt-room/scripts/room'), /\.claude\/skills/)
})
