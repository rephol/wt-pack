// Run: node --test skills/wt-watch-prs/scripts/*.test.mjs — WP-116: watch-prs.sh against a gh stub and fixture JSON,
// with a temp HOME so the real state dir (read by the dashboard) is never touched.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync, execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, chmodSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const script = join(import.meta.dirname, 'watch-prs.sh')
const tmp = mkdtempSync(join(tmpdir(), 'wt-watch-prs-'))
const bin = join(tmp, 'bin'), fx = join(tmp, 'fx'), repo = join(tmp, 'demo'), home = join(tmp, 'home')
for (const d of [bin, fx, repo, home, join(tmp, 'data', 'data')]) mkdirSync(d, { recursive: true })
const SECRET = 'SECRET-TOK-9f3a'
const tokFile = join(tmp, 'reviewer-token')
writeFileSync(tokFile, SECRET + '\n')
writeFileSync(join(bin, 'gh'), `#!/bin/sh
echo "gh $*" >> "${fx}/calls"
case "$1 $2" in
  "repo view") echo acme/demo ;;
  "auth status") exit \${AUTH_FAIL:-0} ;;
  "auth token") [ "$4" = bot ] && { echo ${SECRET}; exit 0; }; exit 1 ;;
  "api --paginate") shift; cat "${fx}/reviews.json"; exit ;;
  "api user") [ -n "\${NO_LOGIN:-}" ] && exit 1; [ "\$GH_TOKEN" = ${SECRET} ] && echo reviewer-bot || echo human ;;
  "pr list") c=$(cat "${fx}/n" 2>/dev/null || echo 0); c=$((c+1)); echo $c > "${fx}/n"
    f="${fx}/list.$c.json"; [ -f "$f" ] || f="${fx}/list.json"; cat "$f" ;;
  "pr view") cat "${fx}/view-$3.json" ;;
  api\\ repos/*) case "$2" in
      */comments*) cat "${fx}/comments.json" ;;
      */reviews*) cat "${fx}/reviews.json" ;;
    esac ;;
esac
`)
chmodSync(join(bin, 'gh'), 0o755)
// WP-121: herdr and handoff stubs for mode/dispatch (fixture files; a missing agents.json means herdr is absent).
writeFileSync(join(bin, 'herdr'), `#!/bin/sh
case "$1 $2" in
  "pane get") [ "$3" = none ] && exit 1; cat "${fx}/pane.json" ;;
  "agent list") cat "${fx}/agents.json" ;;
  "workspace list") echo '{"result":{"workspaces":[{"label":"demo-reviewers","workspace_id":"wR"}]}}' ;;
esac
`)
chmodSync(join(bin, 'herdr'), 0o755)
const handoff = join(tmp, 'handoff.sh')
writeFileSync(handoff, `#!/bin/sh
{ echo "ARGS $*"; echo "BODY $(cat)"; } > "${fx}/handoff"
[ -n "\${HANDOFF_FAIL:-}" ] && exit 1
echo "created demo-reviewer-01 wR:p1"; echo "target demo-reviewer-01 wR:p1"
`)
chmodSync(handoff, 0o755)
execFileSync('git', ['-C', repo, 'init', '-q'])

const sd = join(home, '.local/share/wt-watch-prs/acme-demo'), stateFile = join(sd, 'state.json')
const run = (args, env = {}) => {
  const r = spawnSync(script, args, { cwd: repo, encoding: 'utf8', env: {
    PATH: `${bin}:${process.env.PATH}`, HOME: home, WT_DASHBOARD_DATA: join(tmp, 'data'),
    GH_REVIEWER_TOKEN_FILE: tokFile, WATCH_PRS_SLEEP: '0', ...env } })
  for (const s of [r.stdout, r.stderr]) assert.ok(!s.includes(SECRET), `token leaked: ${s}`)
  return r
}
const fixture = (name, v) => writeFileSync(join(fx, name), JSON.stringify(v))
const reset = (state = { reviewed: {} }) => {
  rmSync(sd, { recursive: true, force: true }); mkdirSync(join(sd, 'claims'), { recursive: true })
  writeFileSync(stateFile, JSON.stringify(state)); rmSync(join(fx, 'n'), { force: true }); rmSync(join(fx, 'calls'), { force: true })
  for (const n of [1, 2, 3]) rmSync(join(fx, `list.${n}.json`), { force: true })
}
const sha = (c) => c.repeat(40)
const pr = (number, headRefOid, extra = {}) => ({ number, headRefOid, author: { login: 'dev' }, title: `pr ${number}`, isDraft: false, ...extra })

