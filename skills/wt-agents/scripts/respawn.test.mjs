// Run: node --test skills/wt-agents/scripts/respawn.test.mjs — WP-125 on hc (WP-378): respawn keeps name/role/cwd/session/labels in a
// NEW terminal (the kill shims and the launcher are fixed at a terminal's start), refuses a working agent without --force;
// --stale picks only agents whose claude lacks the shim.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, chmodSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fakeCore, harness, installFakeApp, listCase, runCase, term } from './hc-test-kit.mjs'

const here = import.meta.dirname
const tmp = mkdtempSync(join(tmpdir(), 'wt-respawn-'))
const bin = join(tmp, 'bin'), log = join(tmp, 'calls.log'), repo = join(tmp, 'demo'), agentRow = join(tmp, 'agent-row.json')
mkdirSync(bin); mkdirSync(repo); mkdirSync(join(tmp, '.claude', 'projects', 'x'), { recursive: true })
writeFileSync(join(tmp, '.claude', 'projects', 'x', 's-old.jsonl'), '{}\n')
writeFileSync(join(tmp, '.claude', 'projects', 'x', 's-ok.jsonl'), '{}\n')
const stub = (name, body) => { writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`); chmodSync(join(bin, name), 0o755) }
// Fake process table: agent 01 has no shim env, 02 has it. claude's own list maps each terminal's pid to its session.
stub('ps', `case "$*" in
  "-axo pid=,command=") printf '101 /usr/bin/claude --name demo-worker-01\\n102 claude --name demo-worker-02 --resume x\\n' ;;
  "-o etime= -p 102") echo "05:00" ;;
  *"-p 101"*) echo "claude --name demo-worker-01 PATH=/usr/bin" ;;
  *"-p 102"*) echo "claude --name demo-worker-02 WT_KILL_SHIM_DIR=/x/wt-agents/bin" ;;
