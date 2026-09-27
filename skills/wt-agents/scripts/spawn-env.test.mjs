// Run: node --test skills/wt-agents/scripts/spawn-env.test.mjs — WP-107: a project's GitHub account reaches the
// spawned pane as GH_TOKEN (herdr tab create --env), and gh's global active account is never switched.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const here = import.meta.dirname
const tmp = mkdtempSync(join(tmpdir(), 'wt-spawn-env-'))
const bin = join(tmp, 'bin'), log = join(tmp, 'calls.log'), repo = join(tmp, 'demo')
mkdirSync(bin); mkdirSync(repo); mkdirSync(join(tmp, 'data'))
const stub = (name, body) => { writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> ${log}\n${body}\n`); chmodSync(join(bin, name), 0o755) }
stub('herdr', `case "$1 $2" in
  "workspace list") echo '{"result":{"workspaces":[{"label":"demo-workers","workspace_id":"w1"}]}}' ;;
  "agent list") echo '{"result":{"agents":[]}}' ;;
  "tab create") echo '{"result":{"root_pane":{"pane_id":"w1:p9"}}}' ;;
esac`)
stub('gh', `[ "$1 $2 $3 $4" = "auth token --user rephol" ] && { echo tok123; exit 0; }; exit 1`)
execFileSync('git', ['-C', repo, 'init', '-q'])
const db = new DatabaseSync(join(tmp, 'data', 'wt.db'))
db.exec('CREATE TABLE project_settings (project TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (project, key))')
const setAccount = (a) => { db.exec('DELETE FROM project_settings'); if (a) db.prepare("INSERT INTO project_settings VALUES ('demo', 'githubAccount', ?)").run(a) }

const spawn = () => {
  rmSync(log, { force: true })
  const r = execFileSync(join(here, 'agents.sh'), ['spawn', 'worker'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: tmp, XDG_CACHE_HOME: tmp, WT_DASHBOARD_DATA: tmp, WT_DASHBOARD_ENV: join(tmp, 'env') } })
  const calls = readFileSync(log, 'utf8').split('\n')
  return { out: r, tab: calls.find((l) => l.startsWith('herdr tab create')), calls, cred: (() => { try { return execFileSync('git', ['-C', repo, 'config', 'credential.https://github.com.username'], { encoding: 'utf8' }).trim() } catch { return '' } })() }
}

test('account set: tab create gets --env GH_TOKEN, git push uses the account, gh auth switch never runs', () => {
  setAccount('rephol')
  const s = spawn()
  assert.match(s.out, /^demo-worker-01 w1:p9/)
  assert.match(s.tab, /--env GH_TOKEN=tok123/)
  assert.equal(s.cred, 'rephol')
  assert.ok(!s.calls.some((l) => /^gh auth switch/.test(l)))
})

test('no account: no --env, gh not asked; unknown account: warns, spawns without a token', () => {
  execFileSync('git', ['-C', repo, 'config', '--unset', 'credential.https://github.com.username'])
  setAccount(null)
  let s = spawn()
  assert.doesNotMatch(s.tab, /--env/)
  assert.ok(!s.calls.some((l) => l.startsWith('gh ')))
  setAccount('nobody')
  s = spawn()
  assert.doesNotMatch(s.tab, /--env/)
  assert.equal(s.cred, '')
  assert.ok(!s.calls.some((l) => /^gh auth switch/.test(l)))
  assert.ok(existsSync(join(tmp, '.claude.json')))
})
