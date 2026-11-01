// Run: node --test skills/wt-handoff/scripts/handoff.test.mjs — handoff.sh against a stub `hc` (WP-378).
// The stub keeps its terminals in terms.json (the rows `terminal.list` returns), logs every call to calls.log, and answers
// `hc send` like the real one (blocked → exit 9; --if idle refused with "is done, not idle" / "is working, not idle" / "is silent, not idle").
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
const bin = join(tmp, 'bin'), log = join(tmp, 'calls.log'), repo = join(tmp, 'demo'), terms = join(tmp, 'terms.json'), sendenv = join(tmp, 'sendenv.log')
mkdirSync(bin); mkdirSync(repo)
writeFileSync(join(bin, 'hc'), `#!/bin/sh
D=${tmp}
echo "hc $*" >> $D/calls.log
cmd=$1; shift
[ "$1" = --json ] && shift
err() { printf '{"error":{"kind":"%s","message":"%s"}}\\n' "$1" "$2" >&2; exit "$3"; }
case "$cmd" in
  connect) cat >/dev/null; printf '{"id":1,"jsonrpc":"2.0","result":{"terminals":%s}}\\n' "$(cat $D/terms.json)" ;;
  get) jq -ec --arg t "$1" '.[] | select(.address == $t)' $D/terms.json || err not_found "no terminal $1" 3 ;;
  label) t=$1; shift
    for kv in "$@"; do
      jq --arg t "$t" --arg k "\${kv%%=*}" --arg v "\${kv#*=}" 'map(if .address == $t then (if $v == "" then .labels |= del(.[$k]) else .labels[$k] = $v end) else . end)' $D/terms.json > $D/terms.tmp && mv $D/terms.tmp $D/terms.json
    done
    jq -c --arg t "$t" '.[] | select(.address == $t)' $D/terms.json ;;
  send) flag=; [ "$1" = --if ] && { flag=$2; shift 2; }
    t=$1
    echo "send tid=\${HC_TERMINAL_ID:-unset}" >> $D/sendenv.log
    [ -f $D/send-down ] && err failed "core went away" 1
    row=$(jq -c --arg t "$t" '.[] | select(.address == $t)' $D/terms.json); [ -n "$row" ] || err not_found "no terminal $t" 3
    st=$(printf '%s' "$row" | jq -r '.status.state? // empty')
    [ -f $D/race ] && st=$(cat $D/race) # the agent changed state between the list and the send
    [ "$st" = blocked ] && err blocked "$t is blocked (permission)" 9
    if [ "$flag" = idle ]; then case "$st" in idle) ;; done) err status_mismatch "$t is done, not idle" 10 ;; '') err status_mismatch "$t is silent, not idle" 10 ;; *) err status_mismatch "$t is $st, not idle" 10 ;; esac; fi
    echo '{"started":true,"status":"working","turn":1}' ;;
  read) cat "${submitted}" ;;
  keys) echo '{"status":null,"turn":0}' ;;
  wait) echo '{"ended":false,"reason":"timeout","terminal":"t","turn":0}' ;;
  *) echo '{}' ;;
esac
`)
chmodSync(join(bin, 'hc'), 0o755)
// a terminal.list row: a claude of the pool 'demo-workers' in the repo, idle, unless told otherwise
const T = (id, name, o = {}) => ({ address: id, name, cwd: o.cwd ?? repo, state: 'live',
  labels: { ...(o.pool === null ? {} : { 'wt.pool': o.pool ?? 'demo-workers' }), ...(o.labels ?? {}) },
  status: o.status === null ? null : { app: 'claude-code', state: o.status ?? 'idle' },
  argv: [o.prog ?? 'claude'], foreground: { argv: [o.prog ?? 'claude'] } })
const setTerms = (...list) => writeFileSync(terms, JSON.stringify(list))
const callsLog = () => readFileSync(log, 'utf8')
setTerms()
execFileSync('git', ['-C', repo, 'init', '-q'])
mkdirSync(join(tmp, '.local', 'share', 'wt-dashboard'), { recursive: true }) // WP-334: HOME = tmp, so the repo's role files need a trust entry here
writeFileSync(join(tmp, '.local', 'share', 'wt-dashboard', 'trusted-projects.json'), JSON.stringify({ demo: repo }))
const run = (args, input = 'review it') => execFileSync(join(here, 'handoff.sh'), args, { input, encoding: 'utf8',
  env: { PATH: `${bin}:${process.env.PATH}`, HOME: tmp, HERDR_DASH_URL: 'http://127.0.0.1:9', WT_READY_TIMEOUT: '0', WT_SUBMIT_SETTLE_MS: '0', WT_HANDOFF_JEV: 'off' } })

// WP-352: a send the dashboard recorded (a server-token sender, curl answering 2xx for /api/messages) to a keyed pane types the pointer;
// without a recorded row, or to a pane with no key file, the full text is pasted as before.
const curlOk = join(tmp, 'curlok'); mkdirSync(curlOk)
writeFileSync(join(curlOk, 'curl'), '#!/bin/sh\ncase " $* " in *" -w "*) printf 200 ;; *) echo "{}" ;; esac\n'); chmodSync(join(curlOk, 'curl'), 0o755)
const keys = join(tmp, '.local', 'share', 'wt-dashboard', 'pane-keys'); mkdirSync(keys, { recursive: true })
for (const p of ['t1', 't7', 't9']) writeFileSync(join(keys, p), 'k'.repeat(64))
const ptrEnv = { PATH: `${curlOk}:${bin}:${process.env.PATH}`, HOME: tmp, HERDR_DASH_URL: 'http://127.0.0.1:9', WT_READY_TIMEOUT: '0', WT_SUBMIT_SETTLE_MS: '0', WT_HANDOFF_JEV: 'off', WT_DELIVER_TOKEN: 'tok' }
const runPtr = (args, input = 'review it', env = {}) => execFileSync(join(here, 'handoff.sh'), args, { input, encoding: 'utf8', env: { ...ptrEnv, ...env } })

test('WP-121: --role reviewer targets <repo>-reviewers, spawns in the main checkout, tags pr/sha', () => {
  const sha = 'b'.repeat(40)
  const out = run(['--role', 'reviewer', '--kind', 'dispatch', '--pr', '12', '--sha', sha, '--no-goal', '--dry-run', repo], '/wt-watch-prs review 12')
  assert.match(out, new RegExp(`would spawn a reviewer in ${repo}`))
  assert.match(out, new RegExp(`kind=dispatch from="[^"]*" pr=12 sha=${sha}>`))
  assert.match(callsLog(), /^hc connect/m) // the pool comes from one terminal.list
  assert.throws(() => run(['--role', 'boss', '--dry-run', repo]), (e) => e.status === 2)
  // reuse comes from the reviewers pool (wt.pool=demo-reviewers) only; a free worker elsewhere is not a candidate
  setTerms(T('t1', 'demo-worker-01'), T('t11', 'demo-reviewer-01', { pool: 'demo-reviewers' }))
  assert.match(run(['--role', 'reviewer', '--no-goal', '--dry-run', repo]), /would reuse reviewer demo-reviewer-01 \(t11\)/)
  // from a worktree cwd, a reviewer still spawns in the main checkout
  setTerms()
  execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x'])
  execFileSync('git', ['-C', repo, 'worktree', 'add', '-q', join(tmp, 'wt'), '-b', 'wt'])
  assert.match(run(['--role', 'reviewer', '--no-goal', '--dry-run', join(tmp, 'wt')]), new RegExp(`would spawn a reviewer in ${repo}$`, 'm'))
})

