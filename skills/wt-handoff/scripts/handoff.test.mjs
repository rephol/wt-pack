// Run: node --test skills/wt-handoff/scripts/handoff.test.mjs — handoff.sh against a stub herdr.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, chmodSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const here = import.meta.dirname
// WP-267: confirm needs a real screen (box found empty, prompt echoed) — a real capture of a just-submitted prompt
const submitted = new URL('../../wt-shared/scripts/fixtures/pane-submit-submitted.txt', import.meta.url).pathname
const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'wt-handoff-')))
const bin = join(tmp, 'bin'), log = join(tmp, 'calls.log'), repo = join(tmp, 'demo')
mkdirSync(bin); mkdirSync(repo)
writeFileSync(join(bin, 'herdr'), `#!/bin/sh\necho "herdr $*" >> ${log}\ncase "$1 $2" in
  "workspace list") echo '{"result":{"workspaces":[{"label":"demo-reviewers","workspace_id":"wR"},{"label":"demo-workers","workspace_id":"wW"}]}}' ;;
  "agent list") cat "${tmp}/agents.json" 2>/dev/null || echo '{"result":{"agents":[]}}' ;;
  "pane list") cat "${tmp}/panes.json" 2>/dev/null || echo '{"result":{"panes":[]}}' ;;
  "tab list") cat "${tmp}/tabs.json" 2>/dev/null || echo '{"result":{"tabs":[]}}' ;;
  "pane read") cat "${submitted}" ;;
  "tab get") echo '{"result":{"tab":{"label":"r"}}}' ;;
  "pane get") cat "${tmp}/pane-$(echo "$3" | tr : _).json" 2>/dev/null || echo '{"result":{"pane":{"tokens":{}}}}' ;;
  "agent prompt") case " $* " in *" --wait "*) [ -f "${tmp}/goal-clear-fails" ] && exit 1 || exit 0 ;; esac ;;
  *) echo '{"result":{}}' ;;
esac\n`)
chmodSync(join(bin, 'herdr'), 0o755)
execFileSync('git', ['-C', repo, 'init', '-q'])
const run = (args, input = 'review it') => execFileSync(join(here, 'handoff.sh'), args, { input, encoding: 'utf8',
  env: { PATH: `${bin}:${process.env.PATH}`, HOME: tmp, WT_READY_TIMEOUT: '0', WT_SUBMIT_SETTLE_MS: '0', WT_HANDOFF_JEV: 'off' } })

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
  // WP-157: a local read-only rule would pick haiku, but handoff routes a SESSION's own tier (--session),
  // which never lands below sonnet — this local task is a read-only rule, so effort drops one level too.
  assert.match(out, /routing: sonnet \(shadow, local\+session-floor, ref [a-z0-9]+#0\)/)
  out = execFileSync(join(here, 'handoff.sh'), ['--role', 'reviewer', '--no-goal', '--dry-run', repo], { input: 'list the open PRs', encoding: 'utf8',
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: tmp, WT_READY_TIMEOUT: '0', WT_SUBMIT_SETTLE_MS: '0', WT_HANDOFF_JEV: 'off', WT_MODEL_ROUTING: 'live' } })
  assert.match(out, /would spawn a reviewer in \S+ with --model sonnet/) // a reused agent can't switch model without a picker
  assert.match(out, /would spawn a reviewer in \S+ with --model sonnet --effort low/)
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
  env: { PATH: `${bin}:${process.env.PATH}`, HOME: tmp, WT_READY_TIMEOUT: '0', WT_SUBMIT_SETTLE_MS: '0', HERDR_DASH_URL: 'http://127.0.0.1:1' } })

