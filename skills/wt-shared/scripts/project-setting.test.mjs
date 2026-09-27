// Run: node --test skills/wt-shared/scripts/project-setting.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const cli = join(import.meta.dirname, 'project-setting.mjs')
const root = mkdtempSync(join(tmpdir(), 'pset-cli-'))
const run = (args, cwd = root) => execFileSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', env: { ...process.env, WT_DASHBOARD_DATA: root } })

test('no DB: prints nothing, exits 0', () => {
  assert.equal(run(['get', 'githubAccount', '--project', 'x']), '')
  assert.equal(run(['list-accounts']), '')
})

test('get by project and by cwd (main checkout and a worktree); list-accounts', () => {
  mkdirSync(join(root, 'data'))
  const db = new DatabaseSync(join(root, 'data', 'wt.db'))
  db.exec(`CREATE TABLE project_settings (project TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (project, key));
    INSERT INTO project_settings VALUES ('demo', 'githubAccount', 'rephol'), ('demo', 'WT_AGENTS_MCP', 'lean'), ('other', 'githubAccount', 'octe')`)
  db.close()
  const repo = join(root, 'demo')
  mkdirSync(repo)
  const git = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'ignore' })
  git('init', '-q'); git('-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-q', '--allow-empty', '-m', 'x')
  git('worktree', 'add', '-q', join(root, 'wt-x'))
  assert.equal(run(['get', 'githubAccount', '--project', 'demo']), 'rephol\n')
  assert.equal(run(['get', 'WT_AGENTS_MCP', '--cwd', repo]), 'lean\n')
  assert.equal(run(['get', 'githubAccount'], join(root, 'wt-x')), 'rephol\n')
  assert.equal(run(['get', 'baseBranch', '--project', 'demo']), '')
  assert.equal(run(['get', 'githubAccount', '--cwd', tmpdir()]), '')
  assert.equal(run(['list-accounts']), 'demo\trephol\nother\tocte\n')
})
