// Run: node --test skills/wt-handoff/scripts/handoff.test.mjs — handoff.sh against a stub herdr.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, chmodSync, readFileSync, realpathSync, statSync, rmSync } from 'node:fs'
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
  "pane send-text") [ -z "$WT_FAIL_SEND_TEXT" ] || exit 1 ;;
  "tab get") echo '{"result":{"tab":{"label":"r"}}}' ;;
  "pane get") cat "${tmp}/pane-$(echo "$3" | tr : _).json" 2>/dev/null || echo '{"result":{"pane":{"tokens":{}}}}' ;;
  "agent prompt") case " $* " in *" --wait "*) [ -f "${tmp}/goal-clear-fails" ] && exit 1 || exit 0 ;; esac ;;
  *) echo '{"result":{}}' ;;
esac\n`)
chmodSync(join(bin, 'herdr'), 0o755)
execFileSync('git', ['-C', repo, 'init', '-q'])
mkdirSync(join(tmp, '.local', 'share', 'wt-dashboard'), { recursive: true }) // WP-334: HOME = tmp, so the repo's role files need a trust entry here
writeFileSync(join(tmp, '.local', 'share', 'wt-dashboard', 'trusted-projects.json'), JSON.stringify({ demo: repo }))
const run = (args, input = 'review it') => execFileSync(join(here, 'handoff.sh'), args, { input, encoding: 'utf8',
  env: { PATH: `${bin}:${process.env.PATH}`, HOME: tmp, HERDR_DASH_URL: 'http://127.0.0.1:9', WT_READY_TIMEOUT: '0', WT_SUBMIT_SETTLE_MS: '0', WT_HANDOFF_JEV: 'off' } })

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
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: tmp, HERDR_DASH_URL: 'http://127.0.0.1:9', WT_READY_TIMEOUT: '0', WT_SUBMIT_SETTLE_MS: '0', WT_HANDOFF_JEV: 'off', WT_MODEL_ROUTING: 'live' } })
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
  const liveEnv = { PATH: `${bin}:${process.env.PATH}`, HOME: tmp, HERDR_DASH_URL: 'http://127.0.0.1:9', WT_READY_TIMEOUT: '0', WT_SUBMIT_SETTLE_MS: '0', WT_HANDOFF_JEV: 'off', WT_MODEL_ROUTING: 'live' }
  // WP-157: --session floors this local read-only pick to sonnet/low (never haiku for a session's own tier)
  writeFileSync(join(tmp, 'panes.json'), JSON.stringify({ result: { panes: [
    { pane_id: 'wW:p1', tokens: { model: 'sonnet', effort: 'low' } }] } }))
  writeFileSync(join(tmp, 'agents.json'), JSON.stringify({ result: { agents: [
    { name: 'demo-worker-01', pane_id: 'wW:p1', tab_id: 't1', agent_status: 'idle', workspace_id: 'wW', cwd: repo }] } }))
  let out = execFileSync(join(here, 'handoff.sh'), ['--role', 'worker', '--no-goal', '--dry-run', repo], { input: 'list the open PRs', encoding: 'utf8', env: liveEnv })
  assert.match(out, /would reuse worker demo-worker-01 \(wW:p1\) \(model sonnet\)/) // routed dry-run wording (plan Unit 2)
  execFileSync(join(here, 'handoff.sh'), ['--role', 'worker', '--no-goal', repo], { input: 'list the open PRs', encoding: 'utf8', env: liveEnv })
  let calls = readFileSync(log, 'utf8')
  assert.match(calls, /^herdr pane send-text wW:p1 <wt-message id=\w+ kind=handoff from="[^"]*">Read it with: wt-message show \w+<\/wt-message>$/m) // WP-352: the recorded pointer, not 'Do the task in'
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
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: tmp, HERDR_DASH_URL: 'http://127.0.0.1:9', WT_READY_TIMEOUT: '0', WT_SUBMIT_SETTLE_MS: '0', WT_HANDOFF_JEV: 'off', WT_WORKERS_MAX: '1' }
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
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: tmp, HERDR_DASH_URL: 'http://127.0.0.1:9' } }) } catch (e) { threw = e }
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
  const env = { PATH: `${curlBin}:${bin}:${process.env.PATH}`, HOME: tmp, HERDR_DASH_URL: 'http://127.0.0.1:9', WT_READY_TIMEOUT: '0', WT_SUBMIT_SETTLE_MS: '0', WT_HANDOFF_JEV: 'off' }
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
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: tmp, HERDR_DASH_URL: 'http://127.0.0.1:9', WT_READY_TIMEOUT: '0', WT_SUBMIT_SETTLE_MS: '0', WT_HANDOFF_JEV: 'off', WT_WORKERS_MAX: '1' }
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
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: tmp, HERDR_DASH_URL: 'http://127.0.0.1:9', WT_READY_TIMEOUT: '0', WT_SUBMIT_SETTLE_MS: '0', WT_HANDOFF_JEV: 'off', WT_WORKERS_MAX: '1' }
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
  const env = { PATH: `${curlBin}:${bin}:${process.env.PATH}`, HOME: tmp, HERDR_DASH_URL: 'http://127.0.0.1:9', WT_READY_TIMEOUT: '0', WT_SUBMIT_SETTLE_MS: '0', WT_HANDOFF_JEV: 'off', HERDR_PANE_ID: 'wW:p5' }
  const reply = () => { const before = readFileSync(log, 'utf8').length; const out = execFileSync(join(here, 'handoff.sh'), ['--reply', 'wW:p7', 'hi'], { encoding: 'utf8', env }); return [out, readFileSync(log, 'utf8').slice(before)] }
  const T = '<wt-message id=srv210 kind=reply from="s">hi</wt-message>'
  stub(JSON.stringify({ queued: true, id: 'x', text: T }))
  let [out, calls] = reply()
  assert.match(out, /replied wW:p7 \(queued\)/)
  assert.doesNotMatch(calls, /agent prompt wW:p7/)
  stub(JSON.stringify({ queued: false, text: T }))
  ;[out, calls] = reply()
  assert.match(calls, /agent prompt wW:p7 .*id=srv210/)
})

// WP-340: a pane sender never wraps locally. A failed post is retried, then fails loudly with nothing pasted;
// a retry that succeeds pastes the dashboard's recorded envelope; a refusal is not retried.
test('WP-340: pane_post retries, then fails loudly without a local wrap; a refusal is not retried; a retry sends the recorded text', () => {
  const curlBin = join(tmp, 'curlbin340'), count = join(tmp, 'curl340.count'); mkdirSync(curlBin, { recursive: true })
  const T = '<wt-message id=rec340 kind=reply from="s">hi</wt-message>'
  const stub = (script) => { writeFileSync(count, ''); writeFileSync(join(curlBin, 'curl'), `#!/bin/sh\ncat >/dev/null\necho x >> ${count}\n${script}\n`); chmodSync(join(curlBin, 'curl'), 0o755) }
  const env = { PATH: `${curlBin}:${bin}:${process.env.PATH}`, HOME: tmp, HERDR_DASH_URL: 'http://127.0.0.1:9', WT_READY_TIMEOUT: '0', WT_SUBMIT_SETTLE_MS: '0', WT_HANDOFF_JEV: 'off', HERDR_PANE_ID: 'wW:p5', WT_POST_TRIES: '3', WT_POST_RETRY_S: '0' }
  const go = (extra = []) => { const before = readFileSync(log, 'utf8').length; const r = spawnSync(join(here, 'handoff.sh'), ['--reply', 'wW:p7', ...extra, 'hi'], { encoding: 'utf8', env }); return [r, readFileSync(log, 'utf8').slice(before)] }
  const tries = () => readFileSync(count, 'utf8').trim().split('\n').filter(Boolean).length
  stub('exit 28') // timeout / down: 3 tries, then loud, nothing pasted
  let [r, calls] = go(['--request-id', 'rid340'])
  assert.equal(r.status, 1); assert.equal(tries(), 3)
  assert.match(r.stderr, /did not record this message[\s\S]*retry with the same --request-id \(rid340\)/)
  assert.doesNotMatch(calls, /agent prompt wW:p7/)
  ;[r] = go(); assert.match(r.stderr, /pass one on the first try/)
  stub(`printf '%s' '{"error":"unknown pane"}'`) // the dashboard refused: one try, loud
  ;[r, calls] = go(); assert.equal(r.status, 1); assert.equal(tries(), 1); assert.match(r.stderr, /unknown pane/); assert.doesNotMatch(calls, /agent prompt/)
  stub(`[ "$(wc -l < ${count})" -lt 2 ] && exit 28; printf '%s' '${JSON.stringify({ queued: false, text: T })}'`) // first try fails, second answers
  ;[r, calls] = go(['--request-id', 'rid340']); assert.equal(r.status, 0, r.stderr); assert.equal(tries(), 2)
  assert.match(calls, /agent prompt wW:p7 .*id=rec340/) // the dashboard's recorded envelope, pasted
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
  const env = { PATH: `${curlBin}:${bin}:${process.env.PATH}`, HOME: tmp, HERDR_DASH_URL: 'http://127.0.0.1:9', WT_READY_TIMEOUT: '0', WT_SUBMIT_SETTLE_MS: '0', WT_HANDOFF_JEV: 'off' }
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
    const m = calls.match(/^herdr pane send-text wW:p9 <wt-message id=(\w+) kind=handoff from="[^"]*">Read it with: wt-message show \1<\/wt-message>$/m)
    assert.ok(m, calls) // WP-352: one typed POINTER with the recorded id; no /goal, no untagged line, nothing pasted
    const file = join(tmp, '.local', 'share', 'wt-dashboard', 'messages', `${m[1]}.md`) // the mode-600 local copy of the full message
    assert.match(readFileSync(file, 'utf8'), /^<wt-message id=\w+ kind=handoff[^>]*>[\s\S]*do the thing/)
    assert.equal(statSync(file).mode & 0o777, 0o600)
    assert.match(calls, /^herdr pane send-keys wW:p9 enter/m)
    assert.doesNotMatch(calls, /agent prompt|\/goal|Do the task in|do the thing/)
  }
  writeFileSync(log, '')
  // the ticket prefix needs a known key; a Linear team in HOME's env file supplies one without the live dashboard (WP-348: the run is pinned to a closed port)
  mkdirSync(join(tmp, '.config', 'wt-dashboard'), { recursive: true }); writeFileSync(join(tmp, '.config', 'wt-dashboard', 'env'), 'WT_LINEAR_TEAMS=WP\n')
  run(['--role', 'worker', '--pane', 'wW:p9', '--task', 'WP-5 x', '--goal', repo], 'do the thing')
  rmSync(join(tmp, '.config', 'wt-dashboard', 'env'))
  let calls = readFileSync(log, 'utf8')
  assert.match(calls, /^herdr pane send-text wW:p9 \/goal <wt-message id=\w+ kind=handoff from="[^"]*" ticket=WP-5>Read it with: wt-message show \w+<\/wt-message>$/m, calls)
  assert.doesNotMatch(calls, /agent prompt|Do the task in|do the thing/)
  // send-text fails: the same pointer is pasted instead, and the script says why
  writeFileSync(log, '')
  const r = spawnSync(join(here, 'handoff.sh'), ['--role', 'worker', '--pane', 'wW:p9', repo], { input: 'do the thing', encoding: 'utf8',
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: tmp, HERDR_DASH_URL: 'http://127.0.0.1:9', WT_READY_TIMEOUT: '0', WT_SUBMIT_SETTLE_MS: '0', WT_HANDOFF_JEV: 'off', WT_FAIL_SEND_TEXT: '1' } })
  assert.match(r.stderr, /could not type the pointer/)
  assert.match(readFileSync(log, 'utf8'), /^herdr agent prompt wW:p9 <wt-message id=\w+ kind=handoff[^>]*>Read it with: wt-message show \w+<\/wt-message>$/m)
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
  */api/deliveries) echo '{"queued":true,"id":"q1","text":"<wt-message id=srv272 kind=handoff from=\\"s\\">x</wt-message>"}' ;;
  */api/deliveries/q1/cancel) echo "{\\"cancelled\\":true}" ;;
  */api/deliveries/q1) echo "{\\"status\\":\\"$(cat ${tmp}/q1-status)\\"}" ;;
  *) echo '{}' ;;