test('WP-143: live routing reuses a free worker already on the routed tier/effort; a different tier or effort spawns fresh', () => {
  const liveEnv = { PATH: `${bin}:${process.env.PATH}`, HOME: tmp, WT_READY_TIMEOUT: '0', WT_SUBMIT_SETTLE_MS: '0', WT_HANDOFF_JEV: 'off', WT_MODEL_ROUTING: 'live' }
  // WP-157: --session floors this local read-only pick to sonnet/low (never haiku for a session's own tier)
  writeFileSync(join(tmp, 'panes.json'), JSON.stringify({ result: { panes: [
    { pane_id: 'wW:p1', tokens: { model: 'sonnet', effort: 'low' } }] } }))
  writeFileSync(join(tmp, 'agents.json'), JSON.stringify({ result: { agents: [
    { name: 'demo-worker-01', pane_id: 'wW:p1', tab_id: 't1', agent_status: 'idle', workspace_id: 'wW', cwd: repo }] } }))
  let out = execFileSync(join(here, 'handoff.sh'), ['--role', 'worker', '--no-goal', '--dry-run', repo], { input: 'list the open PRs', encoding: 'utf8', env: liveEnv })
  assert.match(out, /would reuse worker demo-worker-01 \(wW:p1\) \(model sonnet\)/) // routed dry-run wording (plan Unit 2)
  execFileSync(join(here, 'handoff.sh'), ['--role', 'worker', '--no-goal', repo], { input: 'list the open PRs', encoding: 'utf8', env: liveEnv })
  let calls = readFileSync(log, 'utf8')
  assert.match(calls, /^herdr pane send-text wW:p1 Do the task in /m) // WP-272: the plain short line
  assert.ok(!calls.includes('tab create'))

  // same model, different effort: still a spawn, not a reuse (the effort half of the match rule)
  writeFileSync(join(tmp, 'panes.json'), JSON.stringify({ result: { panes: [
    { pane_id: 'wW:p1', tokens: { model: 'sonnet', effort: 'medium' } }] } }))
  out = execFileSync(join(here, 'handoff.sh'), ['--role', 'worker', '--no-goal', '--dry-run', repo], { input: 'list the open PRs', encoding: 'utf8', env: liveEnv })
  assert.match(out, /would spawn a worker in \S+ with --model sonnet --effort low/)

  // different model: spawn
  writeFileSync(join(tmp, 'panes.json'), JSON.stringify({ result: { panes: [
    { pane_id: 'wW:p1', tokens: { model: 'haiku', effort: 'low' } }] } }))
  out = execFileSync(join(here, 'handoff.sh'), ['--role', 'worker', '--no-goal', '--dry-run', repo], { input: 'list the open PRs', encoding: 'utf8', env: liveEnv })
  assert.match(out, /would spawn a worker in \S+ with --model sonnet/)

  writeFileSync(join(tmp, 'panes.json'), '{"result":{"panes":[]}}')
  writeFileSync(join(tmp, 'agents.json'), '{"result":{"agents":[]}}')
})

test('WP-143: WT_WORKERS_MAX caps the worker pool; a full pool exits 3 and never tab-creates', () => {
  writeFileSync(join(tmp, 'agents.json'), JSON.stringify({ result: { agents: [
    { name: 'demo-worker-01', pane_id: 'wW:p1', tab_id: 't1', agent_status: 'working', workspace_id: 'wW', cwd: repo }] } }))
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: tmp, WT_READY_TIMEOUT: '0', WT_SUBMIT_SETTLE_MS: '0', WT_HANDOFF_JEV: 'off', WT_WORKERS_MAX: '1' }
  assert.throws(() => execFileSync(join(here, 'handoff.sh'), ['--role', 'worker', '--no-goal', repo], { input: 'do a thing', encoding: 'utf8', env }),
    (e) => { assert.equal(e.status, 3); assert.match(e.stderr, /pool full: 1\/1 plain workers in demo/); return true })
  assert.ok(!readFileSync(log, 'utf8').includes('tab create'))

  const out = execFileSync(join(here, 'handoff.sh'), ['--role', 'worker', '--no-goal', '--dry-run', repo], { input: 'do a thing', encoding: 'utf8', env })
  assert.match(out, /dry-run: pool full: 1\/1 plain workers in demo/)

  // under the cap: still spawns, never treated as full
  const under = execFileSync(join(here, 'handoff.sh'), ['--role', 'worker', '--no-goal', '--dry-run', repo],
    { input: 'do a thing', encoding: 'utf8', env: { ...env, WT_WORKERS_MAX: '2' } })
  assert.match(under, /^dry-run: would spawn a worker in/)

  writeFileSync(join(tmp, 'agents.json'), '{"result":{"agents":[]}}')
})

test('WP-147: a DND agent is not listed, and --pane to one warns but still sends', () => {
  writeFileSync(join(tmp, 'agents.json'), JSON.stringify({ result: { agents: [
    { name: 'demo-worker-01', pane_id: 'wW:p1', tab_id: 't1', agent_status: 'idle', workspace_id: 'wW', cwd: repo },
    { name: 'demo-worker-02', pane_id: 'wW:p2', tab_id: 't2', agent_status: 'idle', workspace_id: 'wW', cwd: repo }] } }))
  writeFileSync(join(tmp, 'panes.json'), JSON.stringify({ result: { panes: [{ pane_id: 'wW:p1', tokens: { dnd: '1' } }] } }))
  writeFileSync(join(tmp, 'pane-wW_p1.json'), JSON.stringify({ result: { pane: { tokens: { dnd: '1' } } } }))
  const list = run(['--list', repo], '')
  assert.ok(!list.includes('wW:p1'))
  assert.ok(list.includes('wW:p2'))
  let threw = null
  let out
  try { out = execFileSync(join(here, 'handoff.sh'), ['--pane', 'wW:p1', '--no-goal', repo], { input: 'x', encoding: 'utf8',
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: tmp } }) } catch (e) { threw = e }
  assert.equal(threw, null)
  assert.match(out, /^reused wW:p1$/m)
  writeFileSync(join(tmp, 'panes.json'), '{"result":{"panes":[]}}')
  writeFileSync(join(tmp, 'agents.json'), '{"result":{"agents":[]}}')
})