test('WP-128: shadow logs a routing line and changes nothing; live spawns a fresh agent with --model', () => {
  setTerms(T('t11', 'demo-reviewer-01', { pool: 'demo-reviewers' }))
  let out = run(['--role', 'reviewer', '--no-goal', '--dry-run', repo], 'list the open PRs')
  assert.match(out, /would reuse reviewer demo-reviewer-01/)
  // WP-157: a local read-only rule would pick haiku, but handoff routes a SESSION's own tier (--session),
  // which never lands below sonnet — this local task is a read-only rule, so effort drops one level too.
  assert.match(out, /routing: sonnet \(shadow, local\+session-floor, ref [a-z0-9]+#0\)/)
  out = execFileSync(join(here, 'handoff.sh'), ['--role', 'reviewer', '--no-goal', '--dry-run', repo], { input: 'list the open PRs', encoding: 'utf8',
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: tmp, HERDR_DASH_URL: 'http://127.0.0.1:9', WT_READY_TIMEOUT: '0', WT_SUBMIT_SETTLE_MS: '0', WT_HANDOFF_JEV: 'off', WT_MODEL_ROUTING: 'live' } })
  assert.match(out, /would spawn a reviewer in \S+ with --model sonnet/) // a reused agent can't switch model without a picker
  assert.match(out, /would spawn a reviewer in \S+ with --model sonnet --effort low/)
  setTerms()
})

test('WP-129: routing sees --skill, or "wt-handoff" by default, never a word scraped from the task', () => {
  setTerms(T('t11', 'demo-reviewer-01', { pool: 'demo-reviewers' }))
  const judgeLog = join(tmp, '.claude', 'wt-judge-log.jsonl')
  run(['--role', 'reviewer', '--no-goal', repo], 'wt-dashboard sent this: review it')
  let entries = readFileSync(judgeLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(entries.at(-1).item.skill, 'wt-handoff')
  run(['--role', 'reviewer', '--skill', 'wt-watch-prs', '--no-goal', repo], 'review it')
  entries = readFileSync(judgeLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(entries.at(-1).item.skill, 'wt-watch-prs')
  setTerms()
})

// --cancel never reaches the network board (curl points at a closed port), so a ticket lookup fails
// fast and the assignee-return is skipped — that path is exercised by --cancel's dry-run assertions
// and by hand against a throwaway agent, not here.
const runCancel = (args, env = {}) => execFileSync(join(here, 'handoff.sh'), args, { encoding: 'utf8',
  env: { PATH: `${bin}:${process.env.PATH}`, HOME: tmp, WT_READY_TIMEOUT: '0', WT_SUBMIT_SETTLE_MS: '0', HERDR_DASH_URL: 'http://127.0.0.1:1', ...env } })

test('WP-143: live routing reuses a free worker already on the routed tier/effort; a different tier or effort spawns fresh', () => {
  const liveEnv = { PATH: `${bin}:${process.env.PATH}`, HOME: tmp, HERDR_DASH_URL: 'http://127.0.0.1:9', WT_READY_TIMEOUT: '0', WT_SUBMIT_SETTLE_MS: '0', WT_HANDOFF_JEV: 'off', WT_MODEL_ROUTING: 'live' }
  // WP-157: --session floors this local read-only pick to sonnet/low (never haiku for a session's own tier)
  setTerms(T('t1', 'demo-worker-01', { labels: { model: 'sonnet', effort: 'low' } }))
  let out = execFileSync(join(here, 'handoff.sh'), ['--role', 'worker', '--no-goal', '--dry-run', repo], { input: 'list the open PRs', encoding: 'utf8', env: liveEnv })
  assert.match(out, /would reuse worker demo-worker-01 \(t1\) \(model sonnet\)/) // routed dry-run wording (plan Unit 2)
  writeFileSync(log, '')
  execFileSync(join(here, 'handoff.sh'), ['--role', 'worker', '--no-goal', repo], { input: 'list the open PRs', encoding: 'utf8', env: { ...liveEnv, PATH: `${curlOk}:${liveEnv.PATH}`, WT_DELIVER_TOKEN: 'tok' } })
  assert.match(callsLog(), /^hc send --json --if idle t1 <wt-message id=\w+ kind=handoff from="[^"]*">Read it with: wt-message show \w+, do what it asks, then report as it says<\/wt-message>$/m) // WP-352: the recorded pointer, not 'Do the task in'
  assert.doesNotMatch(callsLog(), /^hc run/m)

  // same model, different effort: still a spawn, not a reuse (the effort half of the match rule)
  setTerms(T('t1', 'demo-worker-01', { labels: { model: 'sonnet', effort: 'medium' } }))
  out = execFileSync(join(here, 'handoff.sh'), ['--role', 'worker', '--no-goal', '--dry-run', repo], { input: 'list the open PRs', encoding: 'utf8', env: liveEnv })
  assert.match(out, /would spawn a worker in \S+ with --model sonnet --effort low/)

  // different model: spawn
  setTerms(T('t1', 'demo-worker-01', { labels: { model: 'haiku', effort: 'low' } }))
  out = execFileSync(join(here, 'handoff.sh'), ['--role', 'worker', '--no-goal', '--dry-run', repo], { input: 'list the open PRs', encoding: 'utf8', env: liveEnv })
  assert.match(out, /would spawn a worker in \S+ with --model sonnet/)
  setTerms()
})

test('WP-143: WT_WORKERS_MAX caps the worker pool; a full pool exits 3 and never spawns', () => {
  setTerms(T('t1', 'demo-worker-01', { status: 'working' }))
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: tmp, HERDR_DASH_URL: 'http://127.0.0.1:9', WT_READY_TIMEOUT: '0', WT_SUBMIT_SETTLE_MS: '0', WT_HANDOFF_JEV: 'off', WT_WORKERS_MAX: '1' }
  assert.throws(() => execFileSync(join(here, 'handoff.sh'), ['--role', 'worker', '--no-goal', repo], { input: 'do a thing', encoding: 'utf8', env }),
    (e) => { assert.equal(e.status, 3); assert.match(e.stderr, /pool full: 1\/1 plain workers in demo/); return true })
  assert.doesNotMatch(callsLog(), /^hc run/m)

  const out = execFileSync(join(here, 'handoff.sh'), ['--role', 'worker', '--no-goal', '--dry-run', repo], { input: 'do a thing', encoding: 'utf8', env })
  assert.match(out, /dry-run: pool full: 1\/1 plain workers in demo/)

  // under the cap: still spawns, never treated as full
  const under = execFileSync(join(here, 'handoff.sh'), ['--role', 'worker', '--no-goal', '--dry-run', repo],
    { input: 'do a thing', encoding: 'utf8', env: { ...env, WT_WORKERS_MAX: '2' } })
  assert.match(under, /^dry-run: would spawn a worker in/)
  setTerms()
})

test('WP-147: a DND agent is not listed, and --pane to one warns but still sends', () => {
  setTerms(T('t1', 'demo-worker-01', { labels: { dnd: '1' } }), T('t2', 'demo-worker-02'))
  const list = run(['--list', repo], '')
  assert.ok(!list.includes('t1\t'))
  assert.ok(list.includes('t2\t'))
  let threw = null
  let out, err
  const r = spawnSync(join(here, 'handoff.sh'), ['--pane', 't1', '--no-goal', repo], { input: 'x', encoding: 'utf8',
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: tmp, HERDR_DASH_URL: 'http://127.0.0.1:9', WT_READY_TIMEOUT: '0', WT_SUBMIT_SETTLE_MS: '0' } })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /^reused t1$/m)
  assert.match(r.stderr, /demo-worker-01 is DND/)
  setTerms()
})

