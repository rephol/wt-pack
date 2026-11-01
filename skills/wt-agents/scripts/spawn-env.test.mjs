// Run: node --test skills/wt-agents/scripts/spawn-env.test.mjs — agents.sh spawn on hc (WP-378), against the fake hc (recorded
// output) and a fake herdr-app. WP-107: a project's GitHub account reaches the agent as GH_TOKEN — in the terminal.run request
// body, never in argv or on disk; gh's global active account is never switched.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync, rmSync, statSync, realpathSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fakeCore, harness, installFakeApp, listCase, runCase, term } from './hc-test-kit.mjs'

const here = import.meta.dirname
const tmp = mkdtempSync(join(tmpdir(), 'wt-spawn-env-'))
const bin = join(tmp, 'bin'), log = join(tmp, 'calls.log'), repo = join(tmp, 'demo')
mkdirSync(bin); mkdirSync(repo); mkdirSync(join(tmp, 'data'))
const stub = (name, body) => { writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> ${log}\n${body}\n`); chmodSync(join(bin, name), 0o755) }
stub('gh', `[ "$1 $2 $3 $4" = "auth token --user rephol" ] && { echo tok123; exit 0; }; exit 1`)
execFileSync('git', ['-C', repo, 'init', '-q'])
writeFileSync(join(tmp, 'trusted-projects.json'), JSON.stringify({ demo: realpathSync(repo) })) // WP-334: repo role files load for trusted projects only (WT_DASHBOARD_DATA = tmp)
const db = new DatabaseSync(join(tmp, 'data', 'wt.db'))
db.exec('CREATE TABLE project_settings (project TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (project, key))')
const setAccount = (a) => { db.exec('DELETE FROM project_settings'); if (a) db.prepare("INSERT INTO project_settings VALUES ('demo', 'githubAccount', ?)").run(a) }

const core = await fakeCore()
const harnesses = []
after(() => { core.stop(); for (const h of harnesses) h.fake.cleanup(); rmSync(tmp, { recursive: true, force: true }) })

const spaces = (...names) => ({ exit: 0, stdout: JSON.stringify({ spaces: names.map((n, i) => ({ id: `sp${i + 1}-${n}`, name: n, machine: null, tabs: [] })), recent: [] }) })
const DEFAULT_APP = { ls: spaces('demo-workers', 'demo-planners', 'demo-orchestrators', 'demo-leads', 'demo-frontend-workers', 'demo-nofiles', 'demo-ghost-workers', 'other-orchestrators') }

// One agents.sh run. cases = fake hc cases; app = fake herdr-app cases; rows = what hc already holds (terminal.list).
const spawn = (args = ['spawn', 'worker'], { env = {}, cases = {}, app = DEFAULT_APP, rows = [], cwd = repo } = {}) => {
  rmSync(log, { force: true })
  const fakeApp = installFakeApp(app)
  const h = harness({ tmp, cases: { 'connect:terminal.list': listCase(...rows), 'connect:terminal.run': runCase('t9'), ...cases }, app: fakeApp, extraEnv: { ...core.env, PATH: `${bin}:${process.env.PATH}`, ...env } })
  // the harness put the fake hc first; keep the stub bin ahead of the rest but behind the fakes
  h.env.PATH = `${fakeApp.bin}:${h.fake.env.PATH.split(':')[0]}:${bin}:${process.env.PATH}`
  harnesses.push(h)
  const r = spawnSync(join(here, 'agents.sh'), args, { cwd, encoding: 'utf8', env: h.env })
  const calls = h.fake.calls()
  const runs = calls.filter((c) => c.args[0] === 'connect').map((c) => JSON.parse(c.stdin)).filter((q) => q.method === 'terminal.run').map((q) => q.params)
  const shell = (() => { try { return readFileSync(log, 'utf8').split('\n') } catch { return [] } })()
  return { ...r, out: r.stdout, run: runs.at(-1), runs, calls, app: fakeApp, h, shell, claude: (runs.at(-1)?.argv ?? []).slice(runs.at(-1)?.argv.indexOf('claude')), cred: (() => { try { return execFileSync('git', ['-C', repo, 'config', 'credential.https://github.com.username'], { encoding: 'utf8' }).trim() } catch { return '' } })() }
}
const ok = (s) => { assert.equal(s.status, 0, s.stderr); return s }
const filesUnder = (d) => readdirSync(d, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath ?? e.path, e.name))

test('account set: GH_TOKEN rides the terminal.run body (and WT_LAUNCH_KEYS names it), git push uses the account, gh auth switch never runs', () => {
  setAccount('rephol')
  const s = ok(spawn())
  assert.match(s.out, /^demo-worker-01 t9/)
  assert.equal(s.run.env.GH_TOKEN, 'tok123')
  assert.match(s.run.env.WT_LAUNCH_KEYS, /(^|,)GH_TOKEN(,|$)/)
  assert.equal(s.cred, 'rephol')
  assert.ok(!s.shell.some((l) => /^gh auth switch/.test(l)))
})

test('WP-378 D3 (red first): no secret in any hc/herdr-app argument and none in a file on disk — GH_TOKEN and the pane key only in the request body', () => {
  setAccount('rephol')
  const s = ok(spawn())
  const key = s.run.env.WT_PANE_KEY
  assert.match(key, /^[0-9a-f]{64}$/)
  const argvs = JSON.stringify([...s.calls.map((c) => c.args), ...s.app.calls()])
  assert.ok(!argvs.includes('tok123') && !argvs.includes(key), 'a value reached an argument list')
  assert.ok(!JSON.stringify(s.run.labels).includes('tok123') && !JSON.stringify(s.run.labels).includes(key) && !JSON.stringify(s.run.argv).includes('tok123'), 'a value reached a label or the program argv (visible in hc get / ps)')
  for (const f of filesUnder(tmp)) {
    if (f.includes('pane-keys') || f.startsWith(bin)) continue // the pane-key file is the one place the key lives (0600), asserted below; bin/ holds the test's own gh stub
    if (f.includes('wt-spawn-env-') && /calls\.log$/.test(f)) continue
    const body = readFileSync(f, 'utf8')
    assert.ok(!body.includes('tok123'), `GH_TOKEN written to ${f}`)
    if (!/fake-hc|fake-app/.test(f)) assert.ok(!body.includes(key), `pane key written to ${f}`)
  }
})

test('no account: no GH_TOKEN in the body, gh not asked; unknown account: warns, spawns without a token', () => {
  execFileSync('git', ['-C', repo, 'config', '--unset', 'credential.https://github.com.username'])
  setAccount(null)
  let s = ok(spawn())
  assert.equal(s.run.env.GH_TOKEN, undefined)
  assert.doesNotMatch(s.run.env.WT_LAUNCH_KEYS, /GH_TOKEN/)
  assert.ok(!s.shell.some((l) => l.startsWith('gh ')))
  setAccount('nobody')
  s = ok(spawn())
  assert.equal(s.run.env.GH_TOKEN, undefined)
  assert.equal(s.cred, '')
  assert.match(s.stderr, /warning: no gh token for nobody/)
  assert.ok(existsSync(join(tmp, '.claude.json')))
})

test('the program is the launcher, the terminal outlives its spawner and tells nobody (outlive_parent, no_notify), labels and cwd as the pool needs', () => {
  setAccount(null)
  const s = ok(spawn())
  const p = s.run
  assert.equal(p.argv[0], join(here, 'hc-launch')); assert.equal(p.argv[1], '--'); assert.equal(p.argv[2], 'claude')
  assert.equal(p.outlive_parent, true); assert.equal(p.no_notify, true)
  assert.equal(p.name, 'demo-worker-01'); assert.equal(p.cwd, realpathSync(repo))
  assert.equal(p.labels['wt.pool'], 'demo-workers'); assert.equal(p.labels.role, 'worker'); assert.equal(p.labels.project, 'demo')
  assert.equal(p.labels.spawned_by, 'wt-agents'); assert.match(p.labels.created, /^\d{4}-\d\d-\d\d$/)
  assert.equal(p.labels['herdr.space'], 'sp1-demo-workers')
  assert.deepEqual(s.claude.slice(0, 3), ['claude', '--name', 'demo-worker-01'])
  assert.ok(!('PATH' in p.env), 'PATH is the login shell\'s; hc-launch re-prepends the shim dir')
})

// WP-348: numbering reads hc's names (live AND finished) and the dashboard's agents table (every row, whatever its state).
const dash = join(tmp, 'rows.json')
stub('curl', `case "$*" in *"/api/agents") cat ${dash} 2>/dev/null || exit 22 ;; *) exit 22 ;; esac`)
const row = (name, state) => ({ name, local: true, state, status: state })

test('WP-120/348: numbering skips a name held by a paused/exited/missing row or a finished terminal; no dashboard, no terminals → 01', () => {
  writeFileSync(dash, JSON.stringify([row('demo-worker-01', 'paused'), row('demo-worker-02', 'exited')]))
  assert.match(ok(spawn(undefined, { rows: [term('t3', 'demo-worker-03', { state: 'finished' })] })).out, /^demo-worker-04 /)
  rmSync(dash)
  assert.match(ok(spawn()).out, /^demo-worker-01 /)
})

test('WP-148/348: numbering reuses the LOWEST free number, not max+1', () => {
  writeFileSync(dash, JSON.stringify([row('demo-worker-02', 'paused')]))
  assert.match(ok(spawn()).out, /^demo-worker-01 /) // 01 is free even though 02 is occupied
  rmSync(dash)
})

test('name_taken (a lost numbering race) takes the next number, up to three tries, then fails with the hc error', () => {
  const taken = 'terminal.run_name_taken'
  let s = ok(spawn(undefined, { cases: { 'connect:terminal.run': [taken, taken, 'terminal.run'] } }))
  assert.deepEqual(s.runs.map((p) => p.name), ['demo-worker-01', 'demo-worker-02', 'demo-worker-03'])
  assert.deepEqual(s.claude.slice(0, 3), ['claude', '--name', 'demo-worker-03'], 'claude is named like its terminal on every try')
  s = spawn(undefined, { cases: { 'connect:terminal.run': taken } })
  assert.equal(s.status, 1); assert.equal(s.runs.length, 3)
  assert.match(s.stderr, /claude did not start in demo-worker-03: a live terminal is already named/)
})

test('WP-319 → hc: a spawn hc refuses reports the error, retires the shell herdr-app opened for a new space, leaves no file behind', () => {
  const bad = { exit: 0, stdout: JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'boom: cannot start', data: { kind: 'spawn_failed' } } }) + '\n' }
  const s = spawn(undefined, { cases: { 'connect:terminal.run': bad, get: 'keep_shell' }, app: { ls: spaces() } })
  assert.equal(s.status, 1)
  assert.match(s.stderr, /claude did not start in demo-worker-01: boom: cannot start/)
  assert.equal(s.runs.length, 1, 'only name_taken is retried')
  const verbs = s.calls.map((c) => c.args[0])
  assert.ok(verbs.includes('kill') && verbs.includes('rm'), 'the stray shell of the brand-new space is closed')
  assert.ok(!existsSync(join(tmp, 'wt-agents', 'mcp-demo-worker-01.json')) && !existsSync(join(tmp, 'wt-agents', 'env-demo-worker-01.sh')))
})

test('core down: spawn, list, dnd, rm and respawn refuse and make NO hc call (a stopped core would be started by any of them)', () => {
  const dead = mkdtempSync(join('/tmp', 'wd-'))
  try {
    for (const args of [['spawn', 'worker'], ['list', 'worker'], ['dnd', 'demo-worker-01', 'on'], ['rm', 'demo-worker-01'], ['respawn', 'demo-worker-01']]) {
      const s = spawn(args, { env: { XDG_STATE_HOME: dead } })
      assert.equal(s.status, 1, args.join(' '))
      assert.match(s.stderr, /hc core is down/)
      assert.equal(s.calls.length, 0, `${args.join(' ')} touched hc`)
      assert.equal(s.app.calls().length, 0)
    }
  } finally { rmSync(dead, { recursive: true, force: true }) }
})

test('herdr-app: a pool\'s space is looked up by name (lowest id when two match), made once under the lock when missing, and a failure runs the agent hidden', () => {
  // found: no space.new, the label names it
  let s = ok(spawn(undefined, { app: { ls: spaces('demo-workers', 'demo-workers') } }))
  assert.equal(s.run.labels['herdr.space'], 'sp1-demo-workers'); assert.ok(!s.app.calls().some((a) => a[0] === 'do'))
  // missing: made with the pool name and the main checkout; its first shell is closed after the agent exists
  s = ok(spawn(undefined, { app: { ls: spaces() }, cases: { get: 'keep_shell' } }))
  const made = s.app.calls().find((a) => a[0] === 'do')
  assert.deepEqual(made.slice(0, 4), ['do', 'space.new', '--name', 'demo-workers']); assert.equal(made[5], realpathSync(repo))
  assert.match(s.run.labels['herdr.space'], /^sp[0-9a-f]+$/)
  const verbs = s.calls.map((c) => `${c.args[0]} ${c.args.at(-1)}`)
  assert.ok(verbs.indexOf('kill t6') > -1 && verbs.indexOf('rm t6') > verbs.indexOf('kill t6'), `stray shell t6 retired: ${verbs}`)
  assert.ok(s.calls.findIndex((c) => c.args[0] === 'connect' && c.stdin.includes('terminal.run')) < verbs.indexOf('kill t6'), 'only after the agent exists')
  // herdr-app fails: hidden, a warning, the spawn still succeeds
  s = ok(spawn(undefined, { app: { ls: { exit: 1, stdout: '', stderr: 'no window' } } }))
  assert.equal(s.run.labels['herdr.space'], undefined); assert.equal(s.run.labels['wt.pool'], 'demo-workers')
  assert.match(s.stderr, /herdr-app failed.*hidden/)
  assert.match(s.out, /^demo-worker-01 t9/)
})

test('WP-120: every spawn gets the kill shims (WT_KILL_SHIM_DIR + CLAUDE_ENV_FILE) and the launcher keeps only the spawner\'s keys', () => {
  const s = ok(spawn()), shim = join(here, '..', 'bin')
  assert.equal(s.run.env.WT_KILL_SHIM_DIR, shim)
  assert.match(s.run.env.CLAUDE_ENV_FILE, /\/wt-agents\/env-demo-worker-01\.sh$/)
  assert.ok(existsSync(s.run.env.CLAUDE_ENV_FILE) && /WT_KILL_SHIM_DIR/.test(readFileSync(s.run.env.CLAUDE_ENV_FILE, 'utf8')))
  for (const k of ['WT_KILL_SHIM_DIR', 'CLAUDE_ENV_FILE', 'WT_MEMORY_MCP', 'WT_PANE_KEY', 'WT_ROLE', 'WT_PROJECT']) assert.match(s.run.env.WT_LAUNCH_KEYS, new RegExp(`(^|,)${k}(,|$)`), k)
  assert.equal(s.run.env.WT_ROLE, 'worker'); assert.equal(s.run.env.WT_PROJECT, 'demo')
})

test('isolation variables the caller set (WT_DASHBOARD_DATA, HERDR_DASH_URL …) reach the agent, so an isolated run touches nothing real', () => {
  const s = ok(spawn(undefined, { env: { HERDR_DASH_URL: 'http://127.0.0.1:1', WT_TURN_DIR: join(tmp, 'turns') } }))
  assert.equal(s.run.env.HERDR_DASH_URL, 'http://127.0.0.1:1'); assert.equal(s.run.env.WT_TURN_DIR, join(tmp, 'turns')); assert.equal(s.run.env.WT_DASHBOARD_DATA, tmp)
  for (const k of ['HERDR_DASH_URL', 'WT_TURN_DIR', 'WT_DASHBOARD_DATA']) assert.match(s.run.env.WT_LAUNCH_KEYS, new RegExp(`(^|,)${k}(,|$)`))
  assert.equal(ok(spawn()).run.env.WT_TURN_DIR, undefined, 'not set by the caller, not invented')
})

test('WP-122: spawn points WT_MEMORY_MCP at the sibling wt-memory server (plugin installs have no ~/.claude/skills)', () => {
  assert.match(ok(spawn()).run.env.WT_MEMORY_MCP, /\/wt-memory\/mcp\/server\.mjs$/)
})

test('WP-128/158/160: --model is passed to claude as its explicit id, not the bare tier; the role floor applies in every mode, not just live', () => {
  const a = (s) => s.claude.join(' ')
  assert.match(a(ok(spawn(['spawn', 'worker', '--model', 'haiku']))), /--model claude-haiku-5-5/)
  assert.match(a(ok(spawn())), /--model claude-sonnet-5-5/) // WP-178: a worker gets its session floor even in shadow (default)
  assert.match(a(ok(spawn(['spawn', 'planner']))), /--model claude-opus-5-5/)
  assert.match(a(ok(spawn(['spawn', 'planner'], { env: { WT_MODEL_ROUTING: 'off' } }))), /--model claude-opus-5-5/)
  assert.match(a(ok(spawn(['spawn', 'planner'], { env: { WT_MODEL_ROUTING: 'live' } }))), /--model claude-opus-5-5/)
  assert.match(a(ok(spawn(['spawn', 'planner', '--model', 'sonnet'], { env: { WT_MODEL_ROUTING: 'live' } }))), /--model claude-sonnet-5-5/) // explicit wins
  assert.equal(spawn(['spawn', 'worker', '--model', 'gpt']).status, 2)
})

test('WP-137/160: --effort is passed to claude; falls back to the role floor\'s effort, for the tier actually spawned, in every mode', () => {
  const a = (s) => s.claude.join(' ')
  assert.match(a(ok(spawn(['spawn', 'worker', '--effort', 'low']))), /--effort low/)
  assert.match(a(ok(spawn())), /--effort medium/)
  assert.match(a(ok(spawn(['spawn', 'planner']))), /--effort high/)
  assert.match(a(ok(spawn(['spawn', 'planner'], { env: { WT_MODEL_ROUTING: 'off' } }))), /--effort high/)
  assert.match(a(ok(spawn(['spawn', 'planner', '--model', 'sonnet'], { env: { WT_MODEL_ROUTING: 'live' } }))), /--effort medium/)
  assert.match(a(ok(spawn(['spawn', 'worker', '--model', 'haiku'], { env: { WT_MODEL_ROUTING: 'live' } }))), /--effort high/) // downgrade from sonnet, capped
  assert.match(a(ok(spawn(['spawn', 'planner', '--effort', 'low'], { env: { WT_MODEL_ROUTING: 'live' } }))), /--effort low/)
  assert.equal(spawn(['spawn', 'worker', '--effort', 'urgent']).status, 2)
})

test('WP-143/160: the final model/effort actually spawned are labels (tier, not id), in every mode, set before claude starts', () => {
  let s = ok(spawn(['spawn', 'worker', '--model', 'haiku', '--effort', 'low']))
  assert.equal(s.run.labels.model, 'haiku'); assert.equal(s.run.labels.effort, 'low')
  s = ok(spawn()); assert.equal(s.run.labels.model, 'sonnet'); assert.equal(s.run.labels.effort, 'medium')
  s = ok(spawn(['spawn', 'worker'], { env: { WT_MODEL_ROUTING: 'off' } })); assert.equal(s.run.labels.model, 'sonnet')
  s = ok(spawn(['spawn', 'planner'], { env: { WT_MODEL_ROUTING: 'live' } })); assert.equal(s.run.labels.model, 'opus'); assert.equal(s.run.labels.effort, 'high')
})

test('WP-199: a cwd (before or after --model/--effort) wins — the pool, name and project follow it, not the caller\'s repo', () => {
  const other = join(tmp, 'other'); mkdirSync(other); execFileSync('git', ['-C', other, 'init', '-q'])
  for (const args of [['spawn', 'orchestrator', other, '--model', 'opus', '--effort', 'low'], ['spawn', 'orchestrator', '--model', 'opus', '--effort', 'low', other], ['spawn', 'orchestrator', other]]) {
    const s = ok(spawn(args)) // run from `demo`
    assert.match(s.out, /^other-orchestrator-01 /, args.join(' '))
    assert.equal(s.run.labels['wt.pool'], 'other-orchestrators'); assert.equal(s.run.labels.project, 'other'); assert.equal(realpathSync(s.run.cwd), realpathSync(other))
    assert.equal(s.run.labels['herdr.space'], 'sp8-other-orchestrators')
    if (args.includes('--model')) assert.match(s.claude.join(' '), /--model claude-opus-5-5 --effort low/)
  }
})

test('names longer than 32 are never made: a long role shortens the repo part', () => {
  const long = join(tmp, 'a-very-long-repository-name-x'); mkdirSync(long); execFileSync('git', ['-C', long, 'init', '-q'])
  const s = ok(spawn(['spawn', 'orchestrator', long], { app: { ls: spaces() } }))
  const name = s.out.split(' ')[0]
  assert.ok(name.length <= 32, name); assert.match(name, /-orchestrator-01$/)
})

test('WP-204: a persona spawns into its base pool with role=<base> persona=<name>, its mcp merged and floored model', () => {
  mkdirSync(join(repo, '.wt-pack', 'roles'), { recursive: true })
  writeFileSync(join(repo, '.wt-pack', 'roles', 'frontend-worker.md'), '---\nbase: worker\nmodel: opus\neffort: low\nmcp: [figma]\n---\nUI.')
  setAccount(null)
  const s = ok(spawn(['spawn', 'frontend-worker', repo]))
  assert.match(s.out, /^demo-frontend-worker-01 t9/)
  assert.equal(s.run.labels.role, 'worker'); assert.equal(s.run.labels.persona, 'frontend-worker'); assert.equal(s.run.labels['wt.pool'], 'demo-workers')
  assert.equal(s.run.env.WT_PERSONA, 'frontend-worker'); assert.equal(s.run.env.WT_ROLE, 'worker')
  assert.match(s.claude.join(' '), /--model claude-opus.* --effort low|--model opus/)
  assert.match(s.claude.join(' '), /--mcp-config \S+mcp-demo-frontend-worker-01\.json/)
  // an unknown name with no file is still just a role name
  assert.match(ok(spawn(['spawn', 'nofile', repo])).out, /^demo-nofile-01 /)
})

test('WP-334: an untrusted repo persona is not found and the warning says why', () => {
  const file = join(tmp, 'trusted-projects.json')
  const saved = readFileSync(file, 'utf8')
  writeFileSync(file, '{}')
  try { assert.match(spawn(['spawn', 'frontend-worker', repo]).stderr, /not trusted; base roles apply\. Trust it in wt-dashboard Settings › demo\./) } finally { writeFileSync(file, saved) }
})

test('WP-237: spawn --team spawns every member x count with the team label; --team on one spawn labels it; a bad team fails', () => {
  mkdirSync(join(repo, '.wt-pack', 'teams'), { recursive: true })
  writeFileSync(join(repo, '.wt-pack', 'teams', 'web.md'), '---\nmembers: [planner, frontend-worker x2]\nstages: [plan=planner, build=frontend-worker]\n---\n')
  setAccount(null)
  const s = ok(spawn(['spawn', '--team', 'web', repo]))
  const names = s.out.trim().split('\n').map((l) => l.split(' ')[0])
  assert.deepEqual(names, ['demo-planner-01', 'demo-frontend-worker-01', 'demo-frontend-worker-01']) // the fake hc list is static, so numbers do not advance here
  assert.equal(s.runs.filter((p) => p.labels.team === 'web').length, 3)
  assert.equal(ok(spawn(['spawn', 'planner', repo, '--team', 'web'])).run.labels.team, 'web')
  assert.equal(ok(spawn(['spawn', 'worker', repo])).run.labels.team, undefined)
  // a role named like a directory in the cwd still spawns ONE agent; a path-like first arg is the whole-team form
  mkdirSync(join(repo, 'worker'), { recursive: true })
  assert.equal(ok(spawn(['spawn', 'planner', '--team', 'web'])).out.trim().split('\n').length, 1)
  for (const args of [['spawn', '--team', 'nope', repo], ['spawn', 'worker', repo, '--team', 'Bad_Name'], ['spawn', 'worker', repo, '--team', 'a\nb'], ['spawn', 'worker', repo, '--team', 'a'.repeat(25)]]) {
    assert.notEqual(spawn(args).status, 0, args.join(' '))
  }
})

test('WP-247: a spawn into a team needs a member persona and a free seat; the bulk spawn fills only missing seats', () => {
  setAccount(null)
  const seat = (persona, role) => term(`t${Math.floor(Math.random() * 900) + 100}`, `x-${persona}`, { labels: { team: 'web', role, persona } })
  const rows = (...r) => r.map(([p, role]) => seat(p, role))
  assert.equal(spawn(['spawn', 'worker', repo, '--team', 'web']).status, 2)
  assert.match(spawn(['spawn', 'worker', repo, '--team', 'web']).stderr, /team web has no worker member/)
  assert.equal(spawn(['spawn', 'reviewer', repo, '--team', 'web']).status, 2)
  assert.equal(spawn(['spawn', 'frontend-worker', repo, '--team', 'web'], { rows: rows(['frontend-worker', 'worker']) }).status, 0)
  const full = spawn(['spawn', 'frontend-worker', repo, '--team', 'web'], { rows: rows(['frontend-worker', 'worker'], ['frontend-worker', 'worker']) })
  assert.equal(full.status, 3); assert.match(full.stderr, /team full: 2\/2 frontend-worker in web/)
  const bulk = ok(spawn(['spawn', '--team', 'web', repo], { rows: rows(['frontend-worker', 'worker'], ['frontend-worker', 'worker']) }))
  assert.equal(bulk.stdout.trim().split('\n').filter(Boolean).length, 1); assert.match(bulk.stdout, /planner/)
  const none = ok(spawn(['spawn', '--team', 'web', repo], { rows: rows(['planner', 'planner'], ['frontend-worker', 'worker'], ['frontend-worker', 'worker']) }))
  assert.equal(none.stdout.trim(), '')
})

test('WP-205: a *-worker name with no valid role file warns that it spawns a plain role', () => {
  const r = spawn(['spawn', 'ghost-worker', repo])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /^demo-ghost-worker-01 /)
  assert.match(r.stderr, /warning: no valid \.wt-pack\/roles\/ghost-worker\.md/)
  assert.match(r.stderr, /searched: .*\.wt-pack\/roles and .*roles \(in effect: /)
  assert.match(r.stderr, /known personas: /)
})

test('WP-327: the pane key is a 0600 file in a 0700 dir under the new terminal id, the same key as WT_PANE_KEY, never a label; a respawn mints a fresh one', () => {
  setAccount(null)
  const s = ok(spawn())
  const key = s.run.env.WT_PANE_KEY
  const f = join(tmp, 'pane-keys', 't9')
  assert.equal(readFileSync(f, 'utf8').trim(), key)
  assert.equal(statSync(f).mode & 0o777, 0o600)
  assert.equal(statSync(join(tmp, 'pane-keys')).mode & 0o777, 0o700)
  assert.ok(!JSON.stringify(s.run.labels).includes(key))
  const k2 = ok(spawn()).run.env.WT_PANE_KEY
  assert.notEqual(k2, key)
  assert.equal(readFileSync(f, 'utf8').trim(), k2)
})

test('WP-327: spawn sweeps key files of terminals that are no longer live (ids repeat across cores); keeps live ones', () => {
  for (const n of ['t77', 't5']) writeFileSync(join(tmp, 'pane-keys', n), 'old\n')
  ok(spawn(undefined, { rows: [term('t5', 'demo-worker-05', { status: 'idle' })] }))
  assert.ok(!existsSync(join(tmp, 'pane-keys', 't77')))
  assert.ok(existsSync(join(tmp, 'pane-keys', 't5')) && existsSync(join(tmp, 'pane-keys', 't9')))
  // an empty list (core just started, or a failed read) sweeps nothing
  writeFileSync(join(tmp, 'pane-keys', 't78'), 'old\n')
  ok(spawn())
  assert.ok(existsSync(join(tmp, 'pane-keys', 't78')))
})

test('WP-368: spawn lead --agent <name> passes --agent to claude, labels role=lead, keeps the floor in every mode; --agent is lead-only and validated', () => {
  for (const mode of ['off', 'shadow', 'live']) {
    const s = ok(spawn(['spawn', 'lead', '--agent', 'wt-pack:wt-lead'], { env: { WT_MODEL_ROUTING: mode } }))
    assert.match(s.out, /^demo-lead-01 /)
    assert.match(s.claude.join(' '), /^claude --name demo-lead-01 --agent wt-pack:wt-lead /)
    assert.match(s.claude.join(' '), /--model claude-(sonnet|opus)-5-5/) // never haiku: the floor still applies
    assert.match(s.claude.join(' '), /--effort \w+/)
    assert.equal(s.run.labels.role, 'lead')
  }
  assert.match(ok(spawn(['spawn', 'lead', '--agent', 'wt-pack:wt-lead', '--model', 'opus', '--effort', 'low'])).claude.join(' '), /--agent wt-pack:wt-lead .*--model claude-opus-5-5 --effort low/)
  assert.doesNotMatch(ok(spawn(['spawn', 'lead'])).claude.join(' '), /--agent/)
  for (const args of [['spawn', 'worker', '--agent', 'wt-pack:wt-lead'], ['spawn', 'lead', '--agent', '../x'], ['spawn', 'lead', '--agent', 'a b']]) assert.equal(spawn(args).status, 2, args.join(' '))
})

test('agents.sh rm: ends the terminal (kill + rm), forgets the row unless --keep-row, refuses a working agent without --force', () => {
  const lab = { role: 'worker' } // WP-378 F5: rm acts on pack agents only (a role label)
  const rows = [term('t3', 'demo-worker-01', { status: 'idle', labels: lab }), term('t4', 'demo-worker-02', { status: 'working', labels: lab }), term('t8', 'demo-worker-08', { state: 'finished', labels: lab })]
  const withCurl = (extra = {}) => ({ rows, env: { HERDR_DASH_URL: 'http://dash', ...extra } })
  stub('curl', `echo "curl $*" >> ${log}`)
  let s = ok(spawn(['rm', 'demo-worker-01', '--keep-row'], withCurl()))
  assert.deepEqual(s.calls.filter((c) => ['kill', 'rm'].includes(c.args[0])).map((c) => c.args.slice(0, 1).concat(c.args.at(-1))), [['kill', 't3'], ['rm', 't3']])
  assert.ok(!s.shell.some((l) => l.startsWith('curl')), 'pause/respawn keep the row')
  s = ok(spawn(['rm', 'demo-worker-01'], withCurl()))
  assert.match(s.shell.join('\n'), /-X POST .*http:\/\/dash\/api\/agents\/by-name\/demo-worker-01\/forget/)
  assert.match(s.out, /removed demo-worker-01 \(t3, was idle\)/)
  s = spawn(['rm', 'demo-worker-02'], withCurl())
  assert.equal(s.status, 1); assert.match(s.stderr, /is working; re-run with --force/); assert.ok(!s.calls.some((c) => c.args[0] === 'kill'))
  assert.equal(ok(spawn(['rm', 't4', '--force', '--keep-row'], withCurl())).calls.filter((c) => c.args[0] === 'kill').length, 1)
  s = ok(spawn(['rm', 'demo-worker-08', '--keep-row'], withCurl())) // an exited agent: its record goes too
  assert.match(s.out, /removed demo-worker-08 \(t8, was exited\)/)
  s = spawn(['rm', 'demo-worker-99'], withCurl()); assert.equal(s.status, 1); assert.match(s.stderr, /no such agent/)
  stub('curl', `case "$*" in *"/api/agents") cat ${dash} 2>/dev/null || exit 22 ;; *) exit 22 ;; esac`)
})