test('WP-168: a --pane hand-off (dispatch to an already-running worker) logs its known tier as source=reuse, no Jev', () => {
  writeFileSync(join(tmp, 'agents.json'), JSON.stringify({ result: { agents: [
    { name: 'demo-worker-01', pane_id: 'wW:p1', tab_id: 't1', agent_status: 'idle', workspace_id: 'wW', cwd: repo }] } }))
  writeFileSync(join(tmp, 'pane-wW_p1.json'), JSON.stringify({ result: { pane: { tokens: { model: 'opus', effort: 'high' } } } }))
  const out = run(['--pane', 'wW:p1', '--no-goal', repo], 'do the thing')
  assert.match(out, /^reused wW:p1$/m)
  // shadow (the default mode): logged with a ref, nothing applied — same shape as a Jev/local/pin decision,
  // so `model-route.mjs outcome <ref> ...` has something to mark for this ticket.
  assert.match(out, /routing: opus \(shadow, reuse, ref [a-z0-9]+#0\)/)
  writeFileSync(join(tmp, 'pane-wW_p1.json'), '{"result":{"pane":{"tokens":{}}}}')
  writeFileSync(join(tmp, 'agents.json'), '{"result":{"agents":[]}}')
})

test('WP-168: a --pane hand-off to a worker with no known model token logs nothing (nothing to log)', () => {
  writeFileSync(join(tmp, 'agents.json'), JSON.stringify({ result: { agents: [
    { name: 'demo-worker-01', pane_id: 'wW:p1', tab_id: 't1', agent_status: 'idle', workspace_id: 'wW', cwd: repo }] } }))
  const out = run(['--pane', 'wW:p1', '--no-goal', repo], 'do the thing')
  assert.match(out, /^reused wW:p1$/m)
  assert.ok(!out.includes('routing:'))
  writeFileSync(join(tmp, 'agents.json'), '{"result":{"agents":[]}}')
})

test('WP-147: a paired agent is not a free candidate, only reachable for its own ticket', () => {
  writeFileSync(join(tmp, 'agents.json'), JSON.stringify({ result: { agents: [
    { name: 'demo-worker-01', pane_id: 'wW:p1', tab_id: 't1', agent_status: 'idle', workspace_id: 'wW', cwd: repo }] } }))
  writeFileSync(join(tmp, 'panes.json'), JSON.stringify({ result: { panes: [{ pane_id: 'wW:p1', tokens: { pair: 'WP-9' } }] } }))
  const list = run(['--list', repo], '')
  assert.ok(!list.includes('wW:p1'))
  writeFileSync(join(tmp, 'panes.json'), '{"result":{"panes":[]}}')
  writeFileSync(join(tmp, 'agents.json'), '{"result":{"agents":[]}}')
})

test('WP-147: --task <TICKET> with no --pane routes to the pair — the worker, or the buddy for --role reviewer', () => {
  // wt-ticket's own HTTP calls (curl) don't route through the herdr stub, so this one test gets a dedicated
  // curl stub ahead of it on PATH: `-w '\n%{http_code}'` means the body is followed by a newline and a status.
  const curlBin = join(tmp, 'curlbin')
  mkdirSync(curlBin, { recursive: true })
  writeFileSync(join(curlBin, 'curl'), `#!/bin/sh
for a in "$@"; do url=$a; done
case "$url" in
  *"/api/tickets/keys"*) printf 'WP\\n200' ;;
  *"/api/tickets/WP-9"*) printf '%s\\n200' '{"id":"WP-9","pair":{"worker":{"name":"demo-worker-09","pane":"wW:p9"},"buddy":{"name":"demo-reviewer-09","pane":"wR:p9","role":"reviewer"}}}' ;;
  *) printf '{}\\n404' ;;
esac
`)
  chmodSync(join(curlBin, 'curl'), 0o755)
  const env = { PATH: `${curlBin}:${bin}:${process.env.PATH}`, HOME: tmp, WT_READY_TIMEOUT: '0', WT_SUBMIT_SETTLE_MS: '0', WT_HANDOFF_JEV: 'off' }
  let out = execFileSync(join(here, 'handoff.sh'), ['--no-goal', '--dry-run', '--task', 'WP-9 fix it', repo], { input: 'x', encoding: 'utf8', env })
  assert.match(out, /would hand to pane wW:p9$/m)
  out = execFileSync(join(here, 'handoff.sh'), ['--role', 'reviewer', '--no-goal', '--dry-run', '--task', 'WP-9 fix it', repo], { input: 'x', encoding: 'utf8', env })
  assert.match(out, /would hand to pane wR:p9$/m)
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

test('WP-204: --persona lists/reuses only agents tagged with that persona; a plain handoff skips them', () => {
  writeFileSync(join(tmp, 'agents.json'), JSON.stringify({ result: { agents: [
    { name: 'demo-worker-01', pane_id: 'wW:p1', tab_id: 't1', agent_status: 'idle', workspace_id: 'wW', cwd: repo },
    { name: 'demo-frontend-worker-01', pane_id: 'wW:p2', tab_id: 't2', agent_status: 'idle', workspace_id: 'wW', cwd: repo }] } }))
  writeFileSync(join(tmp, 'panes.json'), JSON.stringify({ result: { panes: [{ pane_id: 'wW:p2', tokens: { persona: 'frontend-worker' } }] } }))
  const plain = run(['--list', repo], '')
  assert.ok(plain.includes('wW:p1') && !plain.includes('wW:p2'))
  const pers = run(['--persona', 'frontend-worker', '--list', repo], '')
  assert.ok(pers.includes('wW:p2') && !pers.includes('wW:p1'))
  assert.match(run(['--persona', 'frontend-worker', '--role', 'worker', '--no-goal', '--dry-run', repo], 'do ui'), /would reuse worker demo-frontend-worker-01/)
  // no free persona agent: it spawns the persona, not a plain worker
  writeFileSync(join(tmp, 'panes.json'), '{"result":{"panes":[]}}')
  assert.match(run(['--persona', 'frontend-worker', '--role', 'worker', '--no-goal', '--dry-run', repo], 'do ui'), /would spawn a frontend-worker worker in/)
  // base from the role file when --role is absent; unresolvable persona → exit 2
  assert.throws(() => run(['--persona', 'ghost', '--dry-run', repo], 'x'), (e) => e.status === 2)
  writeFileSync(join(tmp, 'agents.json'), '{"result":{"agents":[]}}')
})

test('WP-204: --persona alone resolves the base from its role file; a conflicting --role is exit 2', () => {
  mkdirSync(join(repo, '.wt-pack', 'roles'), { recursive: true })
  writeFileSync(join(repo, '.wt-pack', 'roles', 'qa-reviewer.md'), '---\nbase: reviewer\n---\nQA.')
  assert.match(run(['--persona', 'qa-reviewer', '--no-goal', '--dry-run', repo], 'check it'), /would spawn a qa-reviewer reviewer in/)
  assert.throws(() => run(['--persona', 'qa-reviewer', '--role', 'worker', '--dry-run', repo], 'x'), (e) => e.status === 2)
})

test('WP-205: the worker cap counts only agents of the same persona kind (none for a plain handoff)', () => {
  writeFileSync(join(tmp, 'agents.json'), JSON.stringify({ result: { agents: [
    { name: 'demo-frontend-worker-01', pane_id: 'wW:p2', tab_id: 't2', agent_status: 'idle', workspace_id: 'wW', cwd: repo }] } }))
  writeFileSync(join(tmp, 'panes.json'), JSON.stringify({ result: { panes: [{ pane_id: 'wW:p2', tokens: { persona: 'frontend-worker' } }] } }))
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: tmp, WT_READY_TIMEOUT: '0', WT_SUBMIT_SETTLE_MS: '0', WT_HANDOFF_JEV: 'off', WT_WORKERS_MAX: '1' }
  const go = (extra) => execFileSync(join(here, 'handoff.sh'), ['--role', 'worker', ...extra, '--no-goal', '--dry-run', repo], { input: 'x', encoding: 'utf8', env })
  assert.match(go([]), /would spawn a worker/) // an idle persona agent does not fill a plain ticket's cap
  assert.match(go(['--persona', 'frontend-worker']), /would reuse worker demo-frontend-worker-01/)
  assert.match(go(['--persona', 'other-worker']), /would spawn/) // a different persona counts its own kind only (0 here), so it is not full
  writeFileSync(join(tmp, 'panes.json'), '{"result":{"panes":[]}}')
  writeFileSync(join(tmp, 'agents.json'), '{"result":{"agents":[]}}')
})

test('WP-205: a persona at its own cap is full (exit 3) while a plain handoff is not', () => {
  writeFileSync(join(tmp, 'agents.json'), JSON.stringify({ result: { agents: [
    { name: 'demo-frontend-worker-01', pane_id: 'wW:p2', tab_id: 't2', agent_status: 'working', workspace_id: 'wW', cwd: repo }] } }))
  writeFileSync(join(tmp, 'panes.json'), JSON.stringify({ result: { panes: [{ pane_id: 'wW:p2', tokens: { persona: 'frontend-worker' } }] } }))
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: tmp, WT_READY_TIMEOUT: '0', WT_SUBMIT_SETTLE_MS: '0', WT_HANDOFF_JEV: 'off', WT_WORKERS_MAX: '1' }
  try {
    assert.throws(() => execFileSync(join(here, 'handoff.sh'), ['--role', 'worker', '--persona', 'frontend-worker', '--no-goal', repo], { input: 'x', encoding: 'utf8', env }),
      (e) => { assert.equal(e.status, 3); assert.match(e.stderr, /pool full: 1\/1 frontend-worker workers/); return true })
    assert.match(execFileSync(join(here, 'handoff.sh'), ['--role', 'worker', '--no-goal', '--dry-run', repo], { input: 'x', encoding: 'utf8', env }), /would spawn a worker/)
  } finally {
    writeFileSync(join(tmp, 'panes.json'), '{"result":{"panes":[]}}')
    writeFileSync(join(tmp, 'agents.json'), '{"result":{"agents":[]}}')
  }
})

test('WP-210: --reply queues through the dashboard when the target mod is live, pastes otherwise', () => {
  const curlBin = join(tmp, 'curlbin210')
  mkdirSync(curlBin, { recursive: true })
  const stub = (body) => { writeFileSync(join(curlBin, 'curl'), `#!/bin/sh\ncat >/dev/null\nprintf '%s' '${body}'\n`); chmodSync(join(curlBin, 'curl'), 0o755) }
  const env = { PATH: `${curlBin}:${bin}:${process.env.PATH}`, HOME: tmp, WT_READY_TIMEOUT: '0', WT_SUBMIT_SETTLE_MS: '0', WT_HANDOFF_JEV: 'off', HERDR_PANE_ID: 'wW:p5' }
  const reply = () => { const before = readFileSync(log, 'utf8').length; const out = execFileSync(join(here, 'handoff.sh'), ['--reply', 'wW:p7', 'hi'], { encoding: 'utf8', env }); return [out, readFileSync(log, 'utf8').slice(before)] }
  stub('{"queued":true,"id":"x"}')
  let [out, calls] = reply()
  assert.match(out, /replied wW:p7 \(queued\)/)
  assert.doesNotMatch(calls, /agent prompt wW:p7/)
  stub('{"queued":false}')
  ;[out, calls] = reply()
  assert.match(calls, /agent prompt wW:p7 .*<wt-message/)
  writeFileSync(join(curlBin, 'curl'), '#!/bin/sh\nexit 7\n') // dashboard down
  ;[out, calls] = reply()
  assert.match(calls, /agent prompt wW:p7 /)
})

test('WP-225: an agent whose task token names an open card, or that is the assignee of one, is not a free candidate', () => {
  const curlBin = join(tmp, 'curlbin225')
  mkdirSync(curlBin, { recursive: true })
  writeFileSync(join(curlBin, 'curl'), `#!/bin/sh
for a in "$@"; do url=$a; done
case "$url" in
  *"/api/tickets/keys"*) printf 'WP\\n200' ;;
  *"/api/tickets"*) printf '%s\\n200' '{"tickets":[{"id":"WP-1","column":"building","assignee":{"name":"demo-worker-02"}},{"id":"WP-2","column":"done","assignee":{"name":"demo-worker-03"}}]}' ;;
  *) printf '{}\\n404' ;;
esac
`)
  chmodSync(join(curlBin, 'curl'), 0o755)
  const agent = (n, p) => ({ name: n, pane_id: p, tab_id: 't1', agent_status: 'idle', workspace_id: 'wW', cwd: repo })
  writeFileSync(join(tmp, 'agents.json'), JSON.stringify({ result: { agents: [agent('demo-worker-01', 'wW:p1'), agent('demo-worker-02', 'wW:p2'), agent('demo-worker-03', 'wW:p3'), agent('demo-worker-04', 'wW:p4')] } }))
  writeFileSync(join(tmp, 'panes.json'), JSON.stringify({ result: { panes: [
    { pane_id: 'wW:p1', tokens: { task: 'WP-1 still on it' } }, { pane_id: 'wW:p3', tokens: { task: 'WP-2 finished' } }, { pane_id: 'wW:p4', tokens: {} }] } }))
  const env = { PATH: `${curlBin}:${bin}:${process.env.PATH}`, HOME: tmp, WT_READY_TIMEOUT: '0', WT_SUBMIT_SETTLE_MS: '0', WT_HANDOFF_JEV: 'off' }
  const list = execFileSync(join(here, 'handoff.sh'), ['--list', repo], { input: '', encoding: 'utf8', env })
  assert.ok(!list.includes('wW:p1') && !list.includes('wW:p2'), list) // token names open WP-1; assignee of WP-1
  assert.ok(list.includes('wW:p3') && list.includes('wW:p4'), list) // WP-2 is done; no token, no card
  writeFileSync(join(tmp, 'panes.json'), '{"result":{"panes":[]}}')
  writeFileSync(join(tmp, 'agents.json'), '{"result":{"agents":[]}}')
})

test('WP-272: no /goal by default (typed short line naming the file); --goal arms one; --no-goal is the default; an unwritable file pastes with a warning', () => {
  writeFileSync(join(tmp, 'panes.json'), JSON.stringify({ result: { panes: [] } }))
  writeFileSync(join(tmp, 'agents.json'), JSON.stringify({ result: { agents: [
    { name: 'demo-worker-09', pane_id: 'wW:p9', tab_id: 't9', agent_status: 'idle', workspace_id: 'wW', cwd: repo }] } }))
  for (const flags of [[], ['--no-goal']]) {
    writeFileSync(log, '')
    run(['--role', 'worker', '--pane', 'wW:p9', ...flags, repo], 'do the thing')
    const calls = readFileSync(log, 'utf8')
    const file = calls.match(/^herdr pane send-text wW:p9 Do the task in (\S+\.md), then report with handoff\.sh --reply$/m)?.[1]
    assert.ok(file, calls) // no /goal; one short typed line naming the message file; nothing pasted
    assert.match(readFileSync(file, 'utf8'), /^<wt-message id=\w+ kind=handoff[^>]*>[\s\S]*do the thing/)
    assert.equal(statSync(file).mode & 0o777, 0o600)
    assert.match(calls, /^herdr pane send-keys wW:p9 enter/m)
    assert.doesNotMatch(calls, /agent prompt|\/goal|send-text .*<wt-message/)
  }
  writeFileSync(log, '')
  run(['--role', 'worker', '--pane', 'wW:p9', '--task', 'WP-5 x', '--goal', repo], 'do the thing')
  let calls = readFileSync(log, 'utf8')
  const gfile = calls.match(/^herdr pane send-text wW:p9 \/goal WP-5: do the task in (\S+\.md); reporting what it asks for is the goal$/m)?.[1]
  assert.ok(gfile, calls)
  assert.doesNotMatch(calls, /agent prompt/)
  // the file cannot be written: the full message is pasted, and the script says why
  const blocker = join(tmp, 'not-a-dir'); writeFileSync(blocker, '')
  writeFileSync(log, '')
  const r = spawnSync(join(here, 'handoff.sh'), ['--role', 'worker', '--pane', 'wW:p9', repo], { input: 'do the thing', encoding: 'utf8',
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: tmp, WT_READY_TIMEOUT: '0', WT_SUBMIT_SETTLE_MS: '0', WT_HANDOFF_JEV: 'off', WT_MESSAGES_DIR: join(blocker, 'x') } })
  assert.match(r.stderr, /warning: could not type the short line/)
  assert.match(readFileSync(log, 'utf8'), /^herdr agent prompt wW:p9 /m)
})

test('WP-272: with the target\'s mod live the message is queued first; typed once only if it is not pulled in time', () => {
  writeFileSync(join(tmp, 'agents.json'), JSON.stringify({ result: { agents: [
    { name: 'demo-worker-09', pane_id: 'wW:p9', tab_id: 't9', agent_status: 'idle', workspace_id: 'wW', cwd: repo }] } }))
  const curlBin = join(tmp, 'curlbin272'); mkdirSync(curlBin, { recursive: true })
  const curlLog = join(tmp, 'curl272.log')
  writeFileSync(join(curlBin, 'curl'), `#!/bin/sh
echo "$*" >> ${curlLog}
for a in "$@"; do url=$a; done
case "$url" in
  */api/deliveries) echo '{"queued":true,"id":"q1"}' ;;
  */api/deliveries/q1/cancel) echo "{\\"cancelled\\":true}" ;;
  */api/deliveries/q1) echo "{\\"status\\":\\"$(cat ${tmp}/q1-status)\\"}" ;;
  *) echo '{}' ;;
esac
`)
  chmodSync(join(curlBin, 'curl'), 0o755)
  const env = { PATH: `${curlBin}:${bin}:${process.env.PATH}`, HOME: tmp, HERDR_PANE_ID: 'wS:p1', WT_READY_TIMEOUT: '0', WT_SUBMIT_SETTLE_MS: '0', WT_HANDOFF_JEV: 'off', WT_PULL_WAIT_S: '1' }
  const go = () => execFileSync(join(here, 'handoff.sh'), ['--role', 'worker', '--pane', 'wW:p9', repo], { input: 'do the thing', encoding: 'utf8', env })
  writeFileSync(join(tmp, 'q1-status'), 'delivered'); writeFileSync(log, ''); writeFileSync(curlLog, '')
  go()
  assert.doesNotMatch(readFileSync(log, 'utf8'), /send-text|agent prompt/) // the mod pulled it: nothing typed
  assert.doesNotMatch(readFileSync(curlLog, 'utf8'), /cancel/)
  writeFileSync(join(tmp, 'q1-status'), 'queued'); writeFileSync(log, ''); writeFileSync(curlLog, '')
  go()
  assert.equal((readFileSync(log, 'utf8').match(/send-text wW:p9 Do the task in /g) ?? []).length, 1) // not pulled: cancelled, typed once
  assert.match(readFileSync(curlLog, 'utf8'), /deliveries\/q1\/cancel/)
  writeFileSync(join(tmp, 'agents.json'), '{"result":{"agents":[]}}')
})

test('WP-238: --team picks only that team\'s agents (a plain handoff skips them), spawns cap at the roster', () => {
  mkdirSync(join(repo, '.wt-pack', 'teams'), { recursive: true })
  writeFileSync(join(repo, '.wt-pack', 'teams', 'web.md'), '---\ndescription: t\nmembers: [worker x1]\nstages: [build=worker]\n---\n')
  writeFileSync(join(tmp, 'agents.json'), JSON.stringify({ result: { agents: [
    { name: 'demo-worker-01', pane_id: 'wW:p1', tab_id: 't1', agent_status: 'idle', workspace_id: 'wW', cwd: repo },
    { name: 'demo-worker-02', pane_id: 'wW:p2', tab_id: 't2', agent_status: 'idle', workspace_id: 'wW', cwd: repo }] } }))
  writeFileSync(join(tmp, 'panes.json'), JSON.stringify({ result: { panes: [
    { pane_id: 'wW:p1', tokens: {} }, { pane_id: 'wW:p2', tokens: { team: 'web', role: 'worker' } }] } }))
  const list = (extra) => run(['--list', ...extra, repo]).trim().split('\n').filter(Boolean).map((l) => l.split('\t')[0])
  assert.deepEqual(list([]), ['wW:p1'])
  assert.deepEqual(list(['--team', 'web']), ['wW:p2'])
  // the team's one worker seat is taken (p2 is busy): a spawn would exceed the roster → exit 3
  writeFileSync(join(tmp, 'agents.json'), JSON.stringify({ result: { agents: [
    { name: 'demo-worker-02', pane_id: 'wW:p2', tab_id: 't2', agent_status: 'working', workspace_id: 'wW', cwd: repo }] } }))
  assert.throws(() => run(['--role', 'worker', '--team', 'web', repo], 'x'), (e) => e.status === 3 && /team full: 1\/1 worker in web/.test(e.stderr)) // exits before any spawn or send
  assert.match(run(['--role', 'worker', '--team', 'web', '--dry-run', repo], 'x'), /^dry-run: team full: 1\/1 worker in web/)
  assert.throws(() => run(['--role', 'reviewer', '--team', 'web', '--dry-run', repo], 'x'), (e) => e.status === 2 && /team web has no reviewer member/.test(e.stderr))
})

test('WP-247: team workers do not count against the plain pool cap; --pane refuses a card of another team (and teamless vs team)', () => {
  const agent = (n, st = 'working') => ({ name: `demo-worker-0${n}`, pane_id: `wW:p${n}`, tab_id: `t${n}`, agent_status: st, workspace_id: 'wW', cwd: repo })
  writeFileSync(join(tmp, 'agents.json'), JSON.stringify({ result: { agents: [agent(1), agent(2), agent(3)] } }))
  writeFileSync(join(tmp, 'panes.json'), JSON.stringify({ result: { panes: [
    { pane_id: 'wW:p1', tokens: {} }, { pane_id: 'wW:p2', tokens: { team: 'web', role: 'worker' } }, { pane_id: 'wW:p3', tokens: { team: 'web', role: 'worker' } }] } }))
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: tmp, WT_READY_TIMEOUT: '0', WT_SUBMIT_SETTLE_MS: '0', WT_HANDOFF_JEV: 'off', WT_WORKERS_MAX: '2' }
  const plain = execFileSync(join(here, 'handoff.sh'), ['--role', 'worker', '--no-goal', '--dry-run', repo], { input: 'x', encoding: 'utf8', env })
  assert.match(plain, /^dry-run: would spawn a worker/) // 1 teamless of 2, not 3 of 2
  assert.match(execFileSync(join(here, 'handoff.sh'), ['--role', 'worker', '--no-goal', '--dry-run', repo], { input: 'x', encoding: 'utf8', env: { ...env, WT_WORKERS_MAX: '1' } }), /pool full: 1\/1 plain/) // p1 still counts

  const curlBin = join(tmp, 'curlbin247')
  mkdirSync(curlBin, { recursive: true })
  writeFileSync(join(curlBin, 'curl'), `#!/bin/sh
for a in "$@"; do url=$a; done
case "$url" in
  *"/api/tickets/keys"*) printf 'WP\\n200' ;;
  *"/api/tickets/WP-11"*) printf '%s\\n200' '{"id":"WP-11","team":"web"}' ;;
  *"/api/tickets/WP-12"*) printf '%s\\n200' '{"id":"WP-12","team":"api"}' ;;
  *"/api/tickets/WP-13"*) printf '%s\\n200' '{"id":"WP-13"}' ;;
  *) printf '{}\\n404' ;;
esac
`)
  chmodSync(join(curlBin, 'curl'), 0o755)
  const tenv = { ...env, PATH: `${curlBin}:${bin}:${process.env.PATH}` }
  writeFileSync(join(tmp, 'pane-wW_p2.json'), JSON.stringify({ result: { pane: { tokens: { team: 'web', role: 'worker' } } } }))
  writeFileSync(join(tmp, 'pane-wW_p1.json'), JSON.stringify({ result: { pane: { tokens: {} } } }))
  const to = (pane, task, dry = false) => { try { return { code: 0, out: execFileSync(join(here, 'handoff.sh'), ['--no-goal', ...(dry ? ['--dry-run'] : []), '--pane', pane, '--task', `${task} go`, repo], { input: 'x', encoding: 'utf8', env: tenv }) } } catch (e) { return { code: e.status, out: `${e.stdout}${e.stderr}` } } }
  assert.match(to('wW:p2', 'WP-11', true).out, /would hand to pane wW:p2/)                                   // own team's card
  const other = to('wW:p2', 'WP-12'); assert.equal(other.code, 2); assert.match(to('wW:p2', 'WP-12', true).out, /^dry-run: demo-worker-02 is on team web/); assert.match(other.out, /demo-worker-02 is on team web; WP-12 is team api's/)
  assert.match(to('wW:p2', 'WP-13').out, /demo-worker-02 is on team web; WP-13 is teamless/) // team agent, teamless card
  assert.match(to('wW:p1', 'WP-11').out, /demo-worker-01 is not on a team; WP-11 is team web's/) // teamless agent, team card
  assert.match(to('wW:p1', 'WP-13', true).out, /would hand to pane wW:p1/)                                   // teamless both
  writeFileSync(join(tmp, 'panes.json'), '{"result":{"panes":[]}}')
  writeFileSync(join(tmp, 'agents.json'), '{"result":{"agents":[]}}')
})

test('WP-249: a reused agent missing from agent list is renamed to its tab label before typing', () => {
  writeFileSync(join(tmp, 'agents.json'), '{"result":{"agents":[]}}')
  writeFileSync(join(tmp, 'pane-wW_p7.json'), JSON.stringify({ result: { pane: { pane_id: 'wW:p7', tab_id: 'wW:t7', tokens: {} } } }))
  writeFileSync(join(tmp, 'tabs.json'), JSON.stringify({ result: { tabs: [{ tab_id: 'wW:t7', label: 'demo-worker-07' }] } }))
  writeFileSync(log, '')
  run(['--role', 'worker', '--pane', 'wW:p7', repo], 'do the thing')
  const calls = readFileSync(log, 'utf8')
  assert.match(calls, /^herdr agent rename wW:p7 demo-worker-07$/m)
  assert.ok(calls.indexOf('agent rename') < calls.indexOf('send-text'), calls)
  writeFileSync(log, '')
  writeFileSync(join(tmp, 'agents.json'), JSON.stringify({ result: { agents: [{ name: 'demo-worker-07', pane_id: 'wW:p7', tab_id: 'wW:t7', agent_status: 'idle', workspace_id: 'wW', cwd: repo }] } }))
  run(['--role', 'worker', '--pane', 'wW:p7', repo], 'do the thing')
  assert.doesNotMatch(readFileSync(log, 'utf8'), /agent rename/) // registered: left alone
})

test('WP-251: --request-id sends once; a repeat returns the first output, a different id sends again', () => {
  writeFileSync(join(tmp, 'agents.json'), JSON.stringify({ result: { agents: [{ name: 'demo-worker-07', pane_id: 'wW:p7', tab_id: 'wW:t7', agent_status: 'idle', workspace_id: 'wW', cwd: repo }] } }))
  const sends = () => (readFileSync(log, 'utf8').match(/send-text/g) ?? []).length
  const go = (id) => run(['--role', 'worker', '--pane', 'wW:p7', '--request-id', id, repo], 'do the thing')
  writeFileSync(log, '')
  const first = go('req-1')
  assert.equal(sends(), 1)
  assert.equal(go('req-1'), first)
  assert.equal(sends(), 1)
  go('req-2')
  assert.equal(sends(), 2)
})

test('WP-257: --reply records the envelope at /api/messages; --ack posts the state to /api/messages/<id>/ack', () => {
  const curlBin = join(tmp, 'curlbin257')
  const calls = join(tmp, 'curl257.log')
  mkdirSync(curlBin, { recursive: true })
  writeFileSync(calls, '')
  writeFileSync(join(curlBin, 'curl'), `#!/bin/sh\necho "$@" >> ${calls}\ncat >> ${calls}\nprintf '%s' '{"queued":true,"id":"m1","state":"acknowledged"}'\n`)
  chmodSync(join(curlBin, 'curl'), 0o755)
  const env = { PATH: `${curlBin}:${bin}:${process.env.PATH}`, HOME: tmp, WT_READY_TIMEOUT: '0', WT_SUBMIT_SETTLE_MS: '0', WT_HANDOFF_JEV: 'off', HERDR_PANE_ID: 'wW:p5' }
  execFileSync(join(here, 'handoff.sh'), ['--reply', 'wW:p7', 'hi'], { encoding: 'utf8', env })
  const log257 = readFileSync(calls, 'utf8')
  assert.match(log257, /\/api\/messages/)
  assert.match(log257, /"state": "queued"/)
  const out = execFileSync(join(here, 'handoff.sh'), ['--ack', 'ab12', '--answered'], { encoding: 'utf8', env })
  assert.match(out, /m1 acknowledged/)
  assert.match(readFileSync(calls, "utf8"), /"state": "answered"[\s\S]*\/api\/messages\/ab12\/ack/)
  assert.throws(() => execFileSync(join(here, 'handoff.sh'), ['--ack', 'a b'], { env, stdio: 'pipe' }), (e) => e.status === 2)
})