esac`)
stub('claude', `[ "$1 $2" = "agents --json" ] && echo '[{"pid":101,"sessionId":"s-old"},{"pid":102,"sessionId":"s-ok"}]'`)
stub('curl', `case "$*" in *"/api/agents/by-name/"*) cat ${agentRow} 2>/dev/null || exit 22 ;; *) exit 22 ;; esac`)
execFileSync('git', ['-C', repo, 'init', '-q'])
const core = await fakeCore()
const made = []
after(() => { core.stop(); made.forEach((h) => h.fake.cleanup()); rmSync(tmp, { recursive: true, force: true }) })

const agent = (n, status, labels = {}, extra = {}) => term(`t${n}`, `demo-worker-0${n}`, { status, cwd: repo, pid: 100 + n, labels: { 'wt.pool': 'demo-workers', role: 'worker', project: 'demo', created: '2026-01-01', ...labels }, ...extra })
const run = (args, rows, { cases = {} } = {}) => {
  const app = installFakeApp({ ls: { exit: 0, stdout: JSON.stringify({ spaces: [{ id: 'sp1', name: 'demo-workers', machine: null }], recent: [] }) } })
  const h = harness({ tmp, app, cases: { 'connect:terminal.list': listCase(...rows), 'connect:terminal.run': runCase('t9'), ...cases }, extraEnv: core.env })
  h.env.PATH = `${app.bin}:${h.env.PATH.split(':')[0]}:${bin}:${process.env.PATH}`
  made.push(h)
  const r = spawnSync(join(here, 'agents.sh'), args, { cwd: repo, encoding: 'utf8', env: h.env })
  const calls = h.fake.calls()
  const runs = calls.filter((c) => c.args[0] === 'connect').map((c) => JSON.parse(c.stdin)).filter((q) => q.method === 'terminal.run').map((q) => q.params)
  return { ...r, calls, run: runs[0], runs, verbs: calls.map((c) => `${c.args[0]} ${c.args.at(-1)}`), claude: (runs[0]?.argv ?? []).join(' ') }
}
const at = (r, re) => r.verbs.findIndex((v) => re.test(v))
const runIdx = (r) => r.calls.findIndex((c) => c.args[0] === 'connect' && c.stdin.includes('terminal.run'))

test('respawn <name>: ends the old terminal first, the new one has the shims, resumes under the same name, carries labels', () => {
  const r = run(['respawn', 'demo-worker-01'], [agent(1, 'idle', { task: 'WP-9 fix', ticket: 'WP-9' })])
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout.trim(), 'demo-worker-01 t9')
  assert.ok(at(r, /^kill t1/) >= 0 && at(r, /^kill t1/) < runIdx(r) && at(r, /^rm t1/) < runIdx(r), r.verbs.join(' | '))
  assert.match(r.run.env.WT_KILL_SHIM_DIR, /\/bin$/)
  assert.match(r.claude, /claude --name demo-worker-01 --resume s-old/)
  assert.equal(r.run.name, 'demo-worker-01'); assert.equal(r.run.labels.role, 'worker')
  const labelCalls = r.calls.filter((c) => c.args[0] === 'label').map((c) => c.args.slice(2))
  assert.ok(labelCalls.some((a) => a[0] === 't9' && a[1] === 'task=WP-9 fix'), JSON.stringify(labelCalls))
  assert.ok(labelCalls.some((a) => a[0] === 't9' && a[1] === 'ticket=WP-9'))
  assert.ok(!labelCalls.some((a) => /^(created|wt\.pool|herdr\.space)=/.test(a[1])), 'spawn sets those itself') // legacy-herdr
})

test('respawn refuses a working agent without --force; no transcript → fresh start', () => {
  let r = run(['respawn', 't1'], [agent(1, 'working')])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /is working; re-run with --force/)
  assert.ok(!r.verbs.some((v) => v.startsWith('kill')))
  r = run(['respawn', 't1', '--force'], [agent(1, 'working', {}, { pid: 555 })]) // pid claude does not know → no session → dashboard row, none here
  assert.equal(r.status, 1); assert.match(r.stderr, /no claude session id to resume/)
  writeFileSync(agentRow, JSON.stringify({ name: 'demo-worker-01', session: 's-none', state: 'running', role: 'worker', cwd: repo }))
  try {
    r = run(['respawn', 't1', '--force'], [agent(1, 'working', {}, { pid: 555 })])
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stderr, /no transcript/)
    assert.doesNotMatch(r.claude, /--resume/)
  } finally { rmSync(agentRow, { force: true }) }
})

test('respawn --stale: only the agent whose claude lacks the shim', () => {
  const r = run(['respawn', '--stale'], [agent(1, 'idle'), agent(2, 'idle')])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /^respawned demo-worker-01 t9 \(no kill shim\)$/m)
  assert.doesNotMatch(r.stdout, /demo-worker-02/)
  assert.ok(!r.calls.some((c) => /pgrep|pkill/.test(c.args.join(' '))))
})

test('--stale never touches the caller\'s own terminal', () => {
  const env = { HC_TERMINAL_ID: 't1' }
  const h = harness({ tmp, cases: { 'connect:terminal.list': listCase(agent(1, 'idle'), agent(2, 'idle')) }, extraEnv: { ...core.env, ...env } })
  made.push(h)
  h.env.PATH = `${h.env.PATH.split(':')[0]}:${bin}:${process.env.PATH}`
  h.env.HC_TERMINAL_ID = 't1'
  const r = spawnSync(join(here, 'agents.sh'), ['respawn', '--stale'], { cwd: repo, encoding: 'utf8', env: h.env })
  assert.equal(r.stdout.trim(), 'no stale agents')
})

test('WP-194: --stale flags an agent started before the plugin install (etime, no BSD date -j)', () => {
  const ip = join(tmp, 'plugin'), f = join(tmp, '.claude', 'plugins', 'installed_plugins.json')
  mkdirSync(ip); mkdirSync(join(tmp, '.claude', 'plugins'), { recursive: true })
  writeFileSync(f, JSON.stringify({ plugins: { 'wt-memory@wt-pack': [{ installPath: ip }] } }))
  try { assert.match(run(['respawn', '--stale'], [agent(2, 'idle')]).stdout, /^respawned demo-worker-02 .*\(predates the plugin guard\)$/m) } finally { rmSync(f) }
})

test('WP-143: respawn passes --model/--effort from the old labels, and does not carry them as plain labels too', () => {
  const r = run(['respawn', 'demo-worker-01'], [agent(1, 'idle', { model: 'opus', effort: 'high' })])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.claude, /--model claude-opus-5-5/) // WP-158: the old tier's explicit id, not the bare alias
  assert.match(r.claude, /--effort high/)
  assert.equal(r.run.labels.model, 'opus'); assert.equal(r.run.labels.effort, 'high')
  assert.ok(!r.calls.some((c) => c.args[0] === 'label' && /^(model|effort)=/.test(c.args[3] ?? '')))
})

test('respawn --stale: nothing stale; working agent is skipped and reported', () => {
  assert.equal(run(['respawn', '--stale'], [agent(2, 'idle')]).stdout.trim(), 'no stale agents')
  assert.match(run(['respawn', '--stale'], [agent(1, 'working')]).stdout, /^skipped demo-worker-01: .*is working/m)
})

test('D8: an exited agent (finished terminal) respawns from the dashboard\'s row; rm of it just removes the record; a name nobody holds is "no such agent"', () => {
  writeFileSync(agentRow, JSON.stringify({ name: 'demo-worker-01', session: 's-old', state: 'exited', role: 'worker', cwd: repo }))
  try {
    let r = run(['respawn', 'demo-worker-01'], [agent(1, 'idle', {}, { state: 'finished' })])
    assert.equal(r.status, 0, r.stderr)
    assert.equal(r.stdout.trim(), 'demo-worker-01 t9'); assert.match(r.claude, /--resume s-old/)
    r = run(['rm', 'demo-worker-01'], [agent(1, 'idle', {}, { state: 'finished' })])
    assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /removed demo-worker-01 \(t1, was exited\)/)
    // a kept terminal is a login shell with no labels: the agents-table row is the identity, and it is never typed into (no send is made)
    r = run(['respawn', 'demo-worker-01'], [term('t1', 'demo-worker-01', { cwd: repo, program: 'zsh', pid: 777 })])
    assert.equal(r.status, 0, r.stderr); assert.equal(r.run.labels.role, 'worker'); assert.ok(!r.calls.some((c) => c.args[0] === 'send'))
  } finally { rmSync(agentRow, { force: true }) }
  assert.equal(run(['rm', 'demo-worker-77'], []).status, 1)
})

test('WP-378 F5: rm and respawn act on a pack agent only: a plain shell, a stranger terminal and a dashboard shell are refused with no kill/rm', () => {
  const shell = term('t1', 'my-shell', { cwd: repo, program: 'zsh', pid: 888 })
  const dashShell = term('t2', 'sh-demo-01', { cwd: repo, program: 'zsh', pid: 889, labels: { 'wt.pool': 'demo-shells' } })
  for (const [name, row] of [['my-shell', shell], ['sh-demo-01', dashShell]]) {
    for (const verb of [['rm', name], ['rm', name, '--force'], ['respawn', name, '--force']]) {
      const r = run(verb, [row])
      assert.notEqual(r.status, 0, `${verb.join(' ')}: ${r.stdout}`)
      assert.match(r.stderr, /not a pack agent.*only pack agents can be removed or respawned here \(the user closes other terminals in herdr-app\)/s)
      assert.deepEqual(r.calls.filter((c) => ['kill', 'rm', 'interrupt'].includes(c.args[0]) || c.stdin?.includes('terminal.run')), [], `${verb.join(' ')} made a destructive call`)
    }
  }
  // by id too
  const r = run(['rm', 't1'], [shell]); assert.notEqual(r.status, 0); assert.ok(!r.calls.some((c) => c.args[0] === 'kill' || c.args[0] === 'rm'))
  // a pack agent still goes
  assert.equal(run(['rm', 'demo-worker-01'], [agent(1, 'idle')]).status, 0)
})

test('WP-378 F6: a role-less agent that carries a (non -shells) wt.pool label IS a pack agent: rm and respawn accept it (require_pack_agent pool branch)', () => {
  const poolOnly = agent(1, 'idle', { role: undefined }) // labels: wt.pool=demo-workers, no role, no agents-table row
  let r = run(['rm', 'demo-worker-01'], [poolOnly])
  assert.equal(r.status, 0, r.stderr); assert.doesNotMatch(r.stderr, /not a pack agent/)
  assert.ok(r.calls.some((c) => ['kill', 'rm'].includes(c.args[0])), 'it was ended')
  r = run(['respawn', 'demo-worker-01'], [poolOnly])
  assert.doesNotMatch(r.stderr, /not a pack agent/)
})