test('preflight: ok with degraded lines, hard fail exits 1', () => {
  let r = run(['preflight'])
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /ok: acme\/demo as reviewer-bot \(token file\)/)
  r = run(['preflight'], { GH_REVIEWER_TOKEN_FILE: join(tmp, 'none') })
  assert.equal(r.status, 0); assert.match(r.stdout, /DEGRADED: no reviewer identity .* never approve/)
  r = run(['preflight'], { AUTH_FAIL: '1' })
  assert.equal(r.status, 1); assert.match(r.stdout, /HARD fail: gh not authenticated/)
})

test('WP-126: a declared reviewer matching the default gh login is not degraded; a mismatch is; no dashboard needed', () => {
  const none = join(tmp, 'none'), noDash = { GH_REVIEWER_TOKEN_FILE: none, WT_DASHBOARD_DATA: join(tmp, 'no-dashboard') }
  const t0 = Date.now()
  let r = run(['preflight'], { ...noDash, WT_REVIEWER_LOGIN: 'human' }) // the stub's default login is "human"
  assert.equal(r.status, 0, r.stderr); assert.doesNotMatch(r.stdout, /DEGRADED: no reviewer/)
  assert.match(r.stdout, /ok: acme\/demo as human \(default identity \(declared reviewer human\)\)/)
  assert.ok(Date.now() - t0 < 5000, 'no dashboard must not stall preflight')
  assert.match(run(['identity'], { ...noDash, WT_REVIEWER_LOGIN: 'human' }).stdout, /^human default identity \(declared reviewer human\)/)
  r = run(['preflight'], { ...noDash, WT_REVIEWER_LOGIN: 'reviewer-bot' })
  assert.match(r.stdout, /DEGRADED: no reviewer identity \(default identity — declared reviewer reviewer-bot, but gh is human\)/)
  const lf = join(tmp, 'login-file'); writeFileSync(lf, 'human\n')
  assert.doesNotMatch(run(['preflight'], { ...noDash, GH_REVIEWER_LOGIN_FILE: lf }).stdout, /DEGRADED: no reviewer/)
  assert.match(run(['preflight'], noDash).stdout, /DEGRADED: no reviewer identity \(default identity\)/) // nothing declared
  // a dashboard account with no gh token is not rescued by a declared login
  const db = new DatabaseSync(join(tmp, 'data', 'data', 'wt.db'))
  db.exec("CREATE TABLE IF NOT EXISTS project_settings (project TEXT, key TEXT, value TEXT); DELETE FROM project_settings; INSERT INTO project_settings VALUES ('demo', 'reviewerGithubAccount', 'nobody')")
  assert.match(run(['preflight'], { GH_REVIEWER_TOKEN_FILE: none, WT_REVIEWER_LOGIN: 'human' }).stdout, /DEGRADED: no reviewer identity \(default identity \(no gh token for nobody\)\)/)
  db.exec('DROP TABLE project_settings'); db.close()
})

