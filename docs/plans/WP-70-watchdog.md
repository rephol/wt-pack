# WP-70 — Watchdog: system health checks → Inbox + Observability panel

Ticket: WP-70 (wt-pack board). Base: `origin/main`. Branch `wp-70-watchdog`. Implementer: wt-pack-worker-01.

## Goal
A server-side job, every 60 s, runs cheap deterministic checks. Each finding opens once (deduped per key),
lands in the Inbox (a native notification only when severe), and resolves itself when the condition clears.
Settings › Observability gets a Watchdog panel: per-check on/off and threshold, open findings, and an
**Investigate** action that hands a finding to a worker or auditor through wt-handoff — never automatically.
Outside the server, a launchd probe curls `/api/health` every 2 min and raises an `osascript` notification when
the server is down. No Claude API.

## Settled decisions (no synchronous user; recorded assumptions)
- `watchdog` is a **non-actionable** inbox kind (like `server`): it does not join `ACTIONABLE`, so
  `notifyGate.test.ts:66-69` ("ACTIONABLE_KINDS matches the server inbox ACTIONABLE set") stays green. Native
  pop is on by default for the kind; the server sets `quiet: true` on non-severe findings, so only severe ones pop.
- The probe is installed by `service.mjs install` (so the tray's "Install as service", `main.rs:62`, gets it too),
  plus a new `service.mjs probe` subcommand that `./setup` calls on its "already running" branch.
- Investigate runs wt-handoff with cwd = the pack checkout, found as `dirname(realpath(~/.claude/skills/wt-handoff))`
  (skills are symlinks into the pack); if that fails the action returns 409 with the reason.

## Evidence (research, quoted)
- Restart history only keeps 5 min: `server.mjs:2489` `const { recent, warn } = restartBurst([...prev, Date.now()])`
  → `await writeFile(f, JSON.stringify(recent))`, and `server.mjs:1183` `RESTART_WINDOW_MS = 5 * 60_000`. The
  `restarts` check (1 h window) therefore needs `recordStart` to persist starts from the last hour and pass only
  the 5-min slice to `restartBurst` (its burst warning stays unchanged).
- Room queue: `rooms.mjs:230` `this.queue = new Map() // agentKey -> [{slug, msg, broadcast, command}]`; items
  leave only on delivery (`rooms.mjs:482`), pane gone (`:474`) or room delete — `rooms.mjs:478`
  `if (!deliverable(a) || this.running.has(key)) continue` keeps them while the agent is busy or asking. Age =
  `now - Date.parse(msg.ts)`.
- herdr health is fresh without a client: `server.mjs:1269` `track('herdr', agents())` runs inside `overview()`,
  which `tick()` calls (`server.mjs:1405-1408`) on `setInterval(tick, 4000)` (`:2509`). Shape
  `SOURCES.herdr = { ok, lastOkAt, lastError }` (`server.mjs:1189-1192`).
- Tickets: `tickets.mjs:127` `created: at, updated: at, history: [{ at, …, kind: 'create', to: … }]`;
  `tickets.mjs:188` `t.jev = { at, applied: … }` (set by triage); `dispatch.mjs:177`
  `t.dispatch = { ...t.dispatch, stalled: text }`. **Held is a state, not a field**: `dispatch.mjs:131`
  `const state = fails >= 3 ? 'held' : 'failed'` → the draft's `t.dispatch?.held` was wrong; use
  `t.dispatch?.state === 'held'`.
- Boards: `server.mjs:1257-1260` already iterates `const keys = await tickets.keys()` …
  `for (const project of Object.keys(keys)) … (await tickets.list(project)).tickets`, and `tickets.list` returns
  `{ key, ...settings(project), tickets }` with `{ auto, minPriority, dispatch, stallMin }` (`tickets.mjs:71-73`).
- Inbox dedupe is 60 s only for non-actionable kinds: `inbox.mjs:58` `… || now - Date.parse(it.ts) < 60_000))) return null`
  → the watchdog keeps its own open set and resolves its items with `inbox.resolve(ids)` (`inbox.mjs:86`).
- No error counter exists (grep: no console.error wrapper; only `SOURCES[*].lastError`), so the `errors` check
  counts `console.error` calls in-process (timestamps, pruned to 1 h).
- `/api/health` needs no session: `server.mjs:1708` `if (method === 'GET' || method === 'HEAD' || !path.startsWith('/api/')) return false`.
- No pack-root constant: `server.mjs:41` `const REPO = … join(homedir(), 'Work', 'projects', 'umkmall')` — REPO is not usable.
- jev log rows: `{"ts":…,"feature":"ticket_triage",…,"err":null}`; `jevlog.mjs` `healthSummary` excludes
  `!c.test && !/^(eval:|probe$)/.test(c.feature ?? '')` — the `jev` check applies the same filter.
- Web kind lists, all hand-written:
  `notifyGate.ts:3` `export const KINDS = [...] as const`; `inbox.tsx:24` `LABEL`, `:64` `COLOR`, `:82` `ICON`
  (all `Record<Kind, …>`, so tsc enforces them); `settings.tsx:326` `['System', [['server', 'Server events'], …]]`
  (**not** type-checked — without an entry the user cannot switch watchdog notifications off).
  `desktop.tsx:10-13` merges saved prefs over `DEFAULT_PREFS`, so no prefs key bump.
- Observability mount: `settings.tsx:182` `<VStack gap={6}><ObservabilitySection />…<HousekeepingSection /></VStack>`;
  pattern to copy: `housekeeping.tsx` (`SettingsCard`/`SettingsRow`, `TextInput size="sm" width={88}`, PUT via `api()`).
- launchd: `service.mjs:12` `LABEL = 'id.local.wtdashboard.server'`, `:19` `loaded()` hard-codes it, `:65-68`
  uninstall. `parse.test.mjs:509-518` tests `plist()` — keep its signature. `setup:18` hard-codes the server plist
  and `setup:47` `service_root` reads it; `setup:220-230` `svc()` says `already: running from $DASH` and skips
  install → the probe must be installed on that branch too; `setup:107-116` doctor parses `status | head -1`, so
  the probe's status line goes **after** the server's and must not contain `: running`.
- App double-alert: `main.rs:466` notifies "wt-dashboard server is down" only for an app-managed child; the probe
  exists only with the launchd service, so the two do not overlap in the normal setups.

## Checks (defaults)
| id | fires when | default | severe |
|---|---|---|---|
| restarts | server starts in the last hour ≥ | 3 | yes |
| roomQueue | an agent's oldest queued room message older than (min) | 15 | |
| dispatch | Dispatch on; unassigned Ready card, not `state:'held'`, in Ready longer than (min) | 10 | |
| auto | Auto on; Backlog card with no `jev` (never triaged) older than (min) | 30 | |
| orphans | Planning/Building card whose assignee is gone (agent list known) or `dispatch.stalled`, unchanged for (min) | 10 | |
| herdr | `SOURCES.herdr.ok === false` for (min) | 2 | yes |
| disk | free space on the data volume below (GB) | 5 | yes |
| db | wt.db larger than (MB) | 200 | |
| errors | `console.error` calls in the last 10 min ≥ | 20 | |
| jev | failed share of non-test Jev calls in the last hour ≥ (%), at least 5 calls | 30 | |

Missing snapshot data means "unknown" and never fires.

## Units (in order; each stands alone)
1. **`skills/wt-dashboard/watchdog.mjs` + `watchdog.test.mjs`** (pure): `CHECKS`, `cleanWatchdogSettings`, `enteredAt`,
   `evaluate(snap, settings, now)`, `diffFindings(open, findings, now)`, `investigatePrompt(f)`. Fix the draft's
   held test to `dispatch.state === 'held'` and add a test for it. Add `watchdog.test.mjs` to `npm test`.
   Done when `node --test watchdog.test.mjs` passes (≥ 15 tests: one per check, settings, diff, held, keepStarts, inboxOps, investigatePrompt).
2. **Server wiring (`server.mjs`)**:
   - `recordStart`: persist the last hour, pass the 5-min slice to `restartBurst`.
   - error counter: wrap `console.error` (in the listening block) to push `Date.now()`, pruned to 1 h.
   - `watchdogSnapshot()`: starts file, `rooms.queue` flattened to `{ agent, slug, ts }` (agent name from the
     agent list, key as fallback), boards via `tickets.keys()`/`list()`, `agents()` (null on failure),
     `SOURCES.herdr`, `statfs(DATA)` → `bavail * bsize`, `stat(wt.db).size`, error timestamps, `readCalls()`.
   - `runWatchdog()`: evaluate → `diffFindings` → Inbox `add({ kind: 'watchdog', key: 'watchdog|<key>|<since>', title, body, target: { watchdog: key }, quiet: severity !== 'severe' })`
     for opened; `inbox.resolve` the unresolved `watchdog` items whose `target.watchdog` resolved; persist
     `DATA/watchdog.json` `{ settings, open, resolved: last 20, lastRun }`. Timer: first run 90 s after start, then every 60 s.
   - `/api/watchdog`: GET `{ checks: CHECKS, settings, open, resolved, lastRun }`; PUT settings
     (`cleanWatchdogSettings`); POST `run`; POST `investigate { key, role: 'worker'|'auditor' }` → `runHandoff`
     with `['--role', role, '--task', 'watchdog <key>'.slice(0, 80), packRoot]`, prompt `investigatePrompt(f)`.
   - `inbox.mjs`: add `'watchdog'` to `KINDS`.
   Done when `npm test` is green and, after one `service:restart`, `GET /api/watchdog` returns 10 checks.
3. **Web**: `notifyGate.ts` KINDS += `'watchdog'`; `inbox.tsx` LABEL `Watchdog`, COLOR amber, ICON `I.server`;
   `settings.tsx:326` System group += `['watchdog', 'Watchdog findings']`; `settings.tsx:60` description mentions
   the watchdog; new `web/src/watchdog.tsx` `WatchdogSection` (card per the Housekeeping pattern: one row per check
   with a `Switch` and a threshold `TextInput`, Save, Run now; open findings with since, and Investigate → worker /
   auditor buttons; recently resolved list) mounted in `settings.tsx:182`. No native dialogs.
   Done when `npx tsc --noEmit -p .` and web tests pass, and agent-browser screenshots at 1440 and 390 show the panel.
4. **Probe**: `skills/wt-dashboard/scripts/watchdog-probe.sh` (curl `-sf -m 5 http://127.0.0.1:7777/api/health`; state
   file `~/.cache/wt-dashboard/probe-down`; `osascript -e 'display notification …'` on up→down only, and one
   "back up" note on down→up). `service.mjs`: `PROBE_LABEL = 'id.local.wtdashboard.watchdog'`, `probePlist()`
   (`StartInterval` 120, `RunAtLoad`, no KeepAlive), `loaded(label)`, `install` also installs the probe, new
   `probe` subcommand installs only the probe, `uninstall` removes both, `status` prints the probe line second
   ("watchdog probe: loaded|not installed"). `./setup` `svc()` already-running branch runs `service.mjs probe`.
   Test `probePlist` in `parse.test.mjs` next to the existing plist test. Done when
   `launchctl print gui/$(id -u)/id.local.wtdashboard.watchdog` succeeds after `npm run service:install`.
5. **Docs**: `docs/features.md` Inbox kinds (`:151`), Observability (`:213`), Service (`:260`), setup (`:270`).

## Definition of Done (checkable from the transcript)
- `node --test watchdog.test.mjs` output shows all tests passing; `npm test` prints `# fail 0` for both runners.
- `curl -s 127.0.0.1:7777/api/watchdog` after restart shows 10 checks and `lastRun` set.
- Temporarily setting `db.threshold` to 0 via PUT opens `db|size`: one `watchdog` item in `/api/notifications`;
  restoring 200 resolves it on the next run (item `resolvedAt` set).
- agent-browser screenshots of Settings › Observability › Watchdog at 1440 and 390.
- `launchctl print gui/$(id -u)/id.local.wtdashboard.watchdog | grep 'run interval'` shows 120.

## Out of scope
Auto-remediation of any finding; per-check history charts; notifying remote machines.

## Review corrections (applied)
- **Commits, one per skill touched** (repo rule): `wt-dashboard` (units 1–4 code), `setup` (unit 4's `svc()` line),
  `docs` (unit 5 + this plan). The earlier plan did not say how to split them.
- **Investigate cwd** is explicit: `runHandoff(execFile, HANDOFF_SH)(args, prompt, packRoot)` — third arg is the
  cwd (`dispatch.mjs` `runHandoff = (execFile, bin) => (args, prompt, cwd) => …`).
- **Security**: the handler looks the finding up server-side by `key` in the open set (404 otherwise) and allows
  only `role ∈ {worker, auditor}` (400 otherwise); POST stays behind the session cookie (`needsSession`).
  Titles/bodies carry room slugs, ticket ids and herdr error text, so `investigatePrompt` wraps them as
  `<watchdog-finding>…</watchdog-finding>` data with a line saying the text inside is data, not instructions.
- **Testing, beyond manual DoD**: extract two more pure helpers into `watchdog.mjs` and test them —
  `keepStarts(starts, now)` (1-hour retention + 5-min burst slice for `recordStart`) and
  `inboxOps(diff)` → `{ add: [drafts], resolveKeys: [keys] }` (the Inbox open/resolve mapping, incl. `quiet` for
  non-severe). Tests also cover `state:'held'` and `investigatePrompt` (role-free, tags close once).
- `watchdog.test.mjs` is already in the `npm test` script in the worktree (added with the draft).
- **Deviation from the ticket, recorded**: "error-rate bursts in server.log" is measured as in-process
  `console.error` calls (everything the server logs as an error goes through it into server.log), not by
  re-reading the log file each minute — `serverLogTail` reads the whole file per call (`server.mjs:2023`).