esac
`)
  chmodSync(join(curlBin, 'curl'), 0o755)
  const env = { PATH: `${curlBin}:${bin}:${process.env.PATH}`, HOME: tmp, HERDR_DASH_URL: 'http://127.0.0.1:9', HERDR_PANE_ID: 'wS:p1', WT_READY_TIMEOUT: '0', WT_SUBMIT_SETTLE_MS: '0', WT_HANDOFF_JEV: 'off', WT_PULL_WAIT_S: '1' }
  const go = () => execFileSync(join(here, 'handoff.sh'), ['--role', 'worker', '--pane', 'wW:p9', repo], { input: 'do the thing', encoding: 'utf8', env })
  writeFileSync(join(tmp, 'q1-status'), 'delivered'); writeFileSync(log, ''); writeFileSync(curlLog, '')
  go()
  assert.doesNotMatch(readFileSync(log, 'utf8'), /send-text|agent prompt/) // the mod pulled it: nothing typed
  assert.doesNotMatch(readFileSync(curlLog, 'utf8'), /cancel/)
  writeFileSync(join(tmp, 'q1-status'), 'queued'); writeFileSync(log, ''); writeFileSync(curlLog, '')
  go()
  assert.equal((readFileSync(log, 'utf8').match(/send-text wW:p9 <wt-message id=srv272 kind=handoff from="s">Read it with: wt-message show srv272<\/wt-message>/g) ?? []).length, 1) // not pulled: cancelled, typed once, as the pointer
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
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: tmp, HERDR_DASH_URL: 'http://127.0.0.1:9', WT_READY_TIMEOUT: '0', WT_SUBMIT_SETTLE_MS: '0', WT_HANDOFF_JEV: 'off', WT_WORKERS_MAX: '2' }
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
  const env = { PATH: `${curlBin}:${bin}:${process.env.PATH}`, HOME: tmp, HERDR_DASH_URL: 'http://127.0.0.1:9', WT_READY_TIMEOUT: '0', WT_SUBMIT_SETTLE_MS: '0', WT_HANDOFF_JEV: 'off', WT_DELIVER_TOKEN: 'tok' } // a server-token sender records its own envelope (a pane's is recorded by the dashboard)
  execFileSync(join(here, 'handoff.sh'), ['--reply', 'wW:p7', 'hi'], { encoding: 'utf8', env })
  const log257 = readFileSync(calls, 'utf8')
  assert.match(log257, /\/api\/messages/)
  assert.match(log257, /"state": "delivered"/)
  const out = execFileSync(join(here, 'handoff.sh'), ['--ack', 'ab12', '--answered'], { encoding: 'utf8', env: { ...env, HERDR_PANE_ID: 'wW:p5' } })
  assert.match(out, /m1 acknowledged/)
  assert.match(readFileSync(calls, "utf8"), /"state": "answered"[\s\S]*\/api\/messages\/ab12\/ack/)
  assert.throws(() => execFileSync(join(here, 'handoff.sh'), ['--ack', 'a b'], { env, stdio: 'pipe' }), (e) => e.status === 2)
})

test('WP-298: --effort sets the unit tier/effort in any mode (low → haiku, medium → sonnet, high → no cap); none leaves a plain worker unforced', () => {
  writeFileSync(join(tmp, 'agents.json'), '{"result":{"agents":[]}}')
  const w = (extra) => run(['--role', 'worker', '--no-goal', '--dry-run', ...extra, repo], 'implement the unit U2 per the plan')
  assert.match(w(['--effort', 'low']), /would spawn a worker in \S+ with --model haiku --effort low/)
  assert.match(w(['--effort', 'medium']), /would spawn a worker in \S+ with --model sonnet --effort medium/)
  assert.match(w(['--effort', 'high']), /would spawn a worker in \S+ --effort high/)
  assert.doesNotMatch(w(['--effort', 'high']), /--model/)
  assert.doesNotMatch(w([]), /--model|--effort/) // no unit effort: the spawn falls to agents.sh's sonnet floor
  const bad = spawnSync(join(here, 'handoff.sh'), ['--effort', 'xhigh', '--dry-run', repo], { input: 'x', encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: tmp, HERDR_DASH_URL: 'http://127.0.0.1:9' } })
  assert.equal(bad.status, 2)
})

test('WP-317: --pane and --reply take a live headless run by name, id or prefix; an ended run of the same name never wins', () => {
  const curlBin = join(tmp, 'curlbin317'), clog = join(tmp, 'curl317.log')
  mkdirSync(curlBin, { recursive: true })
  const rows = [{ id: 'hl-old1', name: 'umk-planner-01', state: 'ended' }, { id: 'hl-new2', name: 'umk-planner-01', state: 'idle' }, { id: 'hl-new3', name: 'other', state: 'working' }]
  writeFileSync(join(curlBin, 'curl'), `#!/bin/sh
