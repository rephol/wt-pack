// node --test: WP-234 user-level settings (~/.config/wt-pack/projects/<repo>/) as an alternative to <repo>/.wt-pack/.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { list, moveSettings, rolesDir, settingsRoot, settingsWhere, userRoot } from './roles.mjs'

const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'roles-user-')))
process.env.WT_PACK_USER_DIR = join(tmp, 'user')
const repo = join(tmp, 'acme')
execFileSync('git', ['init', '-q', repo])
const put = (root, n, t) => { mkdirSync(join(root, 'roles'), { recursive: true }); writeFileSync(join(root, 'roles', `${n}.md`), t) }

test('no folder anywhere: the repo is the default; a user folder alone is read; the repo folder wins when both exist', () => {
  assert.equal(settingsWhere(repo), 'repo')
  put(userRoot(repo), 'worker', 'from user')
  assert.equal(settingsWhere(repo), 'user')
  assert.deepEqual(list(repo).map((r) => r.body), ['from user'])
  put(join(repo, '.wt-pack'), 'worker', 'from repo')
  assert.equal(settingsWhere(repo), 'repo')
  assert.deepEqual(list(repo).map((r) => r.body), ['from repo'])
})

test('moveSettings: repo → user → repo carries the files and model-routing.json; a clash refuses and loses nothing', () => {
  const r2 = join(tmp, 'beta')
  execFileSync('git', ['init', '-q', r2])
  put(join(r2, '.wt-pack'), 'worker', 'W')
  writeFileSync(join(r2, '.wt-pack', 'model-routing.json'), '{"mode":"live"}')
  assert.deepEqual(moveSettings(r2, 'user').sort(), ['model-routing.json', 'roles/worker.md'])
  assert.ok(!existsSync(join(r2, '.wt-pack')))
  assert.equal(settingsWhere(r2), 'user')
  assert.equal(readFileSync(join(settingsRoot(r2), 'model-routing.json'), 'utf8'), '{"mode":"live"}')
  assert.equal(readFileSync(join(rolesDir(r2), 'worker.md'), 'utf8'), 'W')
  put(join(r2, '.wt-pack'), 'worker', 'other') // both exist now
  assert.throws(() => moveSettings(r2, 'repo'), /already in/)
  assert.equal(readFileSync(join(userRoot(r2), 'roles', 'worker.md'), 'utf8'), 'W')
})