test('identity: token file, project account, unresolved', () => {
  assert.match(run(['identity']).stdout, /^reviewer-bot token file/)
  const db = new DatabaseSync(join(tmp, 'data', 'data', 'wt.db'))
  db.exec('CREATE TABLE project_settings (project TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (project, key))')
  db.prepare("INSERT INTO project_settings VALUES ('demo', 'reviewerGithubAccount', 'bot')").run()
  assert.match(run(['identity'], { GH_REVIEWER_TOKEN_FILE: join(tmp, 'none') }).stdout, /^reviewer-bot account bot/)
  db.exec('DELETE FROM project_settings'); db.close()
  assert.equal(run(['identity'], { NO_LOGIN: '1' }).status, 1)
})

test('poll-shas: exact and short-prefix suppression, claim suppression, siblings fire', () => {
  reset({ reviewed: { 1: { sha: sha('a') }, 2: { sha: 'bbbbbbbb' } } })
  mkdirSync(join(sd, 'claims', 'pr3'))
  fixture('list.json', [pr(1, sha('a')), pr(2, sha('b')), pr(3, sha('c')), pr(4, sha('d')), pr(5, sha('e'), { isDraft: true }), pr(6, sha('f'))])
  const out = run(['poll-shas', '--once']).stdout
  assert.deepEqual(out.match(/PR #\d+/g), ['PR #4', 'PR #6'])
  assert.match(out, new RegExp(`PR #4 — new commits ${sha('d')} — dev: pr 4`))
})

test('poll-shas: TTL keeps a fired head quiet, expiry re-fires it', () => {
  reset(); fixture('list.json', [pr(7, sha('7'))])
  assert.equal(run(['poll-shas'], { WATCH_PRS_POLLS: '2' }).stdout.match(/PR #7/g).length, 1)
  reset(); assert.equal(run(['poll-shas'], { WATCH_PRS_POLLS: '2', WATCH_PRS_TTL: '0' }).stdout.match(/PR #7/g).length, 2)
})

test('poll-shas: NO LONGER OPEN only for a verified merge; an empty poll is not a mass close', () => {
  reset({ reviewed: { 8: { sha: sha('8') }, 9: { sha: sha('9') }, 10: { sha: sha('1') } } })
  fixture('list.1.json', [pr(8, sha('8')), pr(9, sha('9')), pr(10, sha('1'))])
  fixture('list.2.json', [])
  fixture('list.3.json', [pr(10, sha('1'))])
  fixture('view-8.json', { state: 'MERGED', title: 'pr 8', author: { login: 'dev' } })
  fixture('view-9.json', { state: 'OPEN', title: 'pr 9', author: { login: 'dev' } })
  const out = run(['poll-shas'], { WATCH_PRS_POLLS: '3' }).stdout
  assert.equal(out.trim(), 'PR #8 — NO LONGER OPEN — MERGED — dev: pr 8')
})

test('claim: second claim loses; release frees it', () => {
  reset()
  assert.equal(run(['claim', '11', 'sess-a']).stdout.trim(), 'claimed')
  const r = run(['claim', '11', 'sess-b'])
  assert.equal(r.status, 1); assert.match(r.stdout, /held by sess-a/)
  assert.equal(run(['release', '11', 'sess-b']).status, 1)
  assert.equal(run(['release', '11', 'sess-a']).status, 0)
  assert.equal(run(['claim', '11', 'sess-b']).status, 0)
})

test('record: full SHA required; note with backticks and $ survives', () => {
  reset()
  assert.equal(run(['record', '12', 'abc1234', 'approved', 'x', 'sess-a']).status, 1)
  const note = 'gate green; `if ($x)` kept'
  assert.equal(run(['record', '12', sha('c'), 'changes-requested', note, 'sess-a']).status, 0)
  const e = JSON.parse(readFileSync(stateFile, 'utf8')).reviewed['12']
  assert.deepEqual(e, { sha: sha('c'), state: 'changes-requested', outcome: note, reviewer_session: 'sess-a' })
  assert.ok(!readFileSync(stateFile, 'utf8').includes(SECRET))
  assert.ok(!existsSync(join(sd, 'state.lock')))
  assert.equal(run(['gh', 'auth', 'token']).status, 1)
})

test('poll-replies: drops self and bots, only this session\'s holds, since is 15 min back', () => {
  reset({ reviewed: { 13: { sha: sha('d'), state: 'changes-requested', reviewer_session: 'sess-a' },
    14: { sha: sha('e'), state: 'changes-requested', reviewer_session: 'sess-b' } } })
  fixture('comments.json', [
    { id: 1, user: { login: 'reviewer-bot', type: 'User' }, body: 'my own hold' },
    { id: 2, user: { login: 'railway-app[bot]', type: 'Bot' }, body: 'deployed' },
    { id: 3, user: { login: 'dev', type: 'User' }, body: 'answered:\n yes' }])
  fixture('reviews.json', [{ id: 5, user: { login: 'reviewer-bot', type: 'User' }, state: 'CHANGES_REQUESTED', body: 'hold', submitted_at: '2999-01-01T00:00:00Z' }, { id: 4, user: { login: 'dev', type: 'User' }, state: 'COMMENTED', body: 'see above', submitted_at: '2999-01-01T00:00:00Z' }])
  const out = run(['poll-replies', '--session', 'sess-a', '--once']).stdout
  assert.equal(out.trim(), 'PR #13 — REPLY on a held PR — dev: answered: yes\nPR #13 — REVIEW (COMMENTED) on a held PR — dev: see above')
  const since = readFileSync(join(fx, 'calls'), 'utf8').match(/since=([^&]+)/)[1]
  const ago = (Date.now() - Date.parse(since)) / 60000
  assert.ok(ago > 14 && ago < 16.1, `since ${since} is ${ago} min back`)
  assert.ok(!readFileSync(join(fx, 'calls'), 'utf8').includes('/14/'))
  const r = run(['poll-replies', '--session', 'sess-a', '--once'], { NO_LOGIN: '1' })
  assert.equal(r.status, 1); assert.match(r.stderr, /SELF is unresolved/)
})

test('gate classifies rollups; describes flags empty bodies and branch titles', () => {
  reset()
  const cr = (conclusion, status = 'COMPLETED', name = 'ci') => ({ __typename: 'CheckRun', name, status, conclusion })
  const cases = [
    [[cr('SUCCESS'), { __typename: 'StatusContext', state: 'PENDING' }], 'green'],
    [[cr('SUCCESS'), cr('FAILURE')], 'red'],
    [[cr('SUCCESS'), cr('CANCELLED')], 'pending'],
    [[cr('', 'IN_PROGRESS')], 'pending'],
    [[cr('FAILURE', 'COMPLETED', 'Informational lint')], 'none'],
    [[], 'none']]
  for (const [rollup, want] of cases) { fixture('view-15.json', { statusCheckRollup: rollup }); assert.equal(run(['gate', '15']).stdout.trim(), want) }
  for (const [v, want] of [
    [{ title: 'Add x', body: 'why', author: { login: 'dev' } }, 'ok'],
    [{ title: 'Add x', body: ' \n', author: { login: 'dev' } }, 'no-body'],
    [{ title: 'dev/wp-1-thing', body: 'why', author: { login: 'dev' } }, 'branch-title'],
    [{ title: 'chore: deps', body: '', author: { login: 'dependabot[bot]' } }, 'ok']]) {
    fixture('view-16.json', v); assert.equal(run(['describes', '16']).stdout.trim(), want)
  }
})

test('diff: delta when the recorded head is an ancestor, full review after a force-push', () => {
  const origin = join(tmp, 'origin.git'), g = (...a) => execFileSync('git', a, { encoding: 'utf8' }).trim()
  const work = join(tmp, 'work')
  g('init', '-q', '-b', 'main', work)
  const commit = (f, msg) => { writeFileSync(join(work, f), msg); g('-C', work, 'add', f); g('-C', work, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', msg); return g('-C', work, 'rev-parse', 'HEAD') }
  commit('base.txt', 'base')
  g('clone', '-q', '--bare', work, origin)
  g('-C', work, 'checkout', '-qb', 'feat'); const c1 = commit('a.txt', 'one'); const c2 = commit('b.txt', 'two')
  g('-C', work, 'push', '-q', origin, `${c2}:refs/pull/17/head`)
  g('-C', repo, 'remote', 'add', 'origin', origin)
  reset({ reviewed: { 17: { sha: c1 } } })
  let r = run(['diff', '17', 'sess-a', '--sha', c2])
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /# DELTA/); assert.match(r.stdout, /b\.txt/); assert.doesNotMatch(r.stdout, /a\.txt/)
  reset({ reviewed: { 17: { sha: sha('9') } } })
  r = run(['diff', '17', 'sess-a'])
  assert.match(r.stdout, /# FULL review: 9+ is not an ancestor/); assert.match(r.stdout, /a\.txt/); assert.match(r.stdout, /b\.txt/)
  r = run(['diff', '17', 'sess-a', '--sha', sha('0')])
  assert.equal(r.status, 1); assert.match(r.stderr, /aborting/)
  // WP-121: two PRs under one session keep distinct base refs
  g('-C', work, 'push', '-q', origin, `${c1}:refs/pull/18/head`)
  assert.equal(run(['diff', '18', 'sess-a']).status, 0)
  const refs = g('-C', repo, 'for-each-ref', '--format=%(refname)', 'refs/review/sess-a/')
  assert.match(refs, /pr-17-base/); assert.match(refs, /pr-18-base/)
})

const agents = (...a) => fixture('agents.json', { result: { agents: a.map(([name, pane_id, agent_status, workspace_id = 'wR']) => ({ name, pane_id, agent_status, workspace_id })) } })
const drun = (args, env = {}) => run(['dispatch', ...args], { WATCH_PRS_HANDOFF: handoff, HERDR_PANE_ID: 'wO:p1', ...env })
const handed = () => readFileSync(join(fx, 'handoff'), 'utf8')

test('WP-121 mode: explicit arg wins; orchestrator → dispatch; reviewer, none or no herdr → standalone', () => {
  fixture('pane.json', { result: { pane: { tokens: { role: 'orchestrator' } } } })
  assert.equal(run(['mode'], { HERDR_PANE_ID: 'x' }).stdout.trim(), 'dispatch')
  assert.equal(run(['mode', 'review'], { HERDR_PANE_ID: 'x' }).stdout.trim(), 'review')
  assert.equal(run(['mode', 'acme/demo'], { HERDR_PANE_ID: 'x' }).stdout.trim(), 'standalone')
  fixture('pane.json', { result: { pane: { tokens: { role: 'reviewer' } } } })
  assert.equal(run(['mode'], { HERDR_PANE_ID: 'x' }).stdout.trim(), 'standalone')
  assert.equal(run(['mode']).stdout.trim(), 'standalone') // not in a herdr pane
  assert.equal(run(['mode', 'reveiw']).status, 1) // a typo is not standalone
})

test('WP-121 dispatch: claims under D, hands to a reviewer with pr/sha, cross-mode claim, cap and failure release', () => {
  fixture('pane.json', { result: { pane: { pane_id: 'wO:p1', tokens: { role: 'orchestrator' } } } })
  reset(); agents()
  let r = drun(['12', '--sha', sha('c'), '--session', 'sess-d'])
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /dispatched #12 to demo-reviewer-01/)
  assert.match(handed(), new RegExp(`ARGS --role reviewer --kind dispatch --pr 12 --sha ${sha('c')} --no-goal`))
  assert.match(handed(), new RegExp(`BODY Use wt-watch-prs to review 12 --sha ${sha('c')} --session sess-d`))
  assert.ok(existsSync(join(sd, 'claims', 'pr12')))
  r = drun(['12', '--sha', sha('c'), '--session', 'sess-e'])
  assert.equal(r.status, 1); assert.match(r.stdout, /held by sess-d/)
  assert.equal(drun(['12', '--sha', sha('c'), '--session', 'sess-d']).status, 0) // own claim, reviewer never replied: re-hand
  assert.equal(run(['claim', '12', 'sess-s']).status, 1) // a standalone watcher loses to the dispatch claim
  // at the cap (2 live reviewers, none free): release and exit 3
  reset(); agents(['r1', 'wR:p1', 'working'], ['r2', 'wR:p2', 'working'])
  r = drun(['13', '--sha', sha('d'), '--session', 'sess-d'])
  assert.equal(r.status, 3); assert.match(r.stdout, /queued: at maxReviewers \(2\)/); assert.ok(!existsSync(join(sd, 'claims', 'pr13')))
  reset(); agents(['r1', 'wR:p1', 'idle'], ['r2', 'wR:p2', 'working']) // a free reviewer at the cap still dispatches
  assert.equal(drun(['15', '--sha', sha('f'), '--session', 'sess-d']).status, 0)
  // maxReviewers 0 (project setting) queues even with a free reviewer
  const zero = join(tmp, 'zero'); mkdirSync(join(zero, 'data'), { recursive: true })
  const zdb = new DatabaseSync(join(zero, 'data', 'wt.db'))
  zdb.exec("CREATE TABLE project_settings (project TEXT, key TEXT, value TEXT); INSERT INTO project_settings VALUES ('demo', 'maxReviewers', '0')"); zdb.close()
  reset(); agents(['r1', 'wR:p1', 'idle'])
  assert.equal(drun(['16', '--sha', sha('f'), '--session', 'sess-d'], { WT_DASHBOARD_DATA: zero }).status, 3)
  reset(); agents()
  assert.match(drun(['17', '--sha', sha('f'), '--session', 'sess-d'], { HERDR_PANE_ID: '' }).stderr, /needs a herdr pane/)
  r = drun(['14', '--sha', sha('e'), '--session', 'sess-d'], { HANDOFF_FAIL: '1' })
  assert.equal(r.status, 1); assert.ok(!existsSync(join(sd, 'claims', 'pr14')))
})

test('WP-121 re-dispatch: the recorded reviewer gets --pane when idle; working or gone → pool pick', () => {
  fixture('pane.json', { result: { pane: { pane_id: 'wO:p1' } } })
  reset({ reviewed: { 12: { sha: sha('a'), state: 'changes-requested', reviewer: 'r1' } } }); agents(['r1', 'wR:p7', 'idle'])
  assert.equal(drun(['12', '--sha', sha('b'), '--session', 'sess-d']).status, 0); assert.match(handed(), /--pane wR:p7/)
  reset({ reviewed: { 12: { reviewer: 'r1' } } }); agents(['r1', 'wR:p7', 'working'])
  assert.equal(drun(['12', '--sha', sha('b'), '--session', 'sess-d']).status, 0); assert.doesNotMatch(handed(), /--pane/)
  reset({ reviewed: { 12: { reviewer: 'r1' } } }); agents()
  assert.equal(drun(['12', '--sha', sha('b'), '--session', 'sess-d']).status, 0); assert.doesNotMatch(handed(), /--pane/)
})

test('WP-121 record --by stores the reviewer; a bad name is refused', () => {
  reset()
  let r = run(['record', '12', sha('a'), 'changes-requested', 'x', 'sess-d', '--by', 'demo-reviewer-01'])
  assert.equal(r.status, 0, r.stderr)
  assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).reviewed[12].reviewer, 'demo-reviewer-01')
  r = run(['record', '12', sha('a'), 'approved', 'x', 'sess-d', '--by', 'Bad Name'])
  assert.equal(r.status, 1); assert.match(r.stderr, /bad --by/)
  assert.equal(run(['record', '12', sha('a'), 'approved', 'x', 'sess-d']).status, 0) // old callers unchanged
})

test.after(() => { assert.ok(!existsSync(join(tmp, 'home', '.claude'))); rmSync(tmp, { recursive: true, force: true }) })