body=$(cat); echo "curl $* :: $body" >> ${clog}
case " $* " in *" POST "*) case " $* " in *hl-new3/message*) printf '%s' '{"error":"the agent is queued"}' ;; *) printf '%s' '{"ok":true}' ;; esac ;; *) printf '%s' '${JSON.stringify(rows)}' ;; esac\n`)
  chmodSync(join(curlBin, 'curl'), 0o755)
  writeFileSync(join(tmp, 'pane-wW_p5.json'), '{"result":{"pane":{"pane_id":"wW:p5","tokens":{}}}}')
  writeFileSync(join(tmp, 'agents.json'), '{"result":{"agents":[{"name":"me","pane_id":"wW:p5"}]}}')
  const env = { PATH: `${curlBin}:${bin}:${process.env.PATH}`, HOME: tmp, WT_READY_TIMEOUT: '0', WT_SUBMIT_SETTLE_MS: '0', WT_HANDOFF_JEV: 'off', HERDR_PANE_ID: 'wW:p5', HERDR_DASH_URL: 'http://x' }
  const go = (args, input = 'do it') => spawnSync(join(here, 'handoff.sh'), args, { input, encoding: 'utf8', env })
  let r = go(['--pane', 'umk-planner-01', '--no-goal', '--request-id', 'r317', repo])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /reused headless umk-planner-01 \(hl-new2\)/); assert.match(r.stdout, /--reply hl-new2/)
  const calls = readFileSync(clog, 'utf8')
  assert.match(calls, /-H x-herdr-pane: wW:p5.*http:\/\/x\/api\/headless\/hl-new2\/message :: \{\s*"text": "do it/) // WP-330: plain text; the dashboard wraps it
  assert.match(calls, /To reply: \S+handoff.sh --reply wW:p5/) // the usual reply footer rides along
  assert.doesNotMatch(calls, /hl-old1\/message/)
  assert.equal(go(['--pane', 'umk-planner-01', '--no-goal', '--request-id', 'r317', repo]).stdout, r.stdout) // idempotent: a repeat sends nothing
  assert.equal(readFileSync(clog, 'utf8').split('hl-new2/message').length, 2)
  const n = (readFileSync(clog, 'utf8').match(/hl-new\d\/message/g) ?? []).length
  go(['--reply', 'hl-new', 'thanks']) // prefix matches hl-new2 and hl-new3: ambiguous, so not delivered to either (it falls through to the pane path)
  assert.equal((readFileSync(clog, 'utf8').match(/hl-new\d\/message/g) ?? []).length, n)
  r = go(['--reply', 'hl-new2', 'thanks'])
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /replied hl-new2 \(headless umk-planner-01\)/)
  assert.match(readFileSync(clog, 'utf8'), /hl-new2\/message :: \{\s*"text": "thanks"/) // WP-330: plain text, not a wt-message
  r = go(['--pane', 'other', '--no-goal', repo]); assert.equal(r.status, 1); assert.match(r.stderr, /the agent is queued/)
  assert.match(go(['--pane', 'umk-planner-01', '--no-goal', '--dry-run', repo]).stdout, /would hand to headless umk-planner-01 \(hl-new2\)/)
})

test('WP-328: a pane sender posts fields and pastes the dashboard-built envelope; --from is honoured only with the server token', () => {
  const curlBin = join(tmp, 'curlbin328'); mkdirSync(curlBin, { recursive: true })
  const posted = join(tmp, 'curl328.body')
  const srvText = '<wt-message id=srv328 kind=reply from="stamped">hi</wt-message>'
  writeFileSync(join(curlBin, 'curl'), `#!/bin/sh\ncat > ${posted}\nprintf '%s' '${JSON.stringify({ queued: false, text: srvText })}'\n`)
  chmodSync(join(curlBin, 'curl'), 0o755)
  const env = { PATH: `${curlBin}:${bin}:${process.env.PATH}`, HOME: tmp, HERDR_DASH_URL: 'http://127.0.0.1:9', WT_READY_TIMEOUT: '0', WT_SUBMIT_SETTLE_MS: '0', WT_HANDOFF_JEV: 'off', HERDR_PANE_ID: 'wW:p5' }
  const before = readFileSync(log, 'utf8').length
  const out = execFileSync(join(here, 'handoff.sh'), ['--reply', 'wW:p7', '--from', 'forger', 'hi'], { encoding: 'utf8', env })
  assert.match(out, /replied wW:p7/)
  const body = JSON.parse(readFileSync(posted, 'utf8'))
  assert.deepEqual(body, { pane: 'wW:p7', kind: 'reply', body: 'hi' }) // fields only: no envelope, no sender
  assert.match(readFileSync(log, 'utf8').slice(before), /agent prompt wW:p7 .*id=srv328 kind=reply from="stamped"/) // the server's text, not a local wrap
  // --from: ignored for an agent (note on stderr), honoured with the server's token
  const dry = (e) => spawnSync(join(here, 'handoff.sh'), ['--reply', 'wW:p7', '--from', 'forger', '--dry-run', 'hi'], { encoding: 'utf8', env: { ...env, ...e } })
  const agent = dry({})
  assert.doesNotMatch(agent.stdout, /from="forger"/); assert.match(agent.stderr, /--from is ignored/)
  assert.match(dry({ WT_DELIVER_TOKEN: 't', HERDR_PANE_ID: '' }).stdout, /from="forger"/)
})