test('WP-168: a --pane hand-off (dispatch to an already-running worker) logs its known tier as source=reuse, no Jev', () => {
  setTerms(T('t1', 'demo-worker-01', { labels: { model: 'opus', effort: 'high' } }))
  const out = run(['--pane', 't1', '--no-goal', repo], 'do the thing')
  assert.match(out, /^reused t1$/m)
  // shadow (the default mode): logged with a ref, nothing applied — same shape as a Jev/local/pin decision,
  // so `model-route.mjs outcome <ref> ...` has something to mark for this ticket.
  assert.match(out, /routing: opus \(shadow, reuse, ref [a-z0-9]+#0\)/)
  setTerms()
})

test('WP-168: a --pane hand-off to a worker with no known model token logs nothing (nothing to log)', () => {
  setTerms(T('t1', 'demo-worker-01'))
  const out = run(['--pane', 't1', '--no-goal', repo], 'do the thing')
  assert.match(out, /^reused t1$/m)
  assert.ok(!out.includes('routing:'))
  setTerms()
})

test('WP-147: a paired agent is not a free candidate, only reachable for its own ticket', () => {
  setTerms(T('t1', 'demo-worker-01', { labels: { pair: 'WP-9' } }))
  const list = run(['--list', repo], '')
  assert.ok(!list.includes('t1\t'))
  setTerms()
})

test('WP-147: --task <TICKET> with no --pane routes to the pair — the worker, or the buddy for --role reviewer', () => {
  // wt-ticket's own HTTP calls (curl) don't route through the hc stub, so this one test gets a dedicated
  // curl stub ahead of it on PATH: `-w '\n%{http_code}'` means the body is followed by a newline and a status.
  const curlBin = join(tmp, 'curlbin')
  mkdirSync(curlBin, { recursive: true })
  writeFileSync(join(curlBin, 'curl'), `#!/bin/sh
for a in "$@"; do url=$a; done
case "$url" in
  *"/api/tickets/keys"*) printf 'WP\\n200' ;;
  *"/api/tickets/WP-9"*) printf '%s\\n200' '{"id":"WP-9","pair":{"worker":{"name":"demo-worker-09","pane":"t9"},"buddy":{"name":"demo-reviewer-09","pane":"t19","role":"reviewer"}}}' ;;
  *) printf '{}\\n404' ;;
esac
`)
  chmodSync(join(curlBin, 'curl'), 0o755)
  const env = { PATH: `${curlBin}:${bin}:${process.env.PATH}`, HOME: tmp, HERDR_DASH_URL: 'http://127.0.0.1:9', WT_READY_TIMEOUT: '0', WT_SUBMIT_SETTLE_MS: '0', WT_HANDOFF_JEV: 'off' }
  let out = execFileSync(join(here, 'handoff.sh'), ['--no-goal', '--dry-run', '--task', 'WP-9 fix it', repo], { input: 'x', encoding: 'utf8', env })
  assert.match(out, /would hand to pane t9$/m)
  out = execFileSync(join(here, 'handoff.sh'), ['--role', 'reviewer', '--no-goal', '--dry-run', '--task', 'WP-9 fix it', repo], { input: 'x', encoding: 'utf8', env })
  assert.match(out, /would hand to pane t19$/m)
})

test('WP-132: --cancel resolves a name to its pane and reports what it did', () => {
  setTerms(T('t1', 'demo-worker-01', { status: 'working' }))
  assert.match(runCancel(['--dry-run', '--cancel', 'demo-worker-01', 'duplicate dispatch']),
    /dry-run: would cancel demo-worker-01 \(t1\): duplicate dispatch/)

  setTerms(T('t1', 'demo-worker-01', { status: 'done', labels: { task: 'WP-1 fix it', ticket: 'WP-1' } }))
  writeFileSync(log, '')
  const out = runCancel(['--cancel', 'demo-worker-01'])
  assert.equal(out.trim(), 'cancelled demo-worker-01 (t1): goal cleared, cleared task="WP-1 fix it"')
  const calls = callsLog()
  assert.match(calls, /^hc keys --json t1 esc$/m)
  assert.match(calls, /^hc send --json t1 \/goal clear$/m) // plain send (no --if idle: the agent may still be working), never --force
  assert.match(calls, /^hc label --json t1 task= ticket=$/m)
  assert.doesNotMatch(calls, /--force/)

  // the goal does not let go (still working past the wait): /clear is sent
  setTerms(T('t1', 'demo-worker-01', { status: 'working' }))
  assert.match(runCancel(['--cancel', 'demo-worker-01'], { WT_CANCEL_WAIT_S: '1' }), /goal clear unverified, sent \/clear/)
  // a blocked agent takes neither: both rejected, and nothing was typed
  setTerms(T('t1', 'demo-worker-01', { status: 'blocked' }))
  writeFileSync(log, '')
  assert.match(runCancel(['--cancel', 'demo-worker-01'], { WT_CANCEL_WAIT_S: '1' }), /\/clear also rejected/)
  // a kept shell at the agent's address is never typed into
  setTerms(T('t1', 'demo-worker-01', { status: null, prog: 'zsh' }))
  writeFileSync(log, '')
  assert.match(runCancel(['--cancel', 'demo-worker-01'], { WT_CANCEL_WAIT_S: '1' }), /\/clear also rejected/)
  assert.doesNotMatch(callsLog(), /^hc send/m)

  assert.throws(() => runCancel(['--cancel', 'no-such-agent']), (e) => e.status === 1)
  setTerms()
})

test('WP-204: --persona lists/reuses only agents tagged with that persona; a plain handoff skips them', () => {
  setTerms(T('t1', 'demo-worker-01'), T('t2', 'demo-frontend-worker-01', { labels: { persona: 'frontend-worker' } }))
  const plain = run(['--list', repo], '')
  assert.ok(plain.includes('t1\t') && !plain.includes('t2\t'))
  const pers = run(['--persona', 'frontend-worker', '--list', repo], '')
  assert.ok(pers.includes('t2\t') && !pers.includes('t1\t'))
  assert.match(run(['--persona', 'frontend-worker', '--role', 'worker', '--no-goal', '--dry-run', repo], 'do ui'), /would reuse worker demo-frontend-worker-01/)
  // no free persona agent: it spawns the persona, not a plain worker
  setTerms()
  assert.match(run(['--persona', 'frontend-worker', '--role', 'worker', '--no-goal', '--dry-run', repo], 'do ui'), /would spawn a frontend-worker worker in/)
  // base from the role file when --role is absent; unresolvable persona → exit 2
  assert.throws(() => run(['--persona', 'ghost', '--dry-run', repo], 'x'), (e) => e.status === 2)
})

test('WP-204: --persona alone resolves the base from its role file; a conflicting --role is exit 2', () => {
  mkdirSync(join(repo, '.wt-pack', 'roles'), { recursive: true })
  writeFileSync(join(repo, '.wt-pack', 'roles', 'qa-reviewer.md'), '---\nbase: reviewer\n---\nQA.')
  assert.match(run(['--persona', 'qa-reviewer', '--no-goal', '--dry-run', repo], 'check it'), /would spawn a qa-reviewer reviewer in/)
  assert.throws(() => run(['--persona', 'qa-reviewer', '--role', 'worker', '--dry-run', repo], 'x'), (e) => e.status === 2)
})

test('WP-205: the worker cap counts only agents of the same persona kind (none for a plain handoff)', () => {
  setTerms(T('t2', 'demo-frontend-worker-01', { labels: { persona: 'frontend-worker' } }))
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: tmp, HERDR_DASH_URL: 'http://127.0.0.1:9', WT_READY_TIMEOUT: '0', WT_SUBMIT_SETTLE_MS: '0', WT_HANDOFF_JEV: 'off', WT_WORKERS_MAX: '1' }
  const go = (extra) => execFileSync(join(here, 'handoff.sh'), ['--role', 'worker', ...extra, '--no-goal', '--dry-run', repo], { input: 'x', encoding: 'utf8', env })
  assert.match(go([]), /would spawn a worker/) // an idle persona agent does not fill a plain ticket's cap
  assert.match(go(['--persona', 'frontend-worker']), /would reuse worker demo-frontend-worker-01/)
  assert.match(go(['--persona', 'other-worker']), /would spawn/) // a different persona counts its own kind only (0 here), so it is not full
  setTerms()
})

test('WP-205: a persona at its own cap is full (exit 3) while a plain handoff is not', () => {
  setTerms(T('t2', 'demo-frontend-worker-01', { status: 'working', labels: { persona: 'frontend-worker' } }))
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: tmp, HERDR_DASH_URL: 'http://127.0.0.1:9', WT_READY_TIMEOUT: '0', WT_SUBMIT_SETTLE_MS: '0', WT_HANDOFF_JEV: 'off', WT_WORKERS_MAX: '1' }
  try {
    assert.throws(() => execFileSync(join(here, 'handoff.sh'), ['--role', 'worker', '--persona', 'frontend-worker', '--no-goal', repo], { input: 'x', encoding: 'utf8', env }),
      (e) => { assert.equal(e.status, 3); assert.match(e.stderr, /pool full: 1\/1 frontend-worker workers/); return true })
    assert.match(execFileSync(join(here, 'handoff.sh'), ['--role', 'worker', '--no-goal', '--dry-run', repo], { input: 'x', encoding: 'utf8', env }), /would spawn a worker/)
  } finally { setTerms() }
})

