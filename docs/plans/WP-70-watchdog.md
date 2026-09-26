# WP-70 — Watchdog

## Shape
- `wt-dashboard/watchdog.mjs` (pure): `CHECKS` (id, label, unit, default threshold, severe), `cleanWatchdogSettings`,
  `evaluate(snap, settings, now)` → findings `{ check, key, severity, title, body }`, `diffFindings(open, findings, now)`
  → `{ open, opened, resolved }`. Tests: `watchdog.test.mjs`, one per check + dedupe/resolve.
- `server.mjs`: every 60 s build a snapshot (server-starts.json kept 1 h, rooms queue ages, boards + tickets,
  agents, `SOURCES.herdr`, `statfs` + wt.db size, an in-process console.error counter, jev-calls.jsonl),
  evaluate, persist `DATA/watchdog.json` (settings, open, recent resolved). Opened → Inbox kind `watchdog`
  (quiet unless severe → native pop); resolved → its Inbox item resolved.
- API `/api/watchdog`: GET state, PUT settings, POST run, POST investigate `{ key, role: worker|auditor }` →
  wt-handoff `--role` in the pack checkout. Never automatic.
- Web: `WatchdogSection` in Settings › Observability: per-check switch + threshold, open findings with
  Investigate (worker / auditor), Run now.
- Outside the server: `scripts/watchdog-probe.sh` + launchd `id.local.wtdashboard.watchdog` (StartInterval 120)
  installed by `service:install` (and so by ./setup), removed by `service:uninstall`: probes `/api/health`,
  `osascript` notification on the up→down transition only.

## Checks (defaults)
| id | fires when | default | severe |
|---|---|---|---|
| restarts | server starts in the last hour ≥ | 3 | yes |
| roomQueue | oldest undelivered room message older than (min) | 15 | |
| dispatch | Dispatch on, unassigned Ready card waiting longer than (min) | 10 | |
| auto | Auto on, Backlog card never triaged after (min) | 30 | |
| orphans | Planning/Building card whose assignee is gone or flagged stalled, for (min) | 10 | |
| herdr | herdr unreachable for (min) | 2 | yes |
| disk | free disk below (GB) | 5 | yes |
| db | wt.db larger than (MB) | 200 | |
| errors | server errors in the last 10 min ≥ | 20 | |
| jev | Jev failure rate over the last hour ≥ (%), at least 5 calls | 30 | |

No Claude API. Docs: docs/features.md.

## Evidence (read before planning)
- `server.mjs` `recordStart()` writes `restartBurst(...).recent` — only the last 5 min, so the file must keep 1 h for `restarts`.
- `rooms.mjs:230` `this.queue = new Map() // agentKey -> [{slug, msg, broadcast, command}]`; `msg.ts` gives the age.
- Tickets carry `created`, `history[{at, kind:'move'|'create', to}]`, `assignee.name`, `jev.at` (triaged), `dispatch.stalled`.
- `SOURCES.herdr = { ok, lastOkAt, lastError }` filled by `track('herdr', agents())`.
- jev-calls.jsonl rows: `{"ts":…,"feature":"ticket_triage",…,"err":null}`; `healthSummary` skips `test`/`eval:`/`probe`.
- Inbox: non-actionable kinds only dedupe for 60 s (`inbox.mjs` add), so the watchdog keeps its own open set; `quiet: true` = no native pop.
- `REPO` in server.mjs is the umkmall checkout — Investigate must use the pack checkout instead.

## Definition of Done
- `node --test watchdog.test.mjs` passes with one test per check plus open/resolve dedupe; `npm test` green.
- `curl /api/watchdog` (after restart) lists 10 checks and `open`; a forced low threshold opens a finding that appears in the Inbox once, and resolves when the threshold is restored.
- Settings › Observability shows the Watchdog card at 1440 and 390 (agent-browser screenshots).
- `launchctl list | grep wtdashboard.watchdog` shows the probe after `npm run service:install`.
