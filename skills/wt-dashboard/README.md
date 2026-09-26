# wt-dashboard

Local dashboard over herdr panes (planners, workers, orchestrator), the umkmall git worktrees, their PRs and Linear tickets.

```sh
npm --prefix web install      # once
npm run dev                   # API on 127.0.0.1:7777 + Vite on 127.0.0.1:5173 (proxies /api)
npm run build && npm start    # or: serve the built UI from node server.mjs on :7777
npm test                      # pane-parser self-check
```

- `LINEAR_API_KEY=lin_api_… npm run dev` shows Linear tickets (read-only GraphQL). Without it the board uses worktrees, PRs and agents only.
- `WT_DASHBOARD_REPO` (legacy `UMKMALL_REPO`) overrides the checkout path (default `~/Work/projects/umkmall`). Needs `herdr`, `git` and an authenticated `gh` on PATH.
- Refresh: agents/overview cached 3s, worktrees 10s, PRs 30s (GitHub rate limit), Linear 60s.

**Security:** the server binds to 127.0.0.1 only and rejects non-local `Host`/`Origin` headers and non-JSON POSTs. It can type into agents that run with bypassed permissions — never expose or proxy it beyond your machine.

## Desktop app (macOS, Tauri 2)

```sh
npm run app:build     # web build → Node SEA sidecar → tauri build
open app/src-tauri/target/release/bundle/macos/wt-dashboard.app
```