test('WP-210: --reply queues through the dashboard when the target mod is live, types the recorded text otherwise', () => {
  const curlBin = join(tmp, 'curlbin210')
  mkdirSync(curlBin, { recursive: true })
  setTerms(T('t7', 'demo-worker-07'))
  const stub = (body) => { writeFileSync(join(curlBin, 'curl'), `#!/bin/sh\ncat >/dev/null\nprintf '%s' '${body}'\n`); chmodSync(join(curlBin, 'curl'), 0o755) }
  const env = { PATH: `${curlBin}:${bin}:${process.env.PATH}`, HOME: tmp, HERDR_DASH_URL: 'http://127.0.0.1:9', WT_READY_TIMEOUT: '0', WT_SUBMIT_SETTLE_MS: '0', WT_HANDOFF_JEV: 'off', HC_TERMINAL_ID: 't5' }
  const reply = () => { const before = callsLog().length; const out = execFileSync(join(here, 'handoff.sh'), ['--reply', 't7', 'hi'], { encoding: 'utf8', env }); return [out, callsLog().slice(before)] }
  const T0 = '<wt-message id=srv210 kind=reply from="s">hi</wt-message>'
  stub(JSON.stringify({ queued: true, id: 'x', text: T0 }))
  let [out, calls] = reply()
  assert.match(out, /replied t7 \(queued\)/)
  assert.doesNotMatch(calls, /^hc send/m)
  stub(JSON.stringify({ queued: false, text: T0 }))
  ;[out, calls] = reply()
  assert.match(calls, /^hc send --json t7 .*id=srv210/m) // a reply may land while the target works: plain send, no --if idle
  setTerms()
})

// WP-340: a pane sender never wraps locally. A failed post is retried, then fails loudly with nothing typed;
// a retry that succeeds types the dashboard's recorded envelope; a refusal is not retried.
test('WP-340: pane_post retries, then fails loudly without a local wrap; a refusal is not retried; a retry sends the recorded text', () => {
  const curlBin = join(tmp, 'curlbin340'), count = join(tmp, 'curl340.count'); mkdirSync(curlBin, { recursive: true })
  setTerms(T('t7', 'demo-worker-07'))
  const T0 = '<wt-message id=rec340 kind=reply from="s">hi</wt-message>'
  const stub = (script) => { writeFileSync(count, ''); writeFileSync(join(curlBin, 'curl'), `#!/bin/sh\ncat >/dev/null\necho x >> ${count}\n${script}\n`); chmodSync(join(curlBin, 'curl'), 0o755) }
  const env = { PATH: `${curlBin}:${bin}:${process.env.PATH}`, HOME: tmp, HERDR_DASH_URL: 'http://127.0.0.1:9', WT_READY_TIMEOUT: '0', WT_SUBMIT_SETTLE_MS: '0', WT_HANDOFF_JEV: 'off', HC_TERMINAL_ID: 't5', WT_POST_TRIES: '3', WT_POST_RETRY_S: '0' }
  const go = (extra = []) => { const before = callsLog().length; const r = spawnSync(join(here, 'handoff.sh'), ['--reply', 't7', ...extra, 'hi'], { encoding: 'utf8', env }); return [r, callsLog().slice(before)] }
  const tries = () => readFileSync(count, 'utf8').trim().split('\n').filter(Boolean).length
  stub('exit 28') // timeout / down: 3 tries, then loud, nothing typed
  let [r, calls] = go(['--request-id', 'rid340'])
  assert.equal(r.status, 1); assert.equal(tries(), 3)
  assert.match(r.stderr, /did not record this message[\s\S]*retry with the same --request-id \(rid340\)/)
  assert.doesNotMatch(calls, /^hc send/m)
  ;[r] = go(); assert.match(r.stderr, /pass one on the first try/)
  stub(`printf '%s' '{"error":"unknown pane"}'`) // the dashboard refused: one try, loud
  ;[r, calls] = go(); assert.equal(r.status, 1); assert.equal(tries(), 1); assert.match(r.stderr, /unknown pane/); assert.doesNotMatch(calls, /^hc send/m)
  stub(`[ "$(wc -l < ${count})" -lt 2 ] && exit 28; printf '%s' '${JSON.stringify({ queued: false, text: T0 })}'`) // first try fails, second answers
  ;[r, calls] = go(['--request-id', 'rid340']); assert.equal(r.status, 0, r.stderr); assert.equal(tries(), 2)
  assert.match(calls, /^hc send --json t7 .*id=rec340/m) // the dashboard's recorded envelope, typed
  setTerms()
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
  setTerms(T('t1', 'demo-worker-01', { labels: { task: 'WP-1 still on it' } }), T('t2', 'demo-worker-02'), T('t3', 'demo-worker-03', { labels: { task: 'WP-2 finished' } }), T('t4', 'demo-worker-04'))
  const env = { PATH: `${curlBin}:${bin}:${process.env.PATH}`, HOME: tmp, HERDR_DASH_URL: 'http://127.0.0.1:9', WT_READY_TIMEOUT: '0', WT_SUBMIT_SETTLE_MS: '0', WT_HANDOFF_JEV: 'off' }
  const list = execFileSync(join(here, 'handoff.sh'), ['--list', repo], { input: '', encoding: 'utf8', env })
  assert.ok(!list.includes('t1\t') && !list.includes('t2\t'), list) // token names open WP-1; assignee of WP-1
  assert.ok(list.includes('t3\t') && list.includes('t4\t'), list) // WP-2 is done; no token, no card
  setTerms()
})

test('WP-378: a kept shell, a non-claude program and a terminal outside the pool are never candidates', () => {
  setTerms(T('t1', 'demo-worker-01', { status: null, prog: 'zsh' }), T('t2', 'demo-worker-02', { prog: 'sleep' }), T('t3', 'demo-worker-03', { pool: 'other-workers' }), T('t4', 'demo-worker-04', { pool: null }), T('t5', 'demo-worker-05'))
  assert.deepEqual(run(['--list', repo], '').trim().split('\n').map((l) => l.split('\t')[0]), ['t5'])
  setTerms()
})

test('WP-272: no /goal by default (typed pointer, recorded first); --goal arms one; --no-goal is the default; --pane is typed to as a plain send', () => {
  setTerms(T('t9', 'demo-worker-09'))
  for (const flags of [[], ['--no-goal']]) {
    writeFileSync(log, '')
    runPtr(['--role', 'worker', '--pane', 't9', ...flags, repo], 'do the thing')
    const calls = callsLog()
    const m = calls.match(/^hc send --json t9 <wt-message id=(\w+) kind=handoff from="[^"]*">Read it with: wt-message show \1, do what it asks, then report as it says<\/wt-message>$/m)
    assert.ok(m, calls) // WP-352: one typed POINTER with the recorded id; no /goal, no untagged line, no body
    const file = join(tmp, '.local', 'share', 'wt-dashboard', 'messages', `${m[1]}.md`) // the mode-600 local copy of the full message
    assert.match(readFileSync(file, 'utf8'), /^<wt-message id=\w+ kind=handoff[^>]*>[\s\S]*do the thing/)
    assert.equal(statSync(file).mode & 0o777, 0o600)
    assert.equal((calls.match(/^hc send/gm) ?? []).length, 1) // typed once
    assert.doesNotMatch(calls, /\/goal|Do the task in|do the thing|--force/)
  }
  writeFileSync(log, '')
  // the ticket prefix needs a known key; a Linear team in HOME's env file supplies one without the live dashboard (WP-348: the run is pinned to a closed port)
  mkdirSync(join(tmp, '.config', 'wt-dashboard'), { recursive: true }); writeFileSync(join(tmp, '.config', 'wt-dashboard', 'env'), 'WT_LINEAR_TEAMS=WP\n')
  runPtr(['--role', 'worker', '--pane', 't9', '--task', 'WP-5 x', '--goal', repo], 'do the thing')
  rmSync(join(tmp, '.config', 'wt-dashboard', 'env'))
  const calls = callsLog()
  assert.match(calls, /^hc send --json t9 \/goal <wt-message id=\w+ kind=handoff from="[^"]*" ticket=WP-5>Read it with: wt-message show \w+, do what it asks, then report as it says<\/wt-message>$/m, calls)
  assert.doesNotMatch(calls, /Do the task in|do the thing/)
  assert.match(calls, /^hc label --json t9 handoff_at=\d+ task=WP-5 x ticket=WP-5$/m) // the old tokens are labels now
  setTerms()
})