test('WP-341: the sender is never a candidate, and a relative script path survives the cd into the main checkout', () => {
  const curlBin = join(tmp, 'curlbin341')
  mkdirSync(curlBin, { recursive: true })
  writeFileSync(join(curlBin, 'curl'), `#!/bin/sh
for a in "$@"; do url=$a; done
case "$url" in
  *"/api/tickets/keys"*) printf 'WP\\n200' ;;
  *"/api/tickets"*) printf '%s\\n200' '{"tickets":[{"id":"WP-1","column":"building","assignee":{"name":"demo-worker-02"}}]}' ;;
  *) printf '{}\\n404' ;;
esac
`)
  chmodSync(join(curlBin, 'curl'), 0o755)
  const agent = (n, p) => ({ name: n, pane_id: p, tab_id: 't1', agent_status: 'idle', workspace_id: 'wW', cwd: repo })
  writeFileSync(join(tmp, 'agents.json'), JSON.stringify({ result: { agents: [agent('demo-worker-01', 'wW:p1'), agent('demo-worker-02', 'wW:p2'), agent('demo-worker-03', 'wW:p3')] } }))
  writeFileSync(join(tmp, 'pane-wW_p1.json'), '{"result":{"pane":{"pane_id":"wW:p1","tokens":{}}}}')
  const env = { PATH: `${curlBin}:${bin}:${process.env.PATH}`, HOME: tmp, HERDR_DASH_URL: 'http://127.0.0.1:9', HERDR_PANE_ID: 'wW:p1', WT_READY_TIMEOUT: '0', WT_SUBMIT_SETTLE_MS: '0', WT_HANDOFF_JEV: 'off' }
  // relative $0: held-card lookup (wt-ticket, resolved after `cd $main_checkout`) must still run, so p2 (assignee of WP-1) is excluded
  const list = execFileSync('./handoff.sh', ['--list', repo], { cwd: here, input: '', encoding: 'utf8', env })
  assert.ok(!list.includes('wW:p1'), list) // the sender
  assert.ok(!list.includes('wW:p2'), list) // held a card — only excluded if the relative path resolved
  assert.ok(list.includes('wW:p3'), list)
  for (const f of ['agents.json', 'pane-wW_p1.json']) writeFileSync(join(tmp, f), f === 'agents.json' ? '{"result":{"agents":[]}}' : '{"result":{"pane":{"tokens":{}}}}')
})

