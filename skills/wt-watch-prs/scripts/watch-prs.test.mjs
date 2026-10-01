// Run: node --test skills/wt-watch-prs/scripts/*.test.mjs — WP-116: watch-prs.sh against a gh stub and fixture JSON,
// with a temp HOME so the real state dir (read by the dashboard) is never touched.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync, execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, chmodSync, readFileSync, rmSync, existsSync, utimesSync, realpathSync } from 'node:fs'
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
// WP-187: "pane get" also fails for whatever pane id is written to fx/gone-pane (a registered watcher whose
// pane vanished); launchctl stubs poller-status' loaded check via fx/launchctl-loaded.
writeFileSync(join(bin, 'herdr'), `#!/bin/sh
case "$1 $2" in
  "pane get") [ "$3" = none ] && exit 1
    [ -f "${fx}/gone-pane" ] && [ "$3" = "$(cat "${fx}/gone-pane")" ] && exit 1
    cat "${fx}/pane.json" ;;
  "agent list") cat "${fx}/agents.json" ;;
  "workspace list") echo '{"result":{"workspaces":[{"label":"demo-reviewers","workspace_id":"wR"}]}}' ;;
esac
`)
chmodSync(join(bin, 'herdr'), 0o755)
writeFileSync(join(bin, 'launchctl'), `#!/bin/sh
[ "$1" = print ] && { [ -f "${fx}/launchctl-loaded" ] && exit 0 || exit 1; }
exit 0
`)
chmodSync(join(bin, 'launchctl'), 0o755)
const handoff = join(tmp, 'handoff.sh')
writeFileSync(handoff, `#!/bin/sh
{ echo "ARGS $*"; echo "BODY $(cat)"; } > "${fx}/handoff"
{ echo "CALL $*"; } >> "${fx}/handoff-calls"
[ -n "\${HANDOFF_FAIL:-}" ] && exit 1
echo "created demo-reviewer-01 wR:p1"; echo "target demo-reviewer-01 wR:p1"
`)
chmodSync(handoff, 0o755)
execFileSync('git', ['-C', repo, 'init', '-q'])

const wh = join(home, '.local/share/wt-watch-prs') // WP-187: top-level poller state (watchers.json, unwatched.json, poller.beat, unconsumed/)
const sd = join(wh, 'acme-demo'), stateFile = join(sd, 'state.json')
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
  // WP-187: poller state is shared across tests (top-level, not per-repo) — clear it too.
  for (const p of ['watchers.json', 'unwatched.json', 'poller.beat']) rmSync(join(wh, p), { force: true })
  rmSync(join(wh, 'unconsumed'), { recursive: true, force: true })
  for (const p of ['gone-pane', 'launchctl-loaded', 'handoff-calls', 'handoff']) rmSync(join(fx, p), { force: true })
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

