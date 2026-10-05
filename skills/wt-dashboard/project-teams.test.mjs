import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, symlinkSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTeam, deleteTeam, updateTeam } from './project-teams.mjs'

const repo = () => { const d = mkdtempSync(join(tmpdir(), 'wp241-')); execFileSync('git', ['init', '-q', d]); mkdirSync(join(d, '.wt-pack')); return d }

test('WP-241: create from a template, edit keeps the notes, delete removes the file', () => {
  const r = repo(), f = join(r, '.wt-pack', 'teams', 'web.md')
  assert.deepEqual(createTeam(r, 'web', { template: 'standard' }), [])
  assert.match(readFileSync(f, 'utf8'), /members: \[planner, worker x2, reviewer\]/)
  assert.throws(() => createTeam(r, 'web', { template: 'solo' }), (e) => e.status === 409)
  writeFileSync(f, readFileSync(f, 'utf8') + 'my notes\n')
  assert.deepEqual(updateTeam(r, 'web', { description: 'd', members: [{ persona: 'worker', count: 3 }], stages: [{ stage: 'build', persona: 'worker' }] }), [])
  assert.match(readFileSync(f, 'utf8'), /members: \[worker x3\][\s\S]*my notes/)
  assert.ok(updateTeam(r, 'web', { members: [{ persona: 'worker', count: 1 }], stages: [{ stage: 'review', persona: 'reviewer' }] })[0].includes('not a member'))
  deleteTeam(r, 'web'); assert.ok(!existsSync(f))
  assert.throws(() => deleteTeam(r, 'web'), (e) => e.status === 404)
})

test('WP-241: bad names, injected frontmatter and symlinks are refused', () => {
  const r = repo()
  for (const n of ['../x', 'A', 'a/b', '']) assert.throws(() => createTeam(r, n, { template: 'solo' }), (e) => e.status === 400)
  assert.throws(() => createTeam(r, 'x', { description: 'a\nmembers: [evil]', members: [], stages: [] }), (e) => e.status === 400)
  assert.throws(() => createTeam(r, 'x', { members: [{ persona: 'w]\nx', count: 1 }], stages: [] }), (e) => e.status === 400)
  assert.throws(() => createTeam(r, 'x', { template: 'nope' }), (e) => e.status === 400)
  const out = mkdtempSync(join(tmpdir(), 'wp241-out-'))
  mkdirSync(join(r, '.wt-pack', 'teams'), { recursive: true }); symlinkSync(join(out, 'x.md'), join(r, '.wt-pack', 'teams', 'x.md'))
  assert.throws(() => createTeam(r, 'x', { template: 'solo' }), (e) => /symlink|exists/.test(e.message))
  assert.ok(!existsSync(join(out, 'x.md')))
})