test('WP-348: handoff to a pane whose agents-table row is paused, exited or missing refuses; a dead dashboard falls through to herdr', () => {
  const fake = join(tmp, 'rowbin'); mkdirSync(fake, { recursive: true })
  const state = join(tmp, 'row-state'); writeFileSync(state, 'paused')
  writeFileSync(join(fake, 'curl'), `#!/bin/sh\ncase "$*" in *by-name*) printf '{"name":"wt-pack-worker-09","state":"%s"}' "$(cat ${state})" ;; *) exit 22 ;; esac\n`, { mode: 0o755 })
  const env = { PATH: `${fake}:${bin}:${process.env.PATH}`, HOME: tmp, WT_READY_TIMEOUT: '0', WT_SUBMIT_SETTLE_MS: '0', WT_HANDOFF_JEV: 'off', HERDR_DASH_URL: 'http://127.0.0.1:9' }
  for (const st of ['paused', 'exited', 'missing']) {
    writeFileSync(state, st)
    const r = spawnSync(join(here, 'handoff.sh'), ['--no-goal', '--pane', 'wW:p1', repo], { input: 'x', encoding: 'utf8', env })
    assert.equal(r.status, 1); assert.match(r.stderr, new RegExp(`wt-pack-worker-09 is ${st}: resume it first`))
  }
  writeFileSync(state, 'idle')
  assert.equal(spawnSync(join(here, 'handoff.sh'), ['--no-goal', '--dry-run', '--pane', 'wW:p1', repo], { input: 'x', encoding: 'utf8', env }).status, 0)
})

