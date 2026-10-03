// Run: node --test skills/wt-agents/scripts/spawn-env.test.mjs — WP-107: a project's GitHub account reaches the
// spawned pane as GH_TOKEN (herdr tab create --env), and gh's global active account is never switched.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
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
  "workspace create") echo '{"result":{"workspace":{"workspace_id":"w7"}}}' ;;
esac`)
stub('gh', `[ "$1 $2 $3 $4" = "auth token --user rephol" ] && { echo tok123; exit 0; }; exit 1`)
execFileSync('git', ['-C', repo, 'init', '-q'])
const db = new DatabaseSync(join(tmp, 'data', 'wt.db'))
db.exec('CREATE TABLE project_settings (project TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (project, key))')
const setAccount = (a) => { db.exec('DELETE FROM project_settings'); if (a) db.prepare("INSERT INTO project_settings VALUES ('demo', 'githubAccount', ?)").run(a) }

const spawn = (args = ['spawn', 'worker'], extraEnv = {}) => {
  rmSync(log, { force: true })
  const r = execFileSync(join(here, 'agents.sh'), args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: tmp, XDG_CACHE_HOME: tmp, WT_DASHBOARD_DATA: tmp, WT_DASHBOARD_ENV: join(tmp, 'env'), ...extraEnv } })
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
  assert.doesNotMatch(s.tab, /GH_TOKEN/)
  assert.ok(!s.calls.some((l) => l.startsWith('gh ')))
  setAccount('nobody')
  s = spawn()
  assert.doesNotMatch(s.tab, /GH_TOKEN/)
  assert.equal(s.cred, '')
  assert.ok(!s.calls.some((l) => /^gh auth switch/.test(l)))
  assert.ok(existsSync(join(tmp, '.claude.json')))
})

test('WP-120: numbering skips a name held by an exited agent in watchdog.json; no file → 01', () => {
  const wd = join(tmp, 'data', 'watchdog.json')
  writeFileSync(wd, JSON.stringify({ lastSeen: { 'w1:p1': { name: 'demo-worker-01', goneAt: '2026-09-27T12:04:09Z' }, 'w1:p2': { name: 'demo-worker-02', goneAt: '2026-09-27T12:04:09Z' }, 'w1:p3': { name: 'demo-worker-07' } } }))
  assert.match(spawn().out, /^demo-worker-03 /)
  rmSync(wd)
  assert.match(spawn().out, /^demo-worker-01 /)
})

test('WP-120: an entry with no goneAt (not exited) does NOT reserve its number', () => {
  const wd = join(tmp, 'data', 'watchdog.json')
  // demo-worker-01 has no goneAt: if select(.goneAt) were dropped or broken, it would wrongly occupy 01
  // and the next spawn would land on 02 instead.
  writeFileSync(wd, JSON.stringify({ lastSeen: { 'w1:p1': { name: 'demo-worker-01' } } }))
  assert.match(spawn().out, /^demo-worker-01 /)
  rmSync(wd)
})

test('WP-148: numbering reuses the LOWEST free number, not max+1', () => {
  const wd = join(tmp, 'data', 'watchdog.json')
  writeFileSync(wd, JSON.stringify({ lastSeen: { 'w1:p2': { name: 'demo-worker-02', goneAt: '2026-09-27T12:04:09Z' } } }))
  // 01 is free even though 02 is occupied: lowest free wins, not one past the max seen.
  assert.match(spawn().out, /^demo-worker-01 /)
  rmSync(wd)
})

test('WP-148: agents.sh rm drops the removed name from watchdog.json lastSeen, freeing its number', () => {
  const rmTmp = mkdtempSync(join(tmpdir(), 'wt-spawn-env-rm-'))
  const rmBin = join(rmTmp, 'bin')
  mkdirSync(rmBin); mkdirSync(join(rmTmp, 'data'))
  const rmStub = (name, body) => { writeFileSync(join(rmBin, name), `#!/bin/sh\n${body}\n`); chmodSync(join(rmBin, name), 0o755) }
  rmStub('herdr', `case "$1 $2" in
  "agent list") echo '{"result":{"agents":[{"name":"demo-worker-01","pane_id":"w1:p1"}]}}' ;;
  "agent get") echo '{"result":{"agent":{"agent_status":"idle","tab_id":"t1","name":"demo-worker-01"}}}' ;;
  "tab close") echo '{}' ;;
esac`)
  const wd = join(rmTmp, 'data', 'watchdog.json')
  writeFileSync(wd, JSON.stringify({ lastSeen: {
    'w1:p1': { name: 'demo-worker-01', goneAt: '2026-09-27T12:04:09Z' },
    'w1:p2': { name: 'demo-worker-02', goneAt: '2026-09-27T12:04:09Z' },
  } }))
  execFileSync(join(here, 'agents.sh'), ['rm', 'demo-worker-01'], {
    encoding: 'utf8',
    env: { PATH: `${rmBin}:${process.env.PATH}`, HOME: rmTmp, XDG_CACHE_HOME: rmTmp, WT_DASHBOARD_DATA: rmTmp },
  })
  const after = JSON.parse(readFileSync(wd, 'utf8'))
  assert.deepEqual(Object.keys(after.lastSeen), ['w1:p2'])
  rmSync(rmTmp, { recursive: true, force: true })
})