test('WP-378: a send is untagged (HC_TERMINAL_ID unset for hc send), never --force; a blocked target is not typed into and exits 1', () => {
  setTerms(T('t9', 'demo-worker-09'))
  writeFileSync(sendenv, ''); writeFileSync(log, '')
  runPtr(['--role', 'worker', '--pane', 't9', repo], 'do the thing', { HC_TERMINAL_ID: 't5' }) // the sender is an agent terminal: hc would wrap the line in <hc from=…> tags
  assert.equal(readFileSync(sendenv, 'utf8').trim(), 'send tid=unset')
  assert.doesNotMatch(callsLog(), /--force/)
  // blocked (a dialog is open): exit 9 from hc, no retry, no second send, a clear message
  setTerms(T('t9', 'demo-worker-09', { status: 'blocked' }))
  writeFileSync(sendenv, ''); writeFileSync(log, '')
  const r = spawnSync(join(here, 'handoff.sh'), ['--role', 'worker', '--pane', 't9', repo], { input: 'x', encoding: 'utf8', env: ptrEnv })
  assert.equal(r.status, 1); assert.match(r.stderr, /t9 is blocked \(a dialog is open\): nothing sent/)
  assert.equal(readFileSync(sendenv, 'utf8').trim().split('\n').length, 1)
  assert.doesNotMatch(callsLog(), /--force/)
  setTerms()
})

test('WP-378 D16: a script-side send to a blocked target records and posts nothing, types nothing, exits 1', () => {
  const spy = join(tmp, 'curlspy'), curlLog = join(tmp, 'curl.log'); mkdirSync(spy, { recursive: true })
  writeFileSync(join(spy, 'curl'), `#!/bin/sh\necho "curl $*" >> ${curlLog}\ncase " $* " in *" -w "*) printf 200 ;; *) echo "{}" ;; esac\n`); chmodSync(join(spy, 'curl'), 0o755)
  const env = { ...ptrEnv, PATH: `${spy}:${ptrEnv.PATH}` }
  setTerms(T('t9', 'demo-worker-09', { status: 'blocked' }))
  writeFileSync(curlLog, ''); writeFileSync(log, '')
  for (const args of [['--role', 'worker', '--pane', 't9', repo], ['--role', 'worker', '--no-goal', '--pane', 't9', repo]]) {
    const r = spawnSync(join(here, 'handoff.sh'), args, { input: 'x', encoding: 'utf8', env })
    assert.equal(r.status, 1); assert.match(r.stderr, /t9 is blocked \(a dialog is open\): nothing sent; retry when it is answered/)
  }
  assert.doesNotMatch(readFileSync(curlLog, 'utf8'), /\/api\/(messages|deliveries)/)
  assert.doesNotMatch(callsLog(), /^hc send/m)
  setTerms()
})

test('WP-378 D25: --reply to a blocked target records and posts nothing, types nothing, exits 1 (no `delivered` row that was never typed)', () => {
  const spy = join(tmp, 'curlspy2'), curlLog = join(tmp, 'curl2.log'); mkdirSync(spy, { recursive: true })
  writeFileSync(join(spy, 'curl'), `#!/bin/sh\necho "curl $*" >> ${curlLog}\ncase " $* " in *" -w "*) printf 200 ;; *) echo "{}" ;; esac\n`); chmodSync(join(spy, 'curl'), 0o755)
  const env = { ...ptrEnv, PATH: `${spy}:${ptrEnv.PATH}` }
  setTerms(T('t9', 'demo-worker-09', { status: 'blocked' }))
  writeFileSync(curlLog, ''); writeFileSync(log, '')
  const r = spawnSync(join(here, 'handoff.sh'), ['--reply', 't9', 'thanks'], { encoding: 'utf8', env })
  assert.equal(r.status, 1); assert.match(r.stderr, /t9 is blocked \(a dialog is open\): nothing sent; retry when it is answered/)
  assert.doesNotMatch(readFileSync(curlLog, 'utf8'), /\/api\/(messages|deliveries)/)
  assert.doesNotMatch(callsLog(), /^hc send/m)
  setTerms(T('t9', 'demo-worker-09', { status: 'done' })) // the same reply to a resting agent still goes out
  const ok = spawnSync(join(here, 'handoff.sh'), ['--reply', 't9', 'thanks'], { encoding: 'utf8', env })
  assert.equal(ok.status, 0, ok.stderr)
  assert.match(callsLog(), /^hc send/m)
  setTerms()
})

test('WP-378: no send into a shell (--pane at a kept shell), and a free worker resting at done is typed to with the one approved retry', () => {
  setTerms(T('t9', 'demo-worker-09', { status: null, prog: 'zsh' }))
  writeFileSync(log, '')
  const r = spawnSync(join(here, 'handoff.sh'), ['--role', 'worker', '--pane', 't9', repo], { input: 'x', encoding: 'utf8', env: ptrEnv })
  assert.equal(r.status, 1); assert.match(r.stderr, /t9 is not an agent/)
  assert.doesNotMatch(callsLog(), /^hc send/m)
  // a free candidate that rests at `done`: `--if idle` is refused ("is done, not idle"), exactly that is retried once as a plain send
  setTerms(T('t9', 'demo-worker-09', { status: 'done' }))
  writeFileSync(log, '')
  runPtr(['--role', 'worker', '--no-goal', repo], 'do the thing')
  const sends = callsLog().split('\n').filter((l) => l.startsWith('hc send'))
  assert.equal(sends.length, 2, sends.join('\n'))
  assert.match(sends[0], /^hc send --json --if idle t9 /); assert.match(sends[1], /^hc send --json t9 /)
  // raced: listed idle, working by the time of the send. Only the "is done" refusal is retried; this one is not, and nothing is typed
  setTerms(T('t9', 'demo-worker-09', { status: 'idle' }))
  writeFileSync(join(tmp, 'race'), 'working'); writeFileSync(log, '')
  const raced = spawnSync(join(here, 'handoff.sh'), ['--role', 'worker', '--no-goal', repo], { input: 'x', encoding: 'utf8', env: ptrEnv })
  rmSync(join(tmp, 'race'))
  assert.equal(raced.status, 1); assert.match(raced.stderr, /t9 is working, not idle/)
  assert.equal(callsLog().split('\n').filter((l) => l.startsWith('hc send')).length, 1) // one try, no plain retry
  // idle → a single `--if idle` send, no retry
  setTerms(T('t9', 'demo-worker-09', { status: 'idle' }))
  writeFileSync(log, '')
  runPtr(['--role', 'worker', '--no-goal', repo], 'do the thing')
  assert.equal(callsLog().split('\n').filter((l) => l.startsWith('hc send')).length, 1)
  // working is never retried: the agent is not free, so no candidate and a spawn would be needed (dry-run says so)
  setTerms(T('t9', 'demo-worker-09', { status: 'working' }))
  assert.match(run(['--role', 'worker', '--no-goal', '--dry-run', repo], 'x'), /would spawn a worker/)
  setTerms()
})

test('WP-378: the message is recorded BEFORE it is typed, and the typed pointer is the recorded id byte for byte (WP-352/360: recorded once)', () => {
  setTerms(T('t9', 'demo-worker-09'))
  const curlBin = join(tmp, 'curlbin378'); mkdirSync(curlBin, { recursive: true })
  writeFileSync(join(curlBin, 'curl'), `#!/bin/sh\ncase " $* " in *"/api/messages"*) echo "curl POST /api/messages" >> ${log}; cat > ${join(tmp, 'rec378.body')}; printf 200 ;; *) cat >/dev/null; echo "{}" ;; esac\n`)
  chmodSync(join(curlBin, 'curl'), 0o755)
  writeFileSync(log, '')
  runPtr(['--role', 'worker', '--pane', 't9', repo], 'do the thing', { PATH: `${curlBin}:${bin}:${process.env.PATH}` })
  const calls = callsLog()
  assert.ok(calls.indexOf('POST /api/messages') >= 0 && calls.indexOf('POST /api/messages') < calls.indexOf('hc send'), calls) // record first
  assert.equal((calls.match(/POST \/api\/messages/g) ?? []).length, 1) // WP-360: recorded once
  const recorded = JSON.parse(readFileSync(join(tmp, 'rec378.body'), 'utf8'))
  const id = recorded.body.match(/^<wt-message id=(\w+) /)[1]
  const typed = calls.split('\n').find((l) => l.startsWith('hc send')).replace('hc send --json t9 ', '')
  assert.equal(typed, `<wt-message id=${id} kind=handoff from="${typed.match(/from="([^"]*)"/)[1]}">Read it with: wt-message show ${id}, do what it asks, then report as it says</wt-message>`)
  setTerms()
})