test('WP-348: a paused team member still holds its seat (the dashboard counts it), and a dead dashboard counts none', () => {
  const fake = join(tmp, 'teambin'); mkdirSync(fake, { recursive: true })
  const rows = join(tmp, 'team-rows.json'); writeFileSync(rows, '[{"name":"p","state":"paused","tags":{"team":"web","role":"worker"}}]')
  writeFileSync(join(fake, 'curl'), `#!/bin/sh\ncat ${rows}\n`, { mode: 0o755 })
  const count = (path) => execFileSync('sh', ['-c', `. ${join(here, '..', '..', 'wt-shared', 'scripts', 'agent-pane.sh')}; agent_paused_in_team web worker`],
    { encoding: 'utf8', env: { PATH: `${path}:${process.env.PATH}`, HERDR_DASH_URL: 'http://127.0.0.1:9' } }).trim()
  assert.equal(count(fake), '1')
  assert.equal(count(bin), '0') // the shared stub curl output is not the rows JSON, or the port is closed
})

test('WP-338: --pane with no cwd prints usage and exits 2 (no unbound variable)', () => {
  assert.throws(() => run(['--pane', 'wW:p1']), (e) => { assert.equal(e.status, 2); assert.match(e.stderr, /usage: handoff\.sh/); return true })
})