test('WP-120: every spawn puts the kill shims first on PATH and sets CLAUDE_ENV_FILE', () => {
  const s = spawn(), shim = join(here, '..', 'bin')
  assert.match(s.tab, new RegExp(`--env PATH=${shim.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:`))
  assert.match(s.tab, /--env CLAUDE_ENV_FILE=\S+\/wt-agents\/env-demo-worker-\d+\.sh/)
  assert.match(s.tab, /--env WT_KILL_SHIM_DIR=\S+\/bin/)
})

test('WP-122: spawn points WT_MEMORY_MCP at the sibling wt-memory server (plugin installs have no ~/.claude/skills)', () => {
  assert.match(spawn().tab, /--env WT_MEMORY_MCP=\S+\/wt-memory\/mcp\/server\.mjs/)
})

test('WP-128/158/160: --model is passed to claude as its explicit id, not the bare tier; the role floor applies in every mode, not just live', () => {
  const start = (s) => s.calls.find((l) => l.startsWith('herdr agent start')) ?? ''
  assert.match(start(spawn(['spawn', 'worker', '--model', 'haiku'])), /--model claude-haiku-4-5-20251001/)
  // WP-160: the floor is a fixed computation, not Jev, so it applies with no explicit --model in every mode —
  // a worker gets its session floor (sonnet) even in shadow (default).
  assert.match(start(spawn()), /--model claude-sonnet-5-5/) // WP-178
  assert.match(start(spawn(['spawn', 'planner'])), /--model claude-opus-5-5/) // shadow (default): floor still applies
  assert.match(start(spawn(['spawn', 'planner'], { WT_MODEL_ROUTING: 'off' })), /--model claude-opus-5-5/) // off: same
  assert.match(start(spawn(['spawn', 'planner'], { WT_MODEL_ROUTING: 'live' })), /--model claude-opus-5-5/)
  assert.match(start(spawn(['spawn', 'planner', '--model', 'sonnet'], { WT_MODEL_ROUTING: 'live' })), /--model claude-sonnet-5-5/) // explicit wins
  assert.throws(() => spawn(['spawn', 'worker', '--model', 'gpt']), (e) => e.status === 2)
})

test('WP-137/160: --effort is passed to claude; falls back to the role floor\'s effort, for the tier actually spawned, in every mode', () => {
  const start = (s) => s.calls.find((l) => l.startsWith('herdr agent start')) ?? ''
  assert.match(start(spawn(['spawn', 'worker', '--effort', 'low'])), /--effort low/)
  assert.match(start(spawn()), /--effort medium/) // WP-160: worker's session-floor effort, shadow included
  assert.match(start(spawn(['spawn', 'planner'])), /--effort high/) // shadow (default): floor's own base still applies
  assert.match(start(spawn(['spawn', 'planner'], { WT_MODEL_ROUTING: 'off' })), /--effort high/) // off: same
  assert.match(start(spawn(['spawn', 'planner'], { WT_MODEL_ROUTING: 'live' })), /--effort high/) // opus floor's own base
  // an explicit --model diverging from the role's floor gets that MODEL's effort, not the floor role's
  assert.match(start(spawn(['spawn', 'planner', '--model', 'sonnet'], { WT_MODEL_ROUTING: 'live' })), /--effort medium/)
  assert.match(start(spawn(['spawn', 'worker', '--model', 'haiku'], { WT_MODEL_ROUTING: 'live' })), /--effort high/) // downgrade from sonnet, capped
  assert.match(start(spawn(['spawn', 'planner', '--effort', 'low'], { WT_MODEL_ROUTING: 'live' })), /--effort low/) // explicit wins
  assert.throws(() => spawn(['spawn', 'worker', '--effort', 'urgent']), (e) => e.status === 2)
})