test('WP-272: with the target\'s mod live the message is queued first; typed once only if it is not pulled in time', () => {
  setTerms(T('t9', 'demo-worker-09'))
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
  const env = { PATH: `${curlBin}:${bin}:${process.env.PATH}`, HOME: tmp, HERDR_DASH_URL: 'http://127.0.0.1:9', HC_TERMINAL_ID: 't3', WT_READY_TIMEOUT: '0', WT_SUBMIT_SETTLE_MS: '0', WT_HANDOFF_JEV: 'off', WT_PULL_WAIT_S: '1' }
  const go = () => execFileSync(join(here, 'handoff.sh'), ['--role', 'worker', '--pane', 't9', repo], { input: 'do the thing', encoding: 'utf8', env })
  writeFileSync(join(tmp, 'q1-status'), 'delivered'); writeFileSync(log, ''); writeFileSync(curlLog, '')
  go()
  assert.doesNotMatch(callsLog(), /^hc send/m) // the mod pulled it: nothing typed
  assert.doesNotMatch(readFileSync(curlLog, 'utf8'), /cancel/)
  writeFileSync(join(tmp, 'q1-status'), 'queued'); writeFileSync(log, ''); writeFileSync(curlLog, '')
  go()
  assert.equal((callsLog().match(/^hc send --json t9 <wt-message id=srv272 kind=handoff from="s">Read it with: wt-message show srv272, do what it asks, then report as it says<\/wt-message>$/gm) ?? []).length, 1) // not pulled: cancelled, typed once, as the pointer
  assert.match(readFileSync(curlLog, 'utf8'), /deliveries\/q1\/cancel/)
  setTerms()
})

test('WP-238: --team picks only that team\'s agents (a plain handoff skips them), spawns cap at the roster', () => {
  mkdirSync(join(repo, '.wt-pack', 'teams'), { recursive: true })
  writeFileSync(join(repo, '.wt-pack', 'teams', 'web.md'), '---\ndescription: t\nmembers: [worker x1]\nstages: [build=worker]\n---\n')
  setTerms(T('t1', 'demo-worker-01'), T('t2', 'demo-worker-02', { labels: { team: 'web', role: 'worker' } }))
  const list = (extra) => run(['--list', ...extra, repo]).trim().split('\n').filter(Boolean).map((l) => l.split('\t')[0])
  assert.deepEqual(list([]), ['t1'])
  assert.deepEqual(list(['--team', 'web']), ['t2'])
  // the team's one worker seat is taken (t2 is busy): a spawn would exceed the roster → exit 3
  setTerms(T('t2', 'demo-worker-02', { status: 'working', labels: { team: 'web', role: 'worker' } }))
  assert.throws(() => run(['--role', 'worker', '--team', 'web', repo], 'x'), (e) => e.status === 3 && /team full: 1\/1 worker in web/.test(e.stderr)) // exits before any spawn or send
  assert.match(run(['--role', 'worker', '--team', 'web', '--dry-run', repo], 'x'), /^dry-run: team full: 1\/1 worker in web/)
  assert.throws(() => run(['--role', 'reviewer', '--team', 'web', '--dry-run', repo], 'x'), (e) => e.status === 2 && /team web has no reviewer member/.test(e.stderr))
  setTerms()
})