test('WP-354: a worker handoff carries the worktree line; a reviewer handoff does not', () => {
  const msgs = join(tmp, 'wp354-msgs')
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: tmp, HERDR_DASH_URL: 'http://127.0.0.1:9', WT_READY_TIMEOUT: '0', WT_SUBMIT_SETTLE_MS: '0', WT_HANDOFF_JEV: 'off', WT_MESSAGES_DIR: msgs }
  writeFileSync(join(tmp, 'agents.json'), JSON.stringify({ result: { agents: [
    { name: 'demo-worker-01', pane_id: 'wW:p1', tab_id: 't1', agent_status: 'idle', workspace_id: 'wW', cwd: repo },
    { name: 'demo-reviewer-01', pane_id: 'wR:p1', tab_id: 't2', agent_status: 'idle', workspace_id: 'wR', cwd: repo }] } }))
  const sent = (role) => {
    rmSync(msgs, { recursive: true, force: true })
    execFileSync(join(here, 'handoff.sh'), ['--role', role, '--no-goal', repo], { input: 'do it', encoding: 'utf8', env })
    return execFileSync('cat', [join(msgs, execFileSync('ls', [msgs], { encoding: 'utf8' }).trim().split('\n')[0])], { encoding: 'utf8' })
  }
  const line = sent('worker').match(/^Worktree: .*$/m)?.[0]
  assert.match(line, /if this prompt names a worktree, work there; otherwise create one with \/\S+\/wt-plan\/scripts\/worktree\.sh <branch>/)
  assert.ok(line.includes(`${realpathSync(join(here, '..', '..'))}/wt-plan/scripts/worktree.sh`)) // absolute, this install's own
  assert.doesNotMatch(sent('reviewer'), /^Worktree: /m)
  assert.doesNotMatch(sent('planner'), /^Worktree: /m)
  // a plan-style prompt that already names its worktree gets no second, conflicting line
  rmSync(msgs, { recursive: true, force: true })
  execFileSync(join(here, 'handoff.sh'), ['--no-goal', repo], { input: 'Use wt-work on plan.md. Work in /x/.claude/worktrees/wp-1-foo', encoding: 'utf8', env })
  assert.doesNotMatch(execFileSync('cat', [join(msgs, execFileSync('ls', [msgs], { encoding: 'utf8' }).trim().split('\n')[0])], { encoding: 'utf8' }), /^Worktree: /m)

test('WP-352: a --reply to a pane without a live mod types the recorded pointer, never the body', () => {
  writeFileSync(log, '')
  run(['--reply', 'wW:p9', '--from', 'worker'], 'x'.repeat(3000) + ' the long decision')
  const calls = readFileSync(log, 'utf8')
  assert.match(calls, /^herdr agent prompt wW:p9 <wt-message id=(\w+) kind=reply from="[^"]*">Read it with: wt-message show \1<\/wt-message>$/m)
  assert.doesNotMatch(calls, /the long decision|Do the task in/)
})
