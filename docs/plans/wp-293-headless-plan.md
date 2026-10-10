# WP-293 — spawnable headless agent (spike): technical plan

Point-in-time (2026-10-10). Inputs: `wp-290-session-api-spike.md` (stream-json protocol), `wp-294-t3code-review.md` (copy
sequenced events, startup reconcile, idle release; add a cap and a stuck-turn watchdog).

## Technical decision

| Question | Options | Choice |
|---|---|---|
| Process driver | Agent SDK package; `claude -p` stream-json child; pane + keystrokes | **Plain `claude -p --input-format stream-json --output-format stream-json --verbose --permission-prompt-tool stdio`**, unmodified binary, user's login, no key, no new dependency (the "no Claude API in the dashboard" rule). `--permission-mode` is always explicit (the user's default is `bypassPermissions`, which would never ask). |
| Where the code lives | new skill; inside wt-dashboard | **`skills/wt-dashboard/headless.mjs`** (`Headless` class) + server routes; one skill, one commit. |
| Event store | files; wt.db | **wt.db** (`headless_runs`, `headless_events` with an `AUTOINCREMENT` seq, `headless_asks`), migration appended to `store.mjs`. Not exported/backed up (a run is operational state). |
| Streaming | new transport; existing SSE | **Snapshot-then-stream**: `GET /api/headless/:id/events?after=N`, an SSE `/stream` with `id:` = seq, and the existing `changes` stream (`headless` kind) to refresh lists. The Conversation view keeps its existing transcript SSE (the run's own session JSONL) so `ChatMessageRow` is reused unchanged. |
| Bounding | unbounded; capped | stored lines ≤256 KB (stub beyond), 2000 events per run retained, SSE page ≤500. |
| Cap | none (t3code); global cap + FIFO queue | **Cap 3 (`WT_HEADLESS_CAP`)**, spawn beyond it is `queued` and starts when a slot frees. |
| Idle / stuck | idle only (t3code); + watchdog | idle release 30 min; **stuck turn**: `working` with no events for 10 min → interrupt, then stop after a grace; both reasoned in the run's `reason`. |
| Crash | none; resume by session id | crash mid-turn → re-queue with `--resume <session>` up to 2 times, then `failed`. |
| Restart | adopt processes; end them | **Reconcile at startup**: runs left live are ended ("server restarted … resume by session id"), open asks expired with the reason; the recorded pid is SIGTERMed only when `ps` still shows a stream-json `claude` there. |
| Kill | pkill by pattern; recorded pid | **Recorded pid only** (stdin EOF first, then `process.kill(pid)`); never pkill/pgrep (CLAUDE.md traps). |
| Permissions | allow all; policy by role | `reviewer`/`pr-watcher`/`auditor`: Read/Grep/Glob auto-allowed, any other tool denied; every other role and every `AskUserQuestion`: an open ask for the human. |
| Env | inherit | minimal env (HOME, PATH, USER, TERM) — no `ANTHROPIC_API_KEY`, no `HERDR_*`. |
| Dispatch / tokens | include in `agents()` | **Not in `agents()`**: rows are appended to `GET /api/agents` only (`headless:true`), so Dispatch, token sync and pane routes never see them. Existing agents and CLIs unchanged. |

Risks: a headless session does not load the TUI mods (to be measured); `claude` memory per agent (measure with `rss()`);
resuming a session another process holds interleaves silently (WP-290) — the supervisor only resumes its own runs.

## Product decisions
Pending the user; built as settings with interim defaults (product-planner and orchestrator, 2026-10-10):
- product decision: headless roles allowlist `WT_HEADLESS_ROLES`, default `pr-watcher` (product-planner)
- product decision: cap `WT_HEADLESS_CAP` 2 with a FIFO queue (product-planner; the ticket said 3)
- product decision: idle release 30 min `WT_HEADLESS_IDLE_MIN` (product-planner)
- product decision: prompting permission mode (`--permission-mode default`), asks in the Conversation view AND the Inbox (`WT_HEADLESS_INBOX`, default on; kind `headless-ask`) (orchestrator)
- product decision: stuck turn (10 min, `WT_HEADLESS_STUCK_MIN`) flagged only; `WT_HEADLESS_STUCK_ACTION=interrupt|kill` opt-in (product-planner)
- product decision: no automatic resume after a crash or restart (`WT_HEADLESS_RESUMES` 0); resume is a manual action (product-planner)
- product decision: "headless" badge, ids `hl-…`, ended rows kept 6 h, trial jobs as listed (product-planner)

## Units (non-overlapping files)

| Unit | Owner | Files | Proves |
|---|---|---|---|
| U1 supervisor tests + hardening | worker | `skills/wt-dashboard/headless.mjs`, `store.mjs`, new `headless.test.mjs`, new `test-fixtures/fake-claude.mjs` | cap+queue, idle release, stuck watchdog, crash-resume, reconcile, ask expiry, seq/cursor, bounded events, kill-by-recorded-pid, answer + interrupt over a fake stream-json child |
| U2 routes | worker | `skills/wt-dashboard/server.mjs` (headless block only), new `headless.routes.test.mjs`, `docs/features.md` | POST/GET/message/interrupt/answer/events/stream, agent-pane auth, Agents-list row, scratch data dir + port, fake child |
| U3 web | worker | `skills/wt-dashboard/web/src/*` (badge, Conversation view events + ask controls) | typecheck, web unit tests, `npm run build`, agent-browser check |
| U4 CLI | worker | `skills/wt-agents/scripts/agents.sh`, `skills/wt-agents/scripts/*.test.mjs` | `spawn --headless <role> [cwd] [--prompt]`, other spawn shapes unchanged |
| U5 trials + report | tech-lead | `docs/plans/wp-293-headless-spike.md` | two trial jobs with a real throwaway `claude` (haiku) in a temp dir |

Order: U1, U2, U3 in parallel (≤3 workers), U4 when one frees. `package.json` test list is edited by the tech-lead at
integration (one line per new test file) to avoid overlap.
