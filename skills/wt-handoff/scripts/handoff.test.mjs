// Run: node --test skills/wt-handoff/scripts/handoff.test.mjs — handoff.sh against a stub herdr.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, chmodSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const here = import.meta.dirname
const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'wt-handoff-')))
const bin = join(tmp, 'bin'), log = join(tmp, 'calls.log'), repo = join(tmp, 'demo')
mkdirSync(bin); mkdirSync(repo)
writeFileSync(join(bin, 'herdr'), `#!/bin/sh\necho "herdr $*" >> ${log}\ncase "$1 $2" in
  "workspace list") echo '{"result":{"workspaces":[{"label":"demo-reviewers","workspace_id":"wR"},{"label":"demo-workers","workspace_id":"wW"}]}}' ;;
  "agent list") cat "${tmp}/agents.json" 2>/dev/null || echo '{"result":{"agents":[]}}' ;;
  "pane list") cat "${tmp}/panes.json" 2>/dev/null || echo '{"result":{"panes":[]}}' ;;
  "tab get") echo '{"result":{"tab":{"label":"r"}}}' ;;
  "pane get") cat "${tmp}/pane-$(echo "$3" | tr : _).json" 2>/dev/null || echo '{"result":{"pane":{"tokens":{}}}}' ;;
  "agent prompt") case " $* " in *" --wait "*) [ -f "${tmp}/goal-clear-fails" ] && exit 1 || exit 0 ;; esac ;;
  *) echo '{"result":{}}' ;;
esac\n`)
chmodSync(join(bin, 'herdr'), 0o755)
execFileSync('git', ['-C', repo, 'init', '-q'])
const run = (args, input = 'review it') => execFileSync(join(here, 'handoff.sh'), args, { input, encoding: 'utf8',
  env: { PATH: `${bin}:${process.env.PATH}`, HOME: tmp, WT_HANDOFF_JEV: 'off' } })

test('WP-121: --role reviewer targets <repo>-reviewers, spawns in the main checkout, tags pr/sha', () => {
  const sha = 'b'.repeat(40)
  const out = run(['--role', 'reviewer', '--kind', 'dispatch', '--pr', '12', '--sha', sha, '--no-goal', '--dry-run', repo], '/wt-watch-prs review 12')
  assert.match(out, new RegExp(`would spawn a reviewer in ${repo}`))
  assert.match(out, new RegExp(`kind=dispatch from="[^"]*" pr=12 sha=${sha}>`))
  assert.match(readFileSync(log, 'utf8'), /herdr workspace list/)
  assert.throws(() => run(['--role', 'boss', '--dry-run', repo]), (e) => e.status === 2)
  // reuse comes from the reviewers workspace (wR) only; a free worker elsewhere is not a candidate
  writeFileSync(join(tmp, 'agents.json'), JSON.stringify({ result: { agents: [
    { name: 'demo-worker-01', pane_id: 'wW:p1', tab_id: 't1', agent_status: 'idle', workspace_id: 'wW', cwd: repo },
    { name: 'demo-reviewer-01', pane_id: 'wR:p1', tab_id: 't2', agent_status: 'idle', workspace_id: 'wR', cwd: repo }] } }))
  assert.match(run(['--role', 'reviewer', '--no-goal', '--dry-run', repo]), /would reuse reviewer demo-reviewer-01 \(wR:p1\)/)
  // from a worktree cwd, a reviewer still spawns in the main checkout
  writeFileSync(join(tmp, 'agents.json'), '{"result":{"agents":[]}}')
  execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x'])
  execFileSync('git', ['-C', repo, 'worktree', 'add', '-q', join(tmp, 'wt'), '-b', 'wt'])
  assert.match(run(['--role', 'reviewer', '--no-goal', '--dry-run', join(tmp, 'wt')]), new RegExp(`would spawn a reviewer in ${repo}$`, 'm'))
})