test('WP-247: team workers do not count against the plain pool cap; --pane refuses a card of another team (and teamless vs team)', () => {
  setTerms(T('t1', 'demo-worker-01', { status: 'working' }), T('t2', 'demo-worker-02', { status: 'working', labels: { team: 'web', role: 'worker' } }), T('t3', 'demo-worker-03', { status: 'working', labels: { team: 'web', role: 'worker' } }))
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: tmp, HERDR_DASH_URL: 'http://127.0.0.1:9', WT_READY_TIMEOUT: '0', WT_SUBMIT_SETTLE_MS: '0', WT_HANDOFF_JEV: 'off', WT_WORKERS_MAX: '2' }
  const plain = execFileSync(join(here, 'handoff.sh'), ['--role', 'worker', '--no-goal', '--dry-run', repo], { input: 'x', encoding: 'utf8', env })
  assert.match(plain, /^dry-run: would spawn a worker/) // 1 teamless of 2, not 3 of 2
  assert.match(execFileSync(join(here, 'handoff.sh'), ['--role', 'worker', '--no-goal', '--dry-run', repo], { input: 'x', encoding: 'utf8', env: { ...env, WT_WORKERS_MAX: '1' } }), /pool full: 1\/1 plain/) // t1 still counts

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
  const to = (pane, task, dry = false) => { try { return { code: 0, out: execFileSync(join(here, 'handoff.sh'), ['--no-goal', ...(dry ? ['--dry-run'] : []), '--pane', pane, '--task', `${task} go`, repo], { input: 'x', encoding: 'utf8', env: tenv }) } } catch (e) { return { code: e.status, out: `${e.stdout}${e.stderr}` } } }
  assert.match(to('t2', 'WP-11', true).out, /would hand to pane t2/)                                   // own team's card
  const other = to('t2', 'WP-12'); assert.equal(other.code, 2); assert.match(to('t2', 'WP-12', true).out, /^dry-run: demo-worker-02 is on team web/); assert.match(other.out, /demo-worker-02 is on team web; WP-12 is team api's/)
  assert.match(to('t2', 'WP-13').out, /demo-worker-02 is on team web; WP-13 is teamless/) // team agent, teamless card
  assert.match(to('t1', 'WP-11').out, /demo-worker-01 is not on a team; WP-11 is team web's/) // teamless agent, team card
  assert.match(to('t1', 'WP-13', true).out, /would hand to pane t1/)                                   // teamless both
  setTerms()
})

test('WP-249 → WP-378: an agent that reports no status yet (claude still starting) is waited on before typing; a ready one is not', () => {
  setTerms(T('t7', 'demo-worker-07', { status: null }))
  writeFileSync(log, '')
  const r = spawnSync(join(here, 'handoff.sh'), ['--role', 'worker', '--pane', 't7', repo], { input: 'do the thing', encoding: 'utf8', env: ptrEnv })
  assert.match(r.stderr, /warning: t7 not ready after 0s, sending anyway/) // WT_READY_TIMEOUT=0: not ready → still only a plain send to an agent
  assert.match(callsLog(), /^hc get --json t7$/m) // the readiness poll
  assert.doesNotMatch(callsLog(), /rename/)
  setTerms(T('t7', 'demo-worker-07'))
  writeFileSync(log, '')
  runPtr(['--role', 'worker', '--pane', 't7', repo], 'do the thing')
  assert.doesNotMatch(callsLog().split(/^hc send/m)[0], /^hc get/m) // registered and idle: no wait before the send (the confirm step reads the status after it)
})

test('WP-251: --request-id sends once; a repeat returns the first output, a different id sends again', () => {
  setTerms(T('t7', 'demo-worker-07'))
  const sends = () => (callsLog().match(/^hc send/gm) ?? []).length
  const go = (id) => runPtr(['--role', 'worker', '--pane', 't7', '--request-id', id, repo], 'do the thing')
  writeFileSync(log, '')
  const first = go('req-1')
  assert.equal(sends(), 1)
  assert.equal(go('req-1'), first)
  assert.equal(sends(), 1)
  go('req-2')
  assert.equal(sends(), 2)
  setTerms()
})

test('WP-257: --reply records the envelope at /api/messages; --ack posts the state to /api/messages/<id>/ack', () => {
  const curlBin = join(tmp, 'curlbin257')
  const calls = join(tmp, 'curl257.log')
  mkdirSync(curlBin, { recursive: true })
  writeFileSync(calls, '')
  setTerms(T('t7', 'demo-worker-07'))
  writeFileSync(join(curlBin, 'curl'), `#!/bin/sh\necho "$@" >> ${calls}\ncat >> ${calls}\nprintf '%s' '{"queued":true,"id":"m1","state":"acknowledged"}'\n`)
  chmodSync(join(curlBin, 'curl'), 0o755)
  const env = { PATH: `${curlBin}:${bin}:${process.env.PATH}`, HOME: tmp, HERDR_DASH_URL: 'http://127.0.0.1:9', WT_READY_TIMEOUT: '0', WT_SUBMIT_SETTLE_MS: '0', WT_HANDOFF_JEV: 'off', WT_DELIVER_TOKEN: 'tok' } // a server-token sender records its own envelope (a pane's is recorded by the dashboard)
  execFileSync(join(here, 'handoff.sh'), ['--reply', 't7', 'hi'], { encoding: 'utf8', env })
  const log257 = readFileSync(calls, 'utf8')
  assert.match(log257, /\/api\/messages/)
  assert.match(log257, /"state": "delivered"/)
  const out = execFileSync(join(here, 'handoff.sh'), ['--ack', 'ab12', '--answered'], { encoding: 'utf8', env: { ...env, HC_TERMINAL_ID: 't5' } })
  assert.match(out, /m1 acknowledged/)
  assert.match(readFileSync(calls, "utf8"), /"state": "answered"[\s\S]*\/api\/messages\/ab12\/ack/)
  assert.throws(() => execFileSync(join(here, 'handoff.sh'), ['--ack', 'a b'], { env, stdio: 'pipe' }), (e) => e.status === 2)
  setTerms()
})

test('WP-298: --effort sets the unit tier/effort in any mode (low → haiku, medium → sonnet, high → no cap); none leaves a plain worker unforced', () => {
  setTerms()
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
  setTerms(T('t5', 'me'))
  const env = { PATH: `${curlBin}:${bin}:${process.env.PATH}`, HOME: tmp, WT_READY_TIMEOUT: '0', WT_SUBMIT_SETTLE_MS: '0', WT_HANDOFF_JEV: 'off', HC_TERMINAL_ID: 't5', HERDR_DASH_URL: 'http://x' }
  const go = (args, input = 'do it') => spawnSync(join(here, 'handoff.sh'), args, { input, encoding: 'utf8', env })
  let r = go(['--pane', 'umk-planner-01', '--no-goal', '--request-id', 'r317', repo])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /reused headless umk-planner-01 \(hl-new2\)/); assert.match(r.stdout, /--reply hl-new2/)
  const calls = readFileSync(clog, 'utf8')
  assert.match(calls, /-H x-herdr-pane: t5.*http:\/\/x\/api\/headless\/hl-new2\/message :: \{\s*"text": "do it/) // WP-330: plain text; the dashboard wraps it
  assert.match(calls, /To reply: \S+handoff.sh --reply t5/) // the usual reply footer rides along
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
  setTerms()
})

test('WP-328: a pane sender posts fields and types the pointer of the dashboard-built envelope; --from is honoured only with the server token', () => {
  setTerms(T('t7', 'demo-worker-07'))
  const curlBin = join(tmp, 'curlbin328'); mkdirSync(curlBin, { recursive: true })
  const posted = join(tmp, 'curl328.body')
  const srvText = '<wt-message id=srv328 kind=reply from="stamped">hi</wt-message>'
  writeFileSync(join(curlBin, 'curl'), `#!/bin/sh\ncat > ${posted}\nprintf '%s' '${JSON.stringify({ queued: false, text: srvText })}'\n`)
  chmodSync(join(curlBin, 'curl'), 0o755)
  const env = { PATH: `${curlBin}:${bin}:${process.env.PATH}`, HOME: tmp, HERDR_DASH_URL: 'http://127.0.0.1:9', WT_READY_TIMEOUT: '0', WT_SUBMIT_SETTLE_MS: '0', WT_HANDOFF_JEV: 'off', HC_TERMINAL_ID: 't5' }
  const before = callsLog().length
  const out = execFileSync(join(here, 'handoff.sh'), ['--reply', 't7', '--from', 'forger', 'hi'], { encoding: 'utf8', env })
  assert.match(out, /replied t7/)
  const body = JSON.parse(readFileSync(posted, 'utf8'))
  assert.deepEqual(body, { pane: 't7', kind: 'reply', body: 'hi' }) // fields only: no envelope, no sender
  assert.match(callsLog().slice(before), /^hc send --json t7 <wt-message id=srv328 kind=reply from="stamped">/m) // the server's envelope (its pointer), not a local wrap
  // --from: ignored for an agent (note on stderr), honoured with the server's token
  const dry = (e) => spawnSync(join(here, 'handoff.sh'), ['--reply', 't7', '--from', 'forger', '--dry-run', 'hi'], { encoding: 'utf8', env: { ...env, ...e } })
  const agent = dry({})
  assert.doesNotMatch(agent.stdout, /from="forger"/); assert.match(agent.stderr, /--from is ignored/)
  assert.match(dry({ WT_DELIVER_TOKEN: 't', HC_TERMINAL_ID: '' }).stdout, /from="forger"/)
  setTerms()
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
  setTerms(T('t1', 'demo-worker-01'), T('t2', 'demo-worker-02'), T('t3', 'demo-worker-03'))
  const env = { PATH: `${curlBin}:${bin}:${process.env.PATH}`, HOME: tmp, HERDR_DASH_URL: 'http://127.0.0.1:9', HC_TERMINAL_ID: 't1', WT_READY_TIMEOUT: '0', WT_SUBMIT_SETTLE_MS: '0', WT_HANDOFF_JEV: 'off' }
  // relative $0: held-card lookup (wt-ticket, resolved after `cd $main_checkout`) must still run, so p2 (assignee of WP-1) is excluded
  const list = execFileSync('./handoff.sh', ['--list', repo], { cwd: here, input: '', encoding: 'utf8', env })
  assert.ok(!list.includes('t1\t'), list) // the sender
  assert.ok(!list.includes('t2\t'), list) // held a card — only excluded if the relative path resolved
  assert.ok(list.includes('t3\t'), list)
  setTerms()
})

test('WP-348: handoff to a pane whose agents-table row is paused, exited or missing refuses; a dead dashboard falls through to hc', () => {
  const fake = join(tmp, 'rowbin'); mkdirSync(fake, { recursive: true })
  const state = join(tmp, 'row-state'); writeFileSync(state, 'paused')
  writeFileSync(join(fake, 'curl'), `#!/bin/sh\ncase "$*" in *by-name*) printf '{"name":"wt-pack-worker-09","state":"%s"}' "$(cat ${state})" ;; *) exit 22 ;; esac\n`, { mode: 0o755 })
  const env = { PATH: `${fake}:${bin}:${process.env.PATH}`, HOME: tmp, WT_READY_TIMEOUT: '0', WT_SUBMIT_SETTLE_MS: '0', WT_HANDOFF_JEV: 'off', HERDR_DASH_URL: 'http://127.0.0.1:9' }
  for (const st of ['paused', 'exited', 'missing']) {
    writeFileSync(state, st)
    const r = spawnSync(join(here, 'handoff.sh'), ['--no-goal', '--pane', 't1', repo], { input: 'x', encoding: 'utf8', env })
    assert.equal(r.status, 1); assert.match(r.stderr, new RegExp(`wt-pack-worker-09 is ${st}: resume it first`))
  }
  writeFileSync(state, 'idle')
  assert.equal(spawnSync(join(here, 'handoff.sh'), ['--no-goal', '--dry-run', '--pane', 't1', repo], { input: 'x', encoding: 'utf8', env }).status, 0)
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
  assert.throws(() => run(['--pane', 't1']), (e) => { assert.equal(e.status, 2); assert.match(e.stderr, /usage: handoff\.sh/); return true })
})

test('WP-354: a worker handoff carries the worktree line; a reviewer handoff does not', () => {
  setTerms(T('t1', 'demo-worker-01'), T('t11', 'demo-reviewer-01', { pool: 'demo-reviewers' }))
  // --dry-run prints the exact text that would be sent
  const sent = (role, input = 'do it') => run(['--role', role, '--no-goal', '--dry-run', repo], input)
  const line = sent('worker').match(/^Worktree: .*$/m)?.[0]
  assert.match(line, /if this prompt names a worktree, work there; otherwise create one with \/\S+\/wt-plan\/scripts\/worktree\.sh <branch>/)
  assert.ok(line.includes(`${realpathSync(join(here, '..', '..'))}/wt-plan/scripts/worktree.sh`)) // absolute, this install's own
  assert.doesNotMatch(sent('reviewer'), /^Worktree: /m)
  assert.doesNotMatch(sent('planner'), /^Worktree: /m)
  // a plan-style prompt that already names its worktree gets no second, conflicting line
  assert.doesNotMatch(run(['--no-goal', '--dry-run', repo], 'Use wt-work on plan.md. Work in /x/.claude/worktrees/wp-1-foo'), /^Worktree: /m)
  setTerms()
})

test('WP-352: a --reply to a pane without a live mod types the recorded pointer, never the body', () => {
  setTerms(T('t9', 'demo-worker-09')) // not left to an earlier test
  writeFileSync(join(keys, 't9'), 'k'.repeat(64)) // not left to the load-time loop: an earlier test may have run handoff with another HOME layout
  writeFileSync(log, '')
  runPtr(['--reply', 't9', '--from', 'worker'], 'x'.repeat(3000) + ' the long decision')
  const calls = readFileSync(log, 'utf8')
  assert.match(calls, /^hc send --json t9 <wt-message id=(\w+) kind=reply from="[^"]*">Read it with: wt-message show \1, do what it asks, then report as it says<\/wt-message>$/m)
  assert.doesNotMatch(calls, /the long decision|Do the task in/)
})

test('WP-352: no recorded row (no pane identity or token) or a pane without a key file → the full text is pasted, never a pointer nobody can read', () => {
  setTerms(T('t9', 'demo-worker-09'), T('t3', 'demo-worker-03'))
  writeFileSync(log, '')
  run(['--role', 'worker', '--pane', 't9', repo], 'do the thing') // run(): no token, no pane id → nothing recorded
  let calls = readFileSync(log, 'utf8')
  assert.match(calls, /^hc send --json t9 <wt-message id=\w+ kind=handoff[^>]*>[\s\S]*do the thing/m)
  assert.doesNotMatch(calls, /Read it with/)
  writeFileSync(log, '')
  runPtr(['--reply', 't3', '--from', 'worker'], 'short answer') // recorded, but t3 has no key file
  calls = readFileSync(log, 'utf8')
  assert.match(calls, /^hc send --json t3 <wt-message id=\w+ kind=reply[^>]*>short answer/m)
  assert.doesNotMatch(calls, /Read it with/)
})

// WP-359: the body from --file / stdin ("-") carries backticks, $( and quotes verbatim; an argument body with them warns; every old form still works.
const NASTY = 'ran `date` and $(whoami) then "quoted" and \'single\' $HOME'
const runRaw = (args, input = '') => spawnSync(join(here, 'handoff.sh'), args, { input, encoding: 'utf8',
  env: { PATH: `${bin}:${process.env.PATH}`, HOME: tmp, HERDR_DASH_URL: 'http://127.0.0.1:9', WT_READY_TIMEOUT: '0', WT_SUBMIT_SETTLE_MS: '0', WT_HANDOFF_JEV: 'off' } })
test('WP-359: --reply --file <path> and --reply - (stdin) send a nasty body verbatim, with no warning', () => {
  const f = join(tmp, 'reply-body.txt'); writeFileSync(f, `${NASTY}\nsecond line\n`)
  for (const [args, input] of [[['--reply', 't1', '--file', f, '--dry-run'], ''], [['--reply', 't1', '--file', '-', '--dry-run'], NASTY + '\nsecond line\n'],
    [['--reply', 't1', '--dry-run', '-'], NASTY + '\nsecond line\n'], [['--reply', 't1', '--dry-run'], NASTY + '\nsecond line\n']]) {
    const r = runRaw(args, input)
    assert.equal(r.status, 0, r.stderr)
    assert.ok(r.stdout.includes(NASTY) && r.stdout.includes('second line'), `${args.join(' ')}: ${r.stdout}`)
    assert.doesNotMatch(r.stderr, /warning/)
  }
})
test('WP-359: a reply body passed as an argument that contains a backtick or $( warns on stderr but still sends; a plain one does not warn', () => {
  for (const t of ['kept `date` literally', 'kept $(whoami) literally']) {
    const r = runRaw(['--reply', 't1', '--dry-run', t])
    assert.equal(r.status, 0); assert.ok(r.stdout.includes(t))
    assert.match(r.stderr, /warning: the reply text contains a backtick or \$\(.*--file <path> or stdin/)
  }
  assert.doesNotMatch(runRaw(['--reply', 't1', '--dry-run', 'plain text, 100% fine']).stderr, /warning/)
})
test('WP-359: --file errors: a missing path and an empty body exit non-zero with a clear message', () => {
  assert.match(runRaw(['--reply', 't1', '--file', join(tmp, 'nope.txt'), '--dry-run']).stderr, /--file: cannot read/)
  assert.equal(runRaw(['--reply', 't1', '--file', join(tmp, 'nope.txt'), '--dry-run']).status, 2)
  assert.equal(runRaw(['--reply', 't1', '--file', '-', '--dry-run'], '').status, 2) // empty stdin: "--reply: no text"
  assert.equal(runRaw(['--reply', 't1', '--file']).status, 2)
})
test('WP-359: a handoff prompt from --file <path> or --file - equals the old <cwd> <prompt-file> and stdin forms', () => {
  const f = join(tmp, 'prompt-body.txt'); writeFileSync(f, NASTY)
  const norm = (o) => o.replace(/id=\w+/g, 'id=X').replace(/ref \w+#0/g, 'ref X')
  const old = norm(runRaw(['--role', 'reviewer', '--no-goal', '--dry-run', repo, f]).stdout)
  const viaFile = norm(runRaw(['--role', 'reviewer', '--no-goal', '--dry-run', '--file', f, repo]).stdout)
  const viaStdin = norm(runRaw(['--role', 'reviewer', '--no-goal', '--dry-run', '--file', '-', repo], NASTY).stdout)
  const oldStdin = norm(runRaw(['--role', 'reviewer', '--no-goal', '--dry-run', repo], NASTY).stdout)
  assert.equal(viaFile, old); assert.equal(viaStdin, old); assert.equal(oldStdin, old)
  assert.equal(runRaw(['--no-goal', '--dry-run', '--file', join(tmp, 'nope.txt'), repo]).status, 1)
})

// WP-360: a --new handoff types its message exactly once: agents.sh spawn gets no prompt, and the one send carries the id.
test('WP-360: --new spawns without the prompt and types the message exactly once', () => {
  const root = join(tmp, 'tree360'), spawnLog = join(tmp, 'spawn360.log')
  mkdirSync(join(root, 'wt-handoff', 'scripts'), { recursive: true }); mkdirSync(join(root, 'wt-agents', 'scripts'), { recursive: true })
  writeFileSync(join(root, 'wt-handoff', 'scripts', 'handoff.sh'), readFileSync(join(here, 'handoff.sh')), { mode: 0o755 })
  execFileSync('ln', ['-s', join(here, '..', '..', 'wt-shared'), join(root, 'wt-shared')])
  for (const d of ['wt-ticket', 'wt-plan', 'wt-memory', 'wt-room', 'wt-dashboard']) execFileSync('ln', ['-s', join(here, '..', '..', d), join(root, d)]) // handoff.sh reads its siblings
  writeFileSync(join(root, 'wt-agents', 'scripts', 'agents.sh'), `#!/bin/sh\necho "agents.sh $*" >> ${spawnLog}\necho "demo-worker-09 t9"\n`, { mode: 0o755 })
  setTerms(T('t9', 'demo-worker-09')) // the spawned terminal, as hc lists it once agents.sh has started it
  writeFileSync(log, '')
  const before = 0
  const marker = 'MARKER-WP360-FIRST-PROMPT'
  const out = execFileSync(join(root, 'wt-handoff', 'scripts', 'handoff.sh'), ['--new', '--role', 'worker', '--no-goal', repo], { input: marker, encoding: 'utf8', env: ptrEnv })
  assert.match(out, /created demo-worker-09 t9/)
  const spawns = readFileSync(spawnLog, 'utf8')
  assert.match(spawns, /agents\.sh spawn worker/); assert.doesNotMatch(spawns, new RegExp(marker)) // spawn is never given the prompt
  const sends = readFileSync(log, 'utf8').slice(before).split('\n').filter((l) => /^hc send /.test(l) && l.includes(' t9 ') && !/\/clear|\/goal clear/.test(l))
  const ids = sends.map((l) => l.match(/wt-message id=(\w+)/)?.[1]).filter(Boolean)
  assert.equal(ids.length, 1, sends.join('\n')) // one typed send, one envelope id
  setTerms()
})
function existsSyncSafe(f) { try { statSync(f); return true } catch { return false } }

test('WP-368: --role lead always spawns a fresh wt-pack:wt-lead on opus/low and never reuses an idle lead', () => {
  setTerms(T('t21', 'demo-lead-01', { pool: 'demo-leads' }))
  const out = run(['--role', 'lead', '--no-goal', '--dry-run', repo], '/wt-run WP-9')
  assert.doesNotMatch(out, /would reuse/)
  assert.match(out, new RegExp(`would spawn a lead in ${repo} with --model opus --effort low --agent wt-pack:wt-lead`))
  assert.match(run(['--role', 'lead', '--no-goal', '--dry-run', repo], '/wt-run WP-9'), /--model opus --effort low --agent/) // route is opus/low
  assert.doesNotMatch(run(['--role', 'worker', '--no-goal', '--dry-run', repo]), /--agent/)
  setTerms()
})
