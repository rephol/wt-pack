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
  // WP-157: a local read-only rule would pick haiku, but handoff routes a SESSION's own tier (--session),
  // which never lands below sonnet — this local task is a read-only rule, so effort drops one level too.
  assert.match(out, /routing: sonnet \(shadow, local\+session-floor, ref [a-z0-9]+#0\)/)
  out = execFileSync(join(here, 'handoff.sh'), ['--role', 'reviewer', '--no-goal', '--dry-run', repo], { input: 'list the open PRs', encoding: 'utf8',
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: tmp, WT_HANDOFF_JEV: 'off', WT_MODEL_ROUTING: 'live' } })
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
  env: { PATH: `${bin}:${process.env.PATH}`, HOME: tmp, HERDR_DASH_URL: 'http://127.0.0.1:1' } })

test('WP-143: live routing reuses a free worker already on the routed tier/effort; a different tier or effort spawns fresh', () => {
  const liveEnv = { PATH: `${bin}:${process.env.PATH}`, HOME: tmp, WT_HANDOFF_JEV: 'off', WT_MODEL_ROUTING: 'live' }
  // WP-157: --session floors this local read-only pick to sonnet/low (never haiku for a session's own tier)
  writeFileSync(join(tmp, 'panes.json'), JSON.stringify({ result: { panes: [
    { pane_id: 'wW:p1', tokens: { model: 'sonnet', effort: 'low' } }] } }))
  writeFileSync(join(tmp, 'agents.json'), JSON.stringify({ result: { agents: [
    { name: 'demo-worker-01', pane_id: 'wW:p1', tab_id: 't1', agent_status: 'idle', workspace_id: 'wW', cwd: repo }] } }))
  let out = execFileSync(join(here, 'handoff.sh'), ['--role', 'worker', '--no-goal', '--dry-run', repo], { input: 'list the open PRs', encoding: 'utf8', env: liveEnv })
  assert.match(out, /would reuse worker demo-worker-01 \(wW:p1\) \(model sonnet\)/) // routed dry-run wording (plan Unit 2)
  execFileSync(join(here, 'handoff.sh'), ['--role', 'worker', '--no-goal', repo], { input: 'list the open PRs', encoding: 'utf8', env: liveEnv })
  let calls = readFileSync(log, 'utf8')
  assert.match(calls, /^herdr agent prompt wW:p1 /m)
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
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: tmp, WT_HANDOFF_JEV: 'off', WT_WORKERS_MAX: '1' }
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
  const env = { PATH: `${curlBin}:${bin}:${process.env.PATH}`, HOME: tmp, WT_HANDOFF_JEV: 'off' }
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
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: tmp, WT_HANDOFF_JEV: 'off', WT_WORKERS_MAX: '1' }
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
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: tmp, WT_HANDOFF_JEV: 'off', WT_WORKERS_MAX: '1' }
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
  const env = { PATH: `${curlBin}:${bin}:${process.env.PATH}`, HOME: tmp, WT_HANDOFF_JEV: 'off', HERDR_PANE_ID: 'wW:p5' }
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
  const env = { PATH: `${curlBin}:${bin}:${process.env.PATH}`, HOME: tmp, WT_HANDOFF_JEV: 'off' }
  const list = execFileSync(join(here, 'handoff.sh'), ['--list', repo], { input: '', encoding: 'utf8', env })
  assert.ok(!list.includes('wW:p1') && !list.includes('wW:p2'), list) // token names open WP-1; assignee of WP-1
  assert.ok(list.includes('wW:p3') && list.includes('wW:p4'), list) // WP-2 is done; no token, no card
  writeFileSync(join(tmp, 'panes.json'), '{"result":{"panes":[]}}')
  writeFileSync(join(tmp, 'agents.json'), '{"result":{"agents":[]}}')
})

test('WP-240: a /goal handoff is typed (send-text + Enter), not pasted via agent prompt; --no-goal still pastes', () => {
  writeFileSync(join(tmp, 'panes.json'), JSON.stringify({ result: { panes: [] } }))
  writeFileSync(join(tmp, 'agents.json'), JSON.stringify({ result: { agents: [
    { name: 'demo-worker-09', pane_id: 'wW:p9', tab_id: 't9', agent_status: 'idle', workspace_id: 'wW', cwd: repo }] } }))
  writeFileSync(log, '')
  run(['--role', 'worker', '--pane', 'wW:p9', repo], 'do the thing')
  let calls = readFileSync(log, 'utf8')
  assert.match(calls, /^herdr pane send-text wW:p9 \/goal finish the wt-message that follows/m)
  assert.match(calls, /^herdr agent prompt wW:p9 <wt-message/m) // the message itself: a normal prompt (no mod queue in the test), never typed
  assert.match(calls, /^herdr pane send-keys wW:p9 enter/m)
  assert.doesNotMatch(calls, /agent prompt wW:p9 \/goal|send-text .*<wt-message/)
  writeFileSync(log, '')
  run(['--role', 'worker', '--pane', 'wW:p9', '--no-goal', repo], 'do the thing')
  calls = readFileSync(log, 'utf8')
  assert.match(calls, /^herdr agent prompt wW:p9 /m)
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

test('WP-242: a server-run handoff (no pane id, WT_DELIVER_TOKEN) queues the message with x-wt-server and does not paste it', async () => {
  const { createServer } = await import('node:http'); const { execFile } = await import('node:child_process'); const { promisify } = await import('node:util')
  const seen = []
  const srv = createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { if (req.url === '/api/deliveries') seen.push({ h: req.headers, b: JSON.parse(b) }); res.end(req.url === '/api/deliveries' ? '{"queued":true}' : '{}') }) })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  writeFileSync(join(tmp, 'panes.json'), JSON.stringify({ result: { panes: [] } }))
  writeFileSync(join(tmp, 'agents.json'), JSON.stringify({ result: { agents: [
    { name: 'demo-worker-09', pane_id: 'wW:p9', tab_id: 't9', agent_status: 'idle', workspace_id: 'wW', cwd: repo }] } }))
  writeFileSync(log, '')
  const p = promisify(execFile)(join(here, 'handoff.sh'), ['--role', 'worker', '--pane', 'wW:p9', repo], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: tmp, HERDR_PANE_ID: '', WT_DELIVER_TOKEN: 'tok', HERDR_DASH_URL: `http://127.0.0.1:${srv.address().port}` } })
  p.child.stdin.end('do the thing'); await p
  srv.close()
  assert.equal(seen.length, 1); assert.equal(seen[0].h['x-wt-server'], 'tok'); assert.match(seen[0].b.text, /^<wt-message/)
  const calls = readFileSync(log, 'utf8')
  assert.match(calls, /send-text wW:p9 \/goal finish/); assert.doesNotMatch(calls, /agent prompt wW:p9/)
})