test('WP-128: shadow logs a routing line and changes nothing; live spawns a fresh agent with --model', () => {
  writeFileSync(join(tmp, 'agents.json'), JSON.stringify({ result: { agents: [
    { name: 'demo-reviewer-01', pane_id: 'wR:p1', tab_id: 't2', agent_status: 'idle', workspace_id: 'wR', cwd: repo }] } }))
  let out = run(['--role', 'reviewer', '--no-goal', '--dry-run', repo], 'list the open PRs')
  assert.match(out, /would reuse reviewer demo-reviewer-01/)
  assert.match(out, /routing: haiku \(shadow, local, ref [a-z0-9]+#0\)/)
  out = execFileSync(join(here, 'handoff.sh'), ['--role', 'reviewer', '--no-goal', '--dry-run', repo], { input: 'list the open PRs', encoding: 'utf8',
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: tmp, WT_HANDOFF_JEV: 'off', WT_MODEL_ROUTING: 'live' } })
  assert.match(out, /would spawn a reviewer in \S+ with --model haiku/) // a reused agent can't switch model without a picker
  // WP-137: the same live spawn also carries its computed effort (haiku is a downgrade from sonnet, capped at 'high')
  assert.match(out, /would spawn a reviewer in \S+ with --model haiku --effort high/)
  writeFileSync(join(tmp, 'agents.json'), '{"result":{"agents":[]}}')
})

test('WP-129: routing sees --skill, or "wt-handoff" by default, never a word scraped from the task', () => {
  writeFileSync(join(tmp, 'agents.json'), JSON.stringify({ result: { agents: [
    { name: 'demo-reviewer-01', pane_id: 'wR:p1', tab_id: 't2', agent_status: 'idle', workspace_id: 'wR', cwd: repo }] } }))
  const judgeLog = join(tmp, '.claude', 'wt-judge-log.jsonl')
  run(['--role', 'reviewer', '--no-goal', repo], 'wt-dashboard sent this: review it')
  let entries = readFileSync(judgeLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(entries.at(-1).item.skill, 'wt-handoff')
  run(['--role', 'reviewer', '--skill', 'wt-watch-prs', '--no-goal', repo], 'review it')
  entries = readFileSync(judgeLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(entries.at(-1).item.skill, 'wt-watch-prs')
  writeFileSync(join(tmp, 'agents.json'), '{"result":{"agents":[]}}')
})

// --cancel never reaches the network board (curl points at a closed port), so a ticket lookup fails
// fast and the assignee-return is skipped — that path is exercised by --cancel's dry-run assertions
// and by hand against a throwaway agent, not here.
const runCancel = (args) => execFileSync(join(here, 'handoff.sh'), args, { encoding: 'utf8',
  env: { PATH: `${bin}:${process.env.PATH}`, HOME: tmp, HERDR_DASH_URL: 'http://127.0.0.1:1' } })

test('WP-143: live routing reuses a free worker already on the routed tier/effort; a different tier spawns fresh', () => {
  const liveEnv = { PATH: `${bin}:${process.env.PATH}`, HOME: tmp, WT_HANDOFF_JEV: 'off', WT_MODEL_ROUTING: 'live' }
  writeFileSync(join(tmp, 'panes.json'), JSON.stringify({ result: { panes: [
    { pane_id: 'wW:p1', tokens: { model: 'haiku', effort: 'high' } }] } }))
  writeFileSync(join(tmp, 'agents.json'), JSON.stringify({ result: { agents: [
    { name: 'demo-worker-01', pane_id: 'wW:p1', tab_id: 't1', agent_status: 'idle', workspace_id: 'wW', cwd: repo }] } }))
  execFileSync(join(here, 'handoff.sh'), ['--role', 'worker', '--no-goal', repo], { input: 'list the open PRs', encoding: 'utf8', env: liveEnv })
  let calls = readFileSync(log, 'utf8')
  assert.match(calls, /^herdr agent prompt wW:p1 /m)
  assert.ok(!calls.includes('tab create'))

  writeFileSync(join(tmp, 'panes.json'), JSON.stringify({ result: { panes: [
    { pane_id: 'wW:p1', tokens: { model: 'sonnet', effort: 'high' } }] } }))
  const out = execFileSync(join(here, 'handoff.sh'), ['--role', 'worker', '--no-goal', '--dry-run', repo], { input: 'list the open PRs', encoding: 'utf8', env: liveEnv })
  assert.match(out, /would spawn a worker in \S+ with --model haiku/)

  writeFileSync(join(tmp, 'panes.json'), '{"result":{"panes":[]}}')
  writeFileSync(join(tmp, 'agents.json'), '{"result":{"agents":[]}}')
})

test('WP-132: --cancel resolves a name to its pane and reports what it did', () => {
  writeFileSync(join(tmp, 'agents.json'), JSON.stringify({ result: { agents: [
    { name: 'demo-worker-01', pane_id: 'wW:p1', tab_id: 't1', agent_status: 'working', workspace_id: 'wW', cwd: repo }] } }))
  assert.match(runCancel(['--dry-run', '--cancel', 'demo-worker-01', 'duplicate dispatch']),
    /dry-run: would cancel demo-worker-01 \(wW:p1\): duplicate dispatch/)

  writeFileSync(join(tmp, 'pane-wW_p1.json'), JSON.stringify({ result: { pane: { tokens: { task: 'WP-1 fix it', ticket: 'WP-1' } } } }))
  const out = runCancel(['--cancel', 'demo-worker-01'])
  assert.equal(out.trim(), 'cancelled demo-worker-01 (wW:p1): goal cleared, cleared task="WP-1 fix it"')
  const calls = readFileSync(log, 'utf8')
  assert.match(calls, /herdr agent send-keys wW:p1 esc/)
  assert.match(calls, /herdr agent prompt wW:p1 \/goal clear --wait/)
  assert.match(calls, /herdr pane report-metadata wW:p1 --source wt-dashboard --clear-token task --clear-token ticket/)

  writeFileSync(join(tmp, 'goal-clear-fails'), '')
  assert.match(runCancel(['--cancel', 'demo-worker-01']), /goal clear unverified, sent \/clear/)

  assert.throws(() => runCancel(['--cancel', 'no-such-agent']), (e) => e.status === 1)
  writeFileSync(join(tmp, 'agents.json'), '{"result":{"agents":[]}}')
})
