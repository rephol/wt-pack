# WP-293: spawnable headless agent (spike report)

Point-in-time (2026-10-10, Claude Code 2.1.296, macOS). The plan and recorded decisions are in `wp-293-headless-plan.md`.
Trials used the real `claude` binary (haiku) under the supervisor, with a scratch database and temp directories. Every
process was stopped by its recorded pid and the temp directories were deleted afterwards. No real agent, pane, session or
dashboard data was touched.

## What was built (opt-in, nothing else changes)

- `skills/wt-dashboard/headless.mjs`: a `Headless` supervisor. It owns one unmodified
  `claude -p --input-format stream-json --output-format stream-json --verbose --permission-prompt-tool stdio --permission-mode default`
  process per run, under the user's own login (`apiKeySource: none`). It has a minimal env (no API key, no `HERDR_*`),
  records pid, session id, cwd and role, sends messages as JSON lines on stdin, interrupts via `control_request`, and
  answers `can_use_tool` and `AskUserQuestion`. A run can be resumed by session id.
- wt.db (`store.mjs` migration): `headless_runs`, `headless_events` (store-assigned `AUTOINCREMENT` seq, 2000 kept per run,
  lines over 256 KB stored as stubs) and `headless_asks`. Reads go after a cursor (`events?after=N`), and SSE `/stream` uses
  `id:` = seq, so a reconnect resumes exactly. On server start, reconcile ends left-over runs and expires their open asks,
  each with a stated reason.
- Limits, all settings: cap `WT_HEADLESS_CAP` (2) with a FIFO queue in front of spawn, idle release after 30 min, a stuck-turn
  watchdog at 10 min without events (flag only by default; `WT_HEADLESS_STUCK_ACTION=interrupt|kill`), crash auto-resume
  `WT_HEADLESS_RESUMES` (0), and a role allowlist `WT_HEADLESS_ROLES` (`pr-watcher`). Kills use the recorded pid only (stdin
  EOF, then SIGTERM after a grace period).
- API: `POST /api/headless`, `/:id/message|interrupt|answer|stop|resume`, `GET /api/headless[/:id[/events|/stream]]`. Runs
  are appended to `GET /api/agents` (`headless: true`) but never to `agents()`, so Dispatch, token sync and pane routes
  are unchanged. An agent pane may only spawn and message. Open asks become `headless-ask` Inbox items
  (`WT_HEADLESS_INBOX`).
- CLI: `agents.sh spawn --headless <role> [cwd] [--prompt …]`, `list --headless`, `rm --headless <id>`. Every other shape
  is byte-identical.
- Web: a "headless" (or "queued") badge in the Agents list, and a state chip, stuck chip, Interrupt/Stop/Resume and
  Allow/Deny or option buttons in the Conversation view. Messages use the shared `ChatMessageRow` over the run's own
  session transcript.

## Trials (real `claude`, haiku)

| Trial | Result |
|---|---|
| Read-only reviewer: "which file defines Headless, what is its default cap?" in this repo | Correct answer ("headless.mjs", cap 2 + env/option precedence) in 6.5 s wall, 5.4 s turn. Read tools auto-allowed by the role policy, 0 denials. |
| Interrupt mid-turn (a long count) | `control_response` → `[Request interrupted]` user event → `result/success`; the process stayed up and went idle. |
| PR watcher, two scheduled ticks on a throwaway `state.json` | Tick 1: "13". State changed, tick 2: "14", and the attempted `Write note.txt` was denied by the read-only policy ("Write is not allowed for a pr-watcher agent"). 8 s for both ticks. |
| Crash (SIGKILL the recorded pid while idle) then manual resume | Run ended with "process ended: killed by SIGKILL". `resume` restarted with `--resume <session>`, and the agent recalled "Last tick I reported PR 14". |
| Browser check (integrated build, scratch server, fake claude, 412x700) | Badges in the Agents list; a blocked run shows Allow/Deny; Allow cleared "needs you" and resolved the Inbox item. |

## Questions answered

**Do the wt-pack plugin and mods load in `-p` mode?** Yes, the plugin does: `init.plugins` lists `wt-pack` and the user's
other plugins, the `wt-memory` and `wt` MCP servers connect, six `SessionStart` hooks run (wt-memory role and project
context is injected), and the slash commands include `/wt` and every `wt-pack:*` skill. What `-p` cannot give the mods is a
surface. There is no band, pane or prompt box, so the `/wt` panel has nothing to render into. `wt-ask` capture has
no TUI question to capture, but the supervisor sees `AskUserQuestion` directly as a `can_use_tool` request, which replaces
it. Room delivery types into a pane, which has no equivalent here; a headless agent should get room messages as stdin
user lines instead (not built). Not measured: whether the mods' `turn.*`/`prompt.submit` hooks fire per turn in `-p`.

**Supervisor cost and failure modes.** About 430 lines of Node (321 for the supervisor, about 110 for the routes and stream in `server.mjs`), with no dependencies.
Failure modes covered by tests (30 supervisor, 4 route): spawn failure, crash mid-turn, crash while idle, server restart
with live runs or open asks, a stuck turn, an oversized or split line, an event flood, a stale queued run, double stop,
cap re-entrancy, and pid reuse (reconcile kills only when `ps` still shows a stream-json `claude`). Known gaps: ask ids are
claude's own request ids (unique in practice). Two processes resuming the same session diverge silently (WP-290); the
supervisor only resumes its own runs.

**Is the event view good enough without a pane?** For supervised short jobs, yes. The Conversation view reuses the session
transcript, and state, asks, interrupt, stop and resume all work without a terminal. Weak points: with no transcript file
yet (or with the fake binary) the view shows "Transcript stream disconnected — retrying" over a skeleton, and transcript
rendering of a real headless run in the browser was not checked here (the routes reuse the same `streamTranscript` as pane
agents). The Overview merges `/api/agents` headless rows client-side (an extra fetch every 4 s), because adding them to
`overview()` would expose them to Dispatch.

**Memory and cost per agent.** RSS ≈ 310 MB per idle-to-working `claude -p` process (`ps`, one agent with the full plugin
set). Cap 2 is about 0.6 GB. The first turn is costly even on haiku: $0.157 for the reviewer's first answer, dominated by
the plugin, MCP and 59-tool context. Later small turns cost $0.001–0.007. A trimmed `--mcp-config`/plugin set per role would
cut both.

## Go / no-go for WP-292

**Go, scoped:** headless for short, read-only, scheduled roles (PR watcher first, then a nightly auditor). The protocol,
asks, interrupt, resume, cap and reconcile all held up with the real binary, under the user's own login, with no API key.
Before widening:
1. Trim each role's context (MCP and plugins) to cut the first-turn cost and the ~310 MB per process.
2. Deliver room messages and handoffs to a headless run as stdin user lines.
3. Check real-run transcript rendering in the Conversation view, and replace the disconnected banner with an empty state.
4. Settle the pending product defaults (cap, stuck action, Inbox, resume) with the user.

No-go for replacing pane agents with interactive work. Mods have no surface in `-p`, and the pane remains the better view.