test('WP-187: poll-shas persists fired across separate --once processes (a Monitor re-arm)', () => {
  reset(); fixture('list.1.json', [pr(21, sha('1'))])
  assert.match(run(['poll-shas', '--once']).stdout, /PR #21 — new commits/)
  // A fresh process (simulating a re-armed Monitor) does not re-announce the same head within the TTL.
  fixture('list.2.json', [pr(21, sha('1'))])
  assert.equal(run(['poll-shas', '--once']).stdout, '')
  assert.ok(existsSync(join(sd, 'poll', 'shas.fired')), 'fired baseline persisted')
})

test('WP-188: restart seeds the vanished-PR baseline from state.json instead of starting empty', () => {
  // #20 was reviewed and never recorded merged/closed (still "open" as far as state.json knows) but is gone
  // from the very first poll after a restart — the old empty-baseline would silently miss it forever.
  reset({ reviewed: { 20: { sha: sha('2') }, 21: { sha: sha('1') }, 22: { sha: sha('3'), state: 'merged' } } })
  fixture('list.json', [pr(21, sha('1'))]) // #20 gone; #22 already recorded terminal, rightly not re-checked
  fixture('view-20.json', { state: 'MERGED', title: 'pr 20', author: { login: 'dev' } })
  const out = run(['poll-shas', '--once']).stdout
  assert.equal(out.trim(), 'PR #20 — NO LONGER OPEN — MERGED — dev: pr 20')
  assert.doesNotMatch(readFileSync(join(fx, 'calls'), 'utf8'), /view-22|view 22/) // never even asked about #22
})

test('WP-187: poll-replies persists seen ids and the since cursor across separate --once processes', () => {
  reset({ reviewed: { 23: { sha: sha('a'), state: 'changes-requested', reviewer_session: 'sess-a' } } })
  fixture('comments.json', [{ id: 9, user: { login: 'dev', type: 'User' }, body: 'first reply' }])
  fixture('reviews.json', [])
  let out = run(['poll-replies', '--session', 'sess-a', '--once']).stdout
  assert.match(out, /PR #23 — REPLY on a held PR — dev: first reply/)
  assert.ok(existsSync(join(sd, 'poll', 'replies-sess-a.seen')))
  assert.ok(existsSync(join(sd, 'poll', 'replies-sess-a.since')))
  // A fresh process for the same session does not re-announce the id it already saw.
  out = run(['poll-replies', '--session', 'sess-a', '--once']).stdout
  assert.doesNotMatch(out, /first reply/)
})

test('WP-187: register/unregister write watchers.json; re-registering the same session/repo replaces its row', () => {
  reset(); fixture('pane.json', { result: { pane: { pane_id: 'wR:p9' } } })
  let r = run(['register', '--session', 'sess-p'], { HERDR_PANE_ID: 'wR:p9' })
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /registered acme\/demo session sess-p pane wR:p9/)
  let rows = JSON.parse(readFileSync(join(wh, 'watchers.json'), 'utf8'))
  assert.deepEqual(rows.map((w) => [w.repo, w.session, w.pane]), [['acme/demo', 'sess-p', 'wR:p9']])
  assert.equal(rows[0].cwd, realpathSync(repo)) // macOS resolves /var -> /private/var inside the child process
  // re-registering the same session+repo replaces the row rather than duplicating it
  r = run(['register', '--session', 'sess-p'], { HERDR_PANE_ID: 'wR:p9' })
  assert.equal(JSON.parse(readFileSync(join(wh, 'watchers.json'), 'utf8'), 'utf8').length, 1)
  // a second session on the same repo adds a second row
  run(['register', '--session', 'sess-q'], { HERDR_PANE_ID: 'wR:p9' })
  rows = JSON.parse(readFileSync(join(wh, 'watchers.json'), 'utf8'))
  assert.equal(rows.length, 2)
  r = run(['unregister', '--session', 'sess-p'])
  assert.equal(r.status, 0); assert.match(r.stdout, /unregistered acme\/demo session sess-p/)
  rows = JSON.parse(readFileSync(join(wh, 'watchers.json'), 'utf8'))
  assert.deepEqual(rows.map((w) => w.session), ['sess-q'])
  // no herdr / no HERDR_PANE_ID: registers with an empty pane rather than failing
  r = run(['register', '--session', 'sess-r'], { HERDR_PANE_ID: '' })
  assert.equal(r.status, 0); assert.doesNotMatch(r.stdout, / pane /)
})

test('WP-187: poller-status — no heartbeat, stale heartbeat, and the launchd-loaded gate (Linux: the pidfile gate, WP-192)', () => {
  const linux = process.platform === 'linux' // launchctl is macOS-only; Linux gates on the detached pidfile instead
  reset()
  let r = run(['poller-status'])
  assert.equal(r.status, 1); assert.match(r.stdout, /no heartbeat/)
  mkdirSync(wh, { recursive: true }); writeFileSync(join(wh, 'poller.beat'), '')
  if (linux) {
    writeFileSync(join(wh, 'poller.pid'), '2999999\n') // a recorded pid that is not running
    r = run(['poller-status']); assert.equal(r.status, 1); assert.match(r.stdout, /detached pid 2999999 is not running/)
    rmSync(join(wh, 'poller.pid'))
  } else {
    r = run(['poller-status']) // beat exists but launchctl says not loaded (no launchctl-loaded fixture)
    assert.equal(r.status, 1); assert.match(r.stdout, /not loaded/)
    writeFileSync(join(fx, 'launchctl-loaded'), '1')
  }
  r = run(['poller-status']) // loaded (or hand-run on Linux), fresh beat
  assert.equal(r.status, 0); assert.match(r.stdout, /loaded, beat \d+s ago/)
  const old = new Date(Date.now() - 200_000)
  utimesSync(join(wh, 'poller.beat'), old, old)
  r = run(['poller-status']) // loaded, but the beat is stale
  assert.equal(r.status, 1); assert.match(r.stdout, /\(stale\)/)
})

test('WP-187: serve delivers a new-commits event via handoff --kind system --pane <p>, once per line', () => {
  reset(); fixture('pane.json', { result: { pane: { pane_id: 'wR:p9' } } })
  run(['register', '--session', 'sess-p'], { HERDR_PANE_ID: 'wR:p9' })
  fixture('list.1.json', [pr(30, sha('3'))])
  const r = run(['serve', '--once'], { WATCH_PRS_HANDOFF: handoff })
  assert.equal(r.status, 0, r.stderr)
  const calls = readFileSync(join(fx, 'handoff-calls'), 'utf8').trim().split('\n')
  assert.equal(calls.length, 1)
  assert.match(calls[0], /--pane wR:p9 --kind system --no-goal --from wt-watch-prs/)
  assert.match(readFileSync(join(fx, 'handoff'), 'utf8'), /BODY PR #30 — new commits/)
  assert.ok(existsSync(join(wh, 'poller.beat')), 'heartbeat touched')
})

test('WP-196: serve tells a registered pane once when it resumes after a stale beat', () => {
  reset(); rmSync(join(fx, 'handoff-calls'), { force: true }); fixture('pane.json', { result: { pane: { pane_id: 'wR:p9' } } })
  run(['register', '--session', 'sess-p'], { HERDR_PANE_ID: 'wR:p9' })
  fixture('list.1.json', [])
  const old = new Date(Date.now() - 600_000); writeFileSync(join(wh, 'poller.beat'), ''); utimesSync(join(wh, 'poller.beat'), old, old)
  const r = run(['serve', '--once'], { WATCH_PRS_HANDOFF: handoff })
  assert.equal(r.status, 0, r.stderr)
  assert.match(readFileSync(join(fx, 'handoff'), 'utf8'), /poller resumed after 10m; replayed missed heads/)
  run(['serve', '--once'], { WATCH_PRS_HANDOFF: handoff }) // fresh beat now: no second notice
  assert.doesNotMatch(readFileSync(join(fx, 'handoff'), 'utf8'), /poller resumed/) // the last delivery is not the gap notice
})

test('WP-187: serve unregisters and records an unwatched notice for a watcher with no resolved pane', () => {
  // registered with no herdr / no HERDR_PANE_ID (empty pane) -- would otherwise poll forever with no
  // delivery and no unwatched notice, a silent black hole distinct from the three cases decision 5 covers.
  reset(); run(['register', '--session', 'sess-r'], { HERDR_PANE_ID: '' })
  fixture('list.1.json', [pr(50, sha('5'))])
  const r = run(['serve', '--once'], { WATCH_PRS_HANDOFF: handoff })
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(JSON.parse(readFileSync(join(wh, 'watchers.json'), 'utf8')), [])
  const uw = JSON.parse(readFileSync(join(wh, 'unwatched.json'), 'utf8'))
  assert.equal(uw.length, 1); assert.match(uw[0].reason, /no resolved pane/)
  assert.ok(!existsSync(join(fx, 'handoff')), 'never attempted a handoff with no pane to deliver to')
})

test('WP-187: serve unregisters and records an unwatched notice when the pane is gone', () => {
  reset(); fixture('pane.json', { result: { pane: { pane_id: 'wR:p9' } } })
  run(['register', '--session', 'sess-p'], { HERDR_PANE_ID: 'wR:p9' })
  writeFileSync(join(fx, 'gone-pane'), 'wR:p9')
  const r = run(['serve', '--once'], { WATCH_PRS_HANDOFF: handoff })
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(JSON.parse(readFileSync(join(wh, 'watchers.json'), 'utf8')), [])
  const uw = JSON.parse(readFileSync(join(wh, 'unwatched.json'), 'utf8'))
  assert.equal(uw.length, 1); assert.equal(uw[0].repo, 'acme/demo'); assert.match(uw[0].reason, /pane wR:p9 is gone/)
  assert.ok(!existsSync(join(fx, 'handoff')), 'never attempted a handoff for a gone pane')
})

test('WP-187: serve unregisters and records an unwatched notice after 3 consecutive handoff failures', () => {
  reset(); fixture('pane.json', { result: { pane: { pane_id: 'wR:p9' } } })
  run(['register', '--session', 'sess-p'], { HERDR_PANE_ID: 'wR:p9' })
  // three distinct new-commits events (distinct PR numbers) so WP-188's own TTL dedupe does not suppress
  // the 2nd/3rd — the failure counter is per-pane, driven by three separate delivery attempts.
  fixture('list.1.json', [pr(31, sha('1'))])
  run(['serve', '--once'], { WATCH_PRS_HANDOFF: handoff, HANDOFF_FAIL: '1' })
  fixture('list.2.json', [pr(31, sha('1')), pr(32, sha('2'))])
  run(['serve', '--once'], { WATCH_PRS_HANDOFF: handoff, HANDOFF_FAIL: '1' })
  assert.deepEqual(JSON.parse(readFileSync(join(wh, 'watchers.json'), 'utf8')).map((w) => w.session), ['sess-p'])
  fixture('list.3.json', [pr(31, sha('1')), pr(32, sha('2')), pr(33, sha('3'))])
  const r = run(['serve', '--once'], { WATCH_PRS_HANDOFF: handoff, HANDOFF_FAIL: '1' })
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(JSON.parse(readFileSync(join(wh, 'watchers.json'), 'utf8')), [])
  const uw = JSON.parse(readFileSync(join(wh, 'unwatched.json'), 'utf8'))
  assert.equal(uw.length, 1); assert.match(uw[0].reason, /handoff to wR:p9 failed 3 times in a row/)
})

test('WP-187: serve clears the failure counter on a successful delivery', () => {
  reset(); fixture('pane.json', { result: { pane: { pane_id: 'wR:p9' } } })
  run(['register', '--session', 'sess-p'], { HERDR_PANE_ID: 'wR:p9' })
  fixture('list.1.json', [pr(41, sha('4'))])
  run(['serve', '--once'], { WATCH_PRS_HANDOFF: handoff, HANDOFF_FAIL: '1' })
  fixture('list.2.json', [pr(41, sha('4')), pr(42, sha('5'))])
  run(['serve', '--once'], { WATCH_PRS_HANDOFF: handoff }) // succeeds — resets the counter
  fixture('list.3.json', [pr(41, sha('4')), pr(42, sha('5')), pr(43, sha('6'))])
  run(['serve', '--once'], { WATCH_PRS_HANDOFF: handoff, HANDOFF_FAIL: '1' })
  // only 2 consecutive failures since the reset — still watched
  assert.deepEqual(JSON.parse(readFileSync(join(wh, 'watchers.json'), 'utf8')).map((w) => w.session), ['sess-p'])
})

test('WP-202: an alive pane with an unclaimed event for 30+ min stays registered — re-delivered once, noticed once', () => {
  reset(); fixture('pane.json', { result: { pane: { pane_id: 'wR:p9' } } })
  run(['register', '--session', 'sess-p'], { HERDR_PANE_ID: 'wR:p9' })
  mkdirSync(join(sd, 'poll'), { recursive: true })
  const ft = Math.floor(Date.now() / 1000) - 3600
  writeFileSync(join(sd, 'poll', 'shas.fired'), `77 ${sha('7')} ${ft}\n`)
  fixture('list.1.json', []); fixture('list.2.json', []) // PR 77 absent from the open list, so poll-shas leaves its fired line alone
  const go = () => run(['serve', '--once'], { WATCH_PRS_HANDOFF: handoff })
  let r = go(); assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(JSON.parse(readFileSync(join(wh, 'watchers.json'), 'utf8')).map((w) => w.session), ['sess-p'])
  assert.match(readFileSync(join(fx, 'handoff-calls'), 'utf8'), /CALL --pane wR:p9 --kind system/)
  let uw = JSON.parse(readFileSync(join(wh, 'unwatched.json'), 'utf8'))
  assert.equal(uw.length, 1); assert.equal(uw[0].nudge, true); assert.match(uw[0].reason, /pane wR:p9 alive/)
  rmSync(join(fx, 'handoff-calls'), { force: true }); go() // second round: no repeat delivery, no second notice
  assert.ok(!existsSync(join(fx, 'handoff-calls')))
  assert.equal(JSON.parse(readFileSync(join(wh, 'unwatched.json'), 'utf8')).length, 1)
  assert.equal(JSON.parse(readFileSync(join(wh, 'watchers.json'), 'utf8')).length, 1)
})

test('WP-202: poller-status --expect-registered is unhealthy when running with 0 watchers for this repo', () => {
  reset(); mkdirSync(wh, { recursive: true }); writeFileSync(join(wh, 'poller.beat'), '')
  const linux = process.platform === 'linux'
  if (!linux) writeFileSync(join(fx, 'launchctl-loaded'), '1')
  assert.equal(run(['poller-status']).status, 0)
  let r = run(['poller-status', '--expect-registered'])
  assert.equal(r.status, 1); assert.match(r.stdout, /running but 0 watchers for acme\/demo/)
  run(['register', '--session', 'sess-p'], { HERDR_PANE_ID: '' })
  assert.equal(run(['poller-status', '--expect-registered']).status, 0)
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
  assert.match(handed(), new RegExp(`ARGS --role reviewer --kind dispatch --pr 12 --sha ${sha('c')} --skill wt-watch-prs --no-goal`))
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

test('WP-176 record --coverage stores full/partial, rejects garbage, works with --by in either order', () => {
  reset()
  let r = run(['record', '12', sha('a'), 'changes-requested', 'x', 'sess-d', '--coverage', 'partial'])
  assert.equal(r.status, 0, r.stderr)
  assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).reviewed[12].coverage, 'partial')
  r = run(['record', '12', sha('a'), 'approved', 'x', 'sess-d', '--coverage', 'bogus'])
  assert.equal(r.status, 1); assert.match(r.stderr, /bad --coverage/)
  r = run(['record', '13', sha('b'), 'approved', 'x', 'sess-d', '--coverage', 'full', '--by', 'demo-reviewer-01'])
  assert.equal(r.status, 0, r.stderr)
  let e = JSON.parse(readFileSync(stateFile, 'utf8')).reviewed[13]
  assert.equal(e.coverage, 'full'); assert.equal(e.reviewer, 'demo-reviewer-01')
  r = run(['record', '14', sha('c'), 'approved', 'x', 'sess-d', '--by', 'demo-reviewer-01', '--coverage', 'full'])
  assert.equal(r.status, 0, r.stderr)
  e = JSON.parse(readFileSync(stateFile, 'utf8')).reviewed[14]
  assert.equal(e.coverage, 'full'); assert.equal(e.reviewer, 'demo-reviewer-01')
  assert.equal(run(['record', '15', sha('d'), 'approved', 'x', 'sess-d']).status, 0) // no options still works
  assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).reviewed[15].coverage, undefined)
  r = run(['record', '16', sha('e'), 'approved', 'x', 'sess-d', '--coverage']) // dangling flag: must not hang
  assert.equal(r.status, 1); assert.match(r.stderr, /usage: record/)
})

test('WP-191 poller-install/uninstall hand off to poller-service.mjs (node stubbed: never touches the real launchd/systemd)', () => {
  writeFileSync(join(bin, 'node'), '#!/bin/sh\necho "NODE $*"\n'); chmodSync(join(bin, 'node'), 0o755)
  try {
    for (const c of ['install', 'uninstall']) {
      const r = run([`poller-${c}`])
      assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, new RegExp(`NODE .*poller-service\\.mjs ${c}\\n$`))
    }
  } finally { rmSync(join(bin, 'node'), { force: true }) }
})

test.after(() => { assert.ok(!existsSync(join(tmp, 'home', '.claude'))); rmSync(tmp, { recursive: true, force: true }) })