- Needs Rust (`~/.cargo/env`) and Xcode command-line tools. The app is unsigned: first launch via Finder right-click → Open (Gatekeeper).
- On start it reuses a server already answering `127.0.0.1:7777/api/health`, else it runs the live `server.mjs` from `$WT_DASHBOARD_HOME` or `~/.claude/skills/wt-dashboard` (symlink resolved), else the bundled `wt-dashboard-server` sidecar (server.mjs as a Node single executable). It restarts a crashed server and stops it on quit.
- **As a service (recommended):** `npm run service:install` runs the server as a launchd LaunchAgent (`~/Library/LaunchAgents/id.local.wtdashboard.server.plist`: node + this `server.mjs`, PATH from the login shell at install time, `KeepAlive` on crash only, `ThrottleInterval` 10). It starts at login, survives quitting the app, and the app only connects (or kickstarts it). `service:restart`, `service:status`, `service:uninstall`; logs in `~/Library/Logs/wt-dashboard/server.log`. Re-run `service:install` after moving the pack or changing node. The server reads `~/.config/wt-dashboard/env` itself.
- GUI apps get a minimal PATH, so the sidecar's PATH comes from `zsh -lc 'echo $PATH'` plus nvm, Homebrew, `~/.cargo/bin` and `~/.local/bin`.
- Env for the server (e.g. Linear, tailnet hosts): `~/.config/wt-dashboard/env` with `KEY=VALUE` lines, e.g. `LINEAR_API_KEY=lin_api_…`, `WT_DASHBOARD_ALLOWED_HOSTS=…`. The old `~/.config/herdr-dash/env` is read as a fallback (logged). Editable in Settings › Integrations (applies without a restart, except `WT_DASHBOARD_REPO`); precedence is process env var › Keychain (`LINEAR_API_KEY`, service `wt-dashboard`) › env file › default. Allowed hosts can be changed only from `http://127.0.0.1` on this machine.
- **Jev ticket triage** (`WT_JEV_TICKET_TRIAGE`, default on, Settings › Integrations): after a ticket is created (web, `wt-ticket new`, auditor) one Jev call (`ticketJev.mjs`, 5s, fail-open, logged to Observability as `ticket_triage`) fills type, size and priority only where the creator left them empty, adds an advisory planner/worker hint and flags likely duplicates among open tickets (links, never merged). The detail shows each suggestion with Undo (`POST /api/tickets/:id/jev-undo {field}`). Existing tickets: `POST /api/tickets/:id/triage` (`wt-ticket triage <ID>|--column backlog`) treats every field still at its default and never edited as empty. **Board 'Auto'** (per board, default off; Board header toggle, `PUT /api/tickets/board {project, auto}`, stored in `boards.auto`, wt.db migration 3): after triage a Backlog ticket moves to Ready when its priority meets the board's minimum (picker next to Auto: Urgent only, High+ (default), Medium+, Low+, Any — Any includes unprioritised; `boards.min_priority`, migration 4) and Jev judges it ready to start (p ≥ 0.6 for S/M worker-ready, ≥ 0.8 for L, unsized or planner-hinted); history `Jev auto-promoted (p=…)`, undoable from the detail. 'Run now' (`POST /api/tickets/board/run`) triages the whole Backlog. On an Auto board, tickets entering Ready (by anyone) prompt that project's orchestrator agent once per minute. Eval: `node wt-shared/scripts/jev-eval.mjs ticket_triage`.
- Logs: `~/Library/Logs/wt-dashboard/app.log`.
- **Routines** (#routines, `routines.mjs`, wt.db migration 5): recurring work the server runs itself, checked every 30s. Schedule: `every <N>m|h|d` or a 5-field cron (`m h dom mon dow`, `*`, lists, ranges, `*/n`, local time; dom and dow both set = either matches). Target: prompt an idle agent (by name, or the agent of a role in a project), spawn an agent and remove it when it goes idle or times out, or a local action (Jev board Run now, housekeeping). Skipped, with the reason in history, when the previous run is still going, when working agents (+ spawns starting) reach `maxWorking` (default 4, `PUT /api/routines/settings`), when memory pressure is critical, or when the target agent is busy or missing. Nothing keeps the Mac awake: a run due during sleep fires once on wake (next run is computed from now, not from the missed slot). Five seed routines ship paused; enabling one schedules it from now. History (30 days) is in Settings › Observability. API: `GET/POST /api/routines`, `PUT/DELETE /api/routines/:id`, `POST /api/routines/:id/run`, `GET /api/routines/runs`. A rollback to the JSON layout loses routines and their history (not exported).

- **Board Dispatch** (`dispatch.mjs`, wt.db migration 6; WP-52): a per-board switch next to Auto, **off by default**. Every 30s the server hands the most urgent unassigned Ready ticket (one per board per tick) to a free agent through `wt-handoff --role` (size L or label `needs-plan` → planner with `wt-plan`, else worker with wt-work → wt-ship → merge to main → push), then moves and assigns the card. A card created under 60s ago that Jev triage has not answered yet is skipped (`waiting for triage`; not when triage is off). It shares the Routines cap (`maxWorking`) and memory guard, but is not a routine. A failed handoff retries after 2 min; the third failure holds the card until "Retry dispatch" (`POST /api/tickets/:id/dispatch-retry`) or a move to Backlog. **Reconcile** runs on every board whatever the switch: a merge commit on `origin/main` naming the card (`Merge branch 'wp-N…'` or `WP-N`) moves a Building/Review card to Done; a dispatched card whose agent is gone for two ticks returns to Ready unassigned; an assignee idle longer than the board's stall minutes (default 45) gets a Stalled badge. The Ready notify to the orchestrator is skipped on Dispatch boards. History (30 days): Settings › Observability › Board history, `GET /api/board/events`. Rollback: `sqlite3 ~/.local/share/wt-dashboard/data/wt.db "UPDATE boards SET dispatch = 0"`.

## Data

Nothing is written into this source tree. The data root is `$WT_DASHBOARD_DATA`, default `~/.local/share/wt-dashboard`:
`data/` (`wt.db`: tickets, rooms, messages and the notifications inbox; plus settings.json and other small files) and `uploads/` (images pasted into the composer).

`wt.db` is SQLite via Node's built-in `node:sqlite` (**node >= 22.13**, checked by `./setup doctor`); the server is its only writer, the CLIs go through the API. On first start the old `tickets/`, `rooms.json`, `rooms/` and `notifications.jsonl` are imported once and moved to `data/pre-sqlite-<time>/`.

Rollback to a pre-SQLite commit: stop the service; `node wt-dashboard/store.mjs export --to ~/.local/share/wt-dashboard/data` (read-only on `wt.db`, writes the old JSON/JSONL layout); move `data/wt.db*` aside (required: a later start of the new code would otherwise ignore the newer JSON and log "legacy JSON newer than wt.db"); check out the old commit; restart.
Env names are `WT_DASHBOARD_*`; the old `HERDR_DASH_*` names still work as a fallback.

## Terminals

Shells that herdr owns: each is a pane with no agent in a `<project>-shells` workspace. The dashboard mirrors the screen (`pane read --format ansi`, streamed at ~300ms only while someone watches) and types into it (`send-text`, plus whitelisted `send-keys`: Enter, Tab, Esc, arrows, Backspace, Ctrl+C/D/Z/L, PageUp/PageDown, Home/End). A shell may start only in a project, one of its worktrees, `$HOME` or `/private/tmp`, and agent panes are refused. **Off by default:** Settings › Terminals turns it on, and separately allows the tailnet, both changeable only from `http://127.0.0.1` on this machine; every endpoint needs the page's session cookie. Creation, input, keys, close and settings changes are appended to `~/.local/share/wt-dashboard/data/terminal-audit.jsonl` (viewable in Settings). The command bar's Enter always runs the line, on a phone too.