test('WP-143/160: the final model/effort actually spawned are written as pane tokens, in every mode', () => {
  let s = spawn(['spawn', 'worker', '--model', 'haiku', '--effort', 'low'])
  assert.ok(s.calls.some((l) => /^herdr pane report-metadata w1:p9 .*--token model=haiku/.test(l)))
  assert.ok(s.calls.some((l) => /^herdr pane report-metadata w1:p9 .*--token effort=low/.test(l)))
  s = spawn() // WP-160: shadow (default) still records the session floor's tier/effort — not nothing
  assert.ok(s.calls.some((l) => /^herdr pane report-metadata w1:p9 .*--token model=sonnet/.test(l)))
  assert.ok(s.calls.some((l) => /^herdr pane report-metadata w1:p9 .*--token effort=medium/.test(l)))
  s = spawn(['spawn', 'worker'], { WT_MODEL_ROUTING: 'off' }) // off: same
  assert.ok(s.calls.some((l) => /^herdr pane report-metadata w1:p9 .*--token model=sonnet/.test(l)))
  assert.ok(s.calls.some((l) => /^herdr pane report-metadata w1:p9 .*--token effort=medium/.test(l)))
  s = spawn(['spawn', 'planner'], { WT_MODEL_ROUTING: 'live' }) // live routing: floor's tier/effort recorded
  assert.ok(s.calls.some((l) => /^herdr pane report-metadata w1:p9 .*--token model=opus/.test(l)))
  assert.ok(s.calls.some((l) => /^herdr pane report-metadata w1:p9 .*--token effort=high/.test(l)))
})

test('WP-199: a cwd (before or after --model/--effort) wins — the pool, name and project follow it, not the caller\'s repo', () => {
  const other = join(tmp, 'other'); mkdirSync(other); execFileSync('git', ['-C', other, 'init', '-q'])
  for (const args of [['spawn', 'orchestrator', other, '--model', 'opus', '--effort', 'low'], ['spawn', 'orchestrator', '--model', 'opus', '--effort', 'low', other], ['spawn', 'orchestrator', other]]) {
    const s = spawn(args) // run from `demo`
    assert.match(s.out, /^other-orchestrator-01 /, args.join(' '))
    assert.ok(s.calls.some((l) => /^herdr workspace create --label other-orchestrators --cwd \S+\/other /.test(l)), args.join(' '))
    assert.match(s.tab, new RegExp(`--workspace w7 --label other-orchestrator-01 --cwd ${other}`))
    assert.ok(s.calls.some((l) => /report-metadata w1:p9 .*--token project=other/.test(l)))
    if (args.includes('--model')) assert.ok(s.calls.some((l) => /^herdr agent start .*--model claude-opus-5-5 --effort low/.test(l)))
  }
})

test('WP-204: a persona spawns into its base pool with role=<base> persona=<name>, its mcp merged and floored model', () => {
  mkdirSync(join(repo, '.wt-pack', 'roles'), { recursive: true })
  writeFileSync(join(repo, '.wt-pack', 'roles', 'frontend-worker.md'), '---\nbase: worker\nmodel: opus\neffort: low\nmcp: [figma]\n---\nUI.')
  setAccount(null)
  const s = spawn(['spawn', 'frontend-worker', repo])
  assert.match(s.out, /^demo-frontend-worker-01 w1:p9/)
  assert.ok(s.calls.some((l) => /^herdr workspace list/.test(l)))
  const meta = s.calls.find((l) => l.startsWith('herdr pane report-metadata') && l.includes('role='))
  assert.match(meta, /--token role=worker .*--token persona=frontend-worker/)
  assert.ok(s.calls.some((l) => /^herdr agent start demo-frontend-worker-01 .*--model claude-opus.* --effort low/.test(l) || /^herdr agent start demo-frontend-worker-01 .*--model opus/.test(l)))
  assert.ok(s.calls.some((l) => /^herdr agent start .*--mcp-config /.test(l)))
  // an unknown name with no file is still just a role name
  assert.match(spawn(['spawn', 'nofile', repo]).out, /^demo-nofile-01 /)
})

test('WP-205: a *-worker name with no valid role file warns that it spawns a plain role', () => {
  const r = spawnSync(join(here, 'agents.sh'), ['spawn', 'ghost-worker', repo], { cwd: repo, encoding: 'utf8',
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: tmp, XDG_CACHE_HOME: tmp, WT_DASHBOARD_DATA: tmp, WT_DASHBOARD_ENV: join(tmp, 'env') } })
  assert.match(r.stdout, /^demo-ghost-worker-01 /)
  assert.match(r.stderr, /warning: no valid \.wt-pack\/roles\/ghost-worker\.md/)
})
