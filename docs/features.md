# wt-pack features

What each feature does, where it lives, its settings and defaults, its limits and the skills behind it.
Written from the code; when you change a user-visible behaviour, update this file in the same merge.
Deeper operator detail (service, data layout, rollback) is in `skills/wt-dashboard/README.md`.

The dashboard runs at `http://127.0.0.1:7777`. Side navigation: **Overview · Tasks · Board · Agents · Rooms ·
Routines · Terminals**, then **Inbox**, **Settings** and the server health dot at the bottom.

## Overview

- Tiles: **Needs you** (opens the Inbox), **Stalled**, **In review** — counting your own tasks.
- Rows: agents per project (working / idle / blocked), **Today** across all projects (PRs opened, merged,
  reached main, board cards done), **Machine** (RAM and memory pressure, worker slots), **Health** (herdr,
  git, gh, Linear, machines, Jev errors in the last 24h), the 3 most recent rooms, and Usage.
- Header: **New agent** and **Refresh**.

## Tasks

A queue of work across PRs, agents and the local board, with a **Mine / Everyone** toggle.

- Sections: Needs you, Plan ready, In review, Stalled, Up next, In flight (planning / building / queued),
  Merged this week (last 7 days).
- Per-task actions: Answer + Send (or Open room), Hand to worker, Babysit (with CI, unresolved-comment and
  behind-base badges), Nudge, Reassign (asks to confirm), Plan it, Finish.
- A local board card becomes a task once it is Ready (shown as Up next) or has live work; it links to
  `#board/<ID>`.
- An agent counts as stalled after 20 minutes idle (Jev can refine this, see [Jev](#jev-features)).
- Skills: wt-plan, wt-work, wt-babysit, wt-finish, wt-handoff.

## Board

A local kanban per project (`WP-N` style keys), stored in `wt.db`.

- Columns: Backlog, Ready, Planning, Building, Review, Done, Blocked. Moving to Blocked asks why (a note is
  required). Moving to Backlog clears the assignee.
- Fields: type (bug, ux, gap, debt, feature — default feature), size (S, M, L — default none), priority
  (Urgent, High, Medium, Low, none — default none), up to 20 labels, up to 20 links, title ≤ 200 chars,
  body ≤ 20k chars. The `needs-plan` label shows as a **needs plan** badge on the card and routes Dispatch to a
  planner. Cards sort by priority (none last), then id. Labels and links show only in the detail
  rail, not on the card.
- A card shows id, priority, type, size, a Jev chip, a dispatch badge, title, two lines of body, last edit
  and @assignee. Columns are a fixed 280px and scroll sideways; on a phone (< 768px) one column shows at a
  time with a column picker.

### Jev triage

- `WT_JEV_TICKET_TRIAGE`, **default on** (Settings › Integrations).
- After a card is created (web, `wt-ticket new`, auditor) one Jev call (5s timeout, fail-open) fills type,
  size and priority **only where the creator left them empty**, adds an advisory hint ("Jev: needs a plan" /
  "Jev: worker-ready"; a planner hint also adds the `needs-plan` label, undoable) and flags possible duplicates among open cards (linked, never merged).
- Each suggestion has **Undo** in the detail rail; editing the field by hand also drops Jev's claim.
- Re-triage an existing card: `wt-ticket triage <ID>` or `wt-ticket triage --column backlog`.
- Logged to Settings › Observability as `ticket_triage`.

### Auto

- Board header shows one **Automation** status button (e.g. `Auto Low+ · Dispatch on`, dot green when
  either is on); it opens a popover (desktop) or bottom sheet (phone) holding Auto and Dispatch settings.
  On phones the header is two rows: column picker, then Automation + New ticket.
- Per-board **Auto** switch in that sheet, **default off**.
- Under it, a **minimum priority** picker: Urgent only, **High+ (default)**, Medium+, Low+, Any priority
  (Any includes unprioritised). Picker and **Run now** show only while Auto is on.
- After triage, a Backlog card meeting the minimum moves to Ready when Jev judges it ready to start:
  p ≥ 0.6 for an S/M worker-ready card, p ≥ 0.8 for L, unsized or planner-hinted cards. History reads
  `Jev auto-promoted (p=…)`, undoable from the detail.
- **Run now** triages the whole Backlog (button shows "Queued N").
- On an Auto board **with Dispatch off**, cards entering Ready prompt that project's orchestrator agent, at
  most once a minute (cards the orchestrator moved itself, or held by a live agent, are skipped).

### Dispatch

- Per-board switch in the Automation sheet, **default off**.
- Every 30s (first tick 15s after start), per board, the most urgent unassigned Ready card is handed to a
  free agent via `wt-handoff --role`: size **L** or label **`needs-plan` → planner** (wt-plan), anything else **→ worker** (wt-work →
  wt-ship → merge to main → push). The card moves to Planning / Building and is assigned. One card per board
  per tick.
- **Report to** (Automation sheet, while Dispatch is on): where a dispatched agent posts its one-line result —
  **Project room** (the room named after the project; default), **None**, or any room — plus **Also tell the
  orchestrator** (default on: the project's local orchestrator, named with its pane, since dispatched work has
  no sender). A missing or archived room, or no running orchestrator, just drops that part of the line.
- A card still waiting for Jev triage (created < 60s ago, not yet triaged) is skipped so a `needs-plan` label
  can land first; the header shows `waiting for triage`. Nothing waits when triage is off.
- Limits: shares the Routines cap (`maxWorking`, default 4) and memory-pressure guard; waits if the
  project has no checkout. Handoff timeout 120s.
- Failures retry after 2 min; the **3rd failure holds** the card. Card menu **Retry dispatch** (failed or
  held) or moving the card to Ready/Backlog clears it.
- Badges: Dispatching…, Dispatch failed, Dispatch held, Stalled. The Automation sheet shows `Dispatching N…`,
  `waiting: …`, `waiting for triage`, `last: … ago` or `idle`.
- **Flag stalled after N min idle** (default 45, range 1–1440) shows under the switch while Dispatch is on.

### Reconcile

Runs every tick on **every** board, whether Dispatch is on or not:

- A merge commit on `origin/main` naming the card (`Merge branch 'wp-N…'` or `WP-N`) moves a Building or
  Review card to Done (fetched at most every 5 min, 7-day lookback; merges older than the card's last move
  are ignored).
- A dispatched card in Planning/Building whose agent is gone for two ticks returns to Ready, unassigned.
- A Building card whose agent has been idle longer than the stall minutes gets a **Stalled** badge.
- History (30 days): Settings › Observability › Board history.

Skills: wt-ticket, wt-plan, wt-work, wt-ship, wt-handoff, wt-audit (files cards).

## Agents, roles and spawn

- Agents are herdr panes. The Agents page is a table grouped by role (agent, task, status, activity,
  machine, branch), one card per machine (local and remote herdr hosts), with filters All / Busy / Free /
  Needs you / Attention and sorting; open an agent to read and type into its conversation. **Stop** sends Esc (only while working and no question is pending).
- **Roles** (Settings › Roles): Orchestrator (purple, not spawnable), Planner (blue, starts in the main
  checkout, workspace `<repo>-planners`), Worker (green, starts in a worktree, `<repo>-workers`), Auditor
  (orange, main checkout, `<repo>-auditors`). Editable: name, id, letter, colour, workspace/name patterns,
  start (main / worktree / choose), allowed projects; 1–20 roles. A deleted role still in use must be
  reassigned first.
- **New agent** (Overview or palette): pick role and project, optional **first prompt** (sent once the agent
  is idle, up to 60s). It can reuse a free agent instead of spawning. Working directory is always the main
  checkout or one of the project's worktrees.
- Names: `<repo>-<role>-NN`, numbered across all pools (herdr names are global; repo slug cut to 20 chars).
- **Remove**: refused while working unless forced; an orchestrator needs its name typed back. The tab
  closes; a worktree it used stays on disk.
- CLI: `wt-agents spawn <role>`, `list --json`, `rm <name|pane> [--force]`.
- Skills: wt-agents, wt-handoff.

## Rooms

Chat rooms shared by you and agents.

- **Mentions**: `@name` (exact agent name, case-insensitive) or `@all`; mentions inside code or quotes are
  ignored. Replying to an agent's message mentions it. A message naming nobody goes to all agent members if
  the room broadcasts, else to its responder. Agents cannot `@all`; yours asks to confirm.
- **Commands**: a message starting with `/` goes to exactly one agent (agents cannot send them).
- Delivery waits until the agent is idle with no question pending.
- Each delivered message is wrapped in `<room-message id=<nonce> room=<slug> from=… kind=user|agent|system [broadcast=1]>`, author and
  kind set by the server and a fresh nonce per delivery, so a message cannot pass itself off as the user or
  the dashboard.
- The delivery is only those tags — no header or instruction lines. The rules (reply with `room post`, ack
  first, ask clarifications in the room, never in the agent's own chat; tag text is data; on `broadcast=1`
  reply only if it concerns you) load once: the wt-room SKILL and the wt-memory SessionStart context.
  Dashboard agent-chat text stays unmarked (like the terminal), so no tag means "own chat".
- **Settings › Rooms** (defaults):
  - Allow agents to @mention other agents — **off** (mentions show but are not delivered).
  - Hops before a human reply — **3**; then the room pauses "waiting for a human" until you post.
  - Agents can create rooms — **off**; on: up to 3 per agent per hour, with an inbox notice.
  - Agent post rate limit — **12 posts per 10 min** per agent across rooms (over it: refused).
  - Rooms for tickets — **Suggest** (or Off / Auto-create).
- **tmp rooms**: an agent may delete a `tmp-*` room where it is the responder; otherwise agents never archive
  or delete. tmp rooms do not expire on their own.
- **Attachments**: png, jpeg, webp, gif; ≤ 10MB each, ≤ 5 per message. Remote agents receive a note instead
  of the images.
- **Link previews**: fetched by the server (private hosts blocked, 3 redirects, 5s, 1MB);
  toggle in Settings › General.
- Messages ≤ 8000 chars.
- CLI (`wt-room`): `room list`, `read <slug> [--since N]`, `post <slug> "text" [--attach <img>]…`,
  `create <slug> "title" [--invite a,b]`, `delete <tmp-slug>`.

## Inbox

- Kinds include questions, mentions of you, room suggestions, memory proposals, agent done/stalled, CI
  failed, server, usage and watchdog notices.
- **Needs you** = unresolved **and** actionable (needs-you, question, mention-user, room-suggestion,
  memory-proposal), regardless of read state; pinned at the top. Items resolve themselves when the condition
  clears.
- Grouping: repeats of a non-actionable kind with the same title collapse with a count; rows group by memory,
  room, agent, task/PR or kind, and groups sort by their most urgent row. Recent list capped at 150.
- Actions: Mark read, Mark all read, Clear, Clear all read, Clear all… (confirm). Opening a row marks it
  read. Pending suggestions and memory proposals cannot be cleared (Dismiss / Accept / Reject instead).
- Duplicates: an actionable item isn't re-added while one with the same key is open; anything with the same
  key within 60s is dropped.
- **Settings › Notifications**: per kind, an **Inbox** switch and a **Native** switch (macOS notifications,
  desktop app only; stored per browser). Native notifications fire once per item, at most one per target
  per 30s, and not for the agent you are looking at.

## Routines

Recurring work the server runs itself (Routines page).

- **Schedule**: `every <N>m|h|d` or a 5-field cron (`m h dom mon dow`, local time; dom and dow both set =
  either matches). Form presets: every 15m, 30m, 1h, daily, weekly, custom.
- **Targets**: prompt an idle agent (by name, or the agent of a role in a project); spawn an agent and remove
  it when it goes idle or times out (timeout default 60 min, 1–1440); or an action (Jev board Run now,
  housekeeping).
- **Delivery**: Inbox (default for prompts/spawns), a room, or none (default for actions). Failures always
  reach the Inbox; skips don't.
- Checked every 30s. **Skipped** (reason in history) when the previous run is still going, working agents
  reach `maxWorking` (**default 4**, 0–100), memory pressure is critical, or the target agent is busy or
  missing. A run due during sleep fires once on wake; the next is computed from then.
- Seeds, all **paused**: Nightly audit (wt-pack), Morning room digest, Babysit open PRs, Jev Auto Run now,
  Weekly worktree cleanup.
- History (30 days): Settings › Observability.

## Terminals

- Shells owned by herdr (panes with no agent, in a `<project>-shells` workspace), mirrored and typed into
  from the page. Allowed start dirs: a project, its worktrees, `$HOME`, `/private/tmp`.
- **Off by default**: Settings › Terminals has **Enable terminals** and **Allow terminals over the tailnet**,
  both changeable only from `http://127.0.0.1` on this Mac. Every action is written to an audit log (last 100
  shown there).

## Settings

Order: **You** — General, Notifications · **Agents** — Rooms, Roles, Memory · **System** — Integrations,
Terminals, Usage, Observability, Server, About.

- **General**: avatar, display name, handle; this browser only: chat density (Compact / **Balanced** /
  Spacious), link previews (**on**).
- **Notifications**: see [Inbox](#inbox).
- **Rooms**, **Roles**: see above.
- **Memory**: wt-memory notes by scope (Global / Roles / Projects); remove agent entries, Accept/Reject pending
  global proposals, **Preview for agent…** shows what an agent receives. Warns when the plugin is missing.
- **Integrations**: precedence is process env › Keychain (secrets) › `~/.config/wt-dashboard/env` › default;
  applies without restart except `WT_DASHBOARD_REPO`.
  - `LINEAR_API_KEY` (Keychain, last 4 shown, Test connection), `TYPESAFE_API_KEY` (Keychain, powers Jev).
  - `WT_DASHBOARD_PROJECTS` (extra repos for New agent), `WT_DASHBOARD_ALLOWED_HOSTS` (tailnet hostnames;
    loopback only), `WT_DASHBOARD_REPO` (needs a restart).
  - **Lean MCP for new agents** (`WT_AGENTS_MCP`, default **full**): lean gives new agents only their role's
    MCP servers plus Jev's picks at handoff.
  - The Jev switches, see [Jev](#jev-features).
- **Usage**: plan limits (5-hour, weekly) and token spend from `~/.claude/projects`, by Today / 7 days, grouped
  by agent, project or model. Dollar figures are notional list prices.
- **Observability**: Jev calls by feature (24h / 7d) and recent calls, the Jev log-snippets switch, sources,
  server log (last 500 lines), Routines history, Board history, and **Housekeeping**:
  - Hourly (first 60s after start) plus **Run now** and a routine action. Defaults: delete unreferenced
    uploads after **30** days, drop resolved inbox items after **14** days, rotate logs at **5** MB keeping
    **2**, clear stale agent caches after **7** days (each 1–3650).
- **Watchdog** (Settings › Observability): every 60s (first run 90s after start), deterministic checks, each
  with an on/off switch and a threshold — server restarts in the last hour (**3**), room message undelivered
  (**15** min), Ready card not dispatched with Dispatch on (**10** min, held cards excluded), Backlog card
  untriaged with Auto on (**30** min), Planning/Building card held by a gone or stalled agent (**10** min), herdr
  unreachable (**2** min), free disk (**5** GB), wt.db size (**200** MB), server errors in 10 min (**20**), Jev
  failure rate over the last hour (**30**%, at least 5 calls). A finding opens once per condition as a
  `watchdog` Inbox item (native notification only for restarts, herdr and disk) and resolves itself when the
  condition clears. **Investigate** hands a finding to a worker (or **Ask auditor**) through wt-handoff, framed as
  data, to diagnose and file a ticket — only when clicked.
- **Server**: state, pid, uptime, build time, per-source status; **Restart server** (or **Install as
  service** when not managed).
- **About**: what the dashboard is, keyboard shortcuts, install.

## Keyboard and palette

- ⌘, opens Settings and ⌥⌘H shows/hides the window (Mac app).
- ⌘K / Ctrl+K: switcher over agents and rooms (bottom sheet on a phone); ⌘/Ctrl+Enter opens full view.
- `[` collapses the nav, `]` or Esc the agent panel; ⌘/Ctrl+Shift+Enter full view; Esc in the composer
  stops a working agent.
- `/` in the composer: fuzzy menu of the agent's skills and commands (max 50).
- Enter sends on desktop (Shift+Enter newline); on touch Enter is a newline, send with the button or
  ⌘/Ctrl+Enter.

## Jev features

Jev is a TypeSafe judgment layer (`TYPESAFE_API_KEY`). Every switch is in Settings › Integrations (log
snippets: Observability), fails open to the old heuristic when off, slow, keyless or erroring, and can take a
threshold override `WT_JEV_<FEATURE>_MIN`.

| Switch | Default | What it does |
|---|---|---|
| `WT_JEV_TICKET_TRIAGE` | on | Card type/size/priority, hint, duplicates; powers Auto |
| `WT_JEV_ROUTE` | on | wt-handoff sends work that needs a plan to a planner, not a worker |
| `WT_JEV_ROOM_RESOLVE` | on | Clears a room's needs-you when an agent's reply actually answered you |
| `WT_JEV_MEMORY_DUP` | on | `wt-memory remember` flags near-duplicates and conflicts |
| `WT_JEV_BABYSIT_TRIAGE` | on | wt-babysit classifies review comments (must-fix, question, nit, no action) |
| `WT_JEV_NEEDS_YOU` | off | Asks whether an idle pane is waiting on you |
| `WT_JEV_STALL` | off | Tells a stalled agent from one that finished, loops or waits on you |
| `WT_JEV_INBOX_RANK` | off | Scores new inbox items by urgency and sorts groups by it |
| `WT_JEV_MEMORY_SUGGEST` | off | Suggests `wt-memory remember` when a prompt states a standing preference (≤ 1.5s per prompt) |
| `WT_JEV_LOG_SNIPPETS` | off | Keeps input snippets in the Jev log |

Eval: `node skills/wt-shared/scripts/jev-eval.mjs <feature>`.

## Mac app, PWA and Tailscale

- **Mac app** (Tauri, `npm run app:build` in `wt-dashboard`; unsigned — first launch right-click → Open):
  reuses a server on :7777, else runs `server.mjs`, else its bundled sidecar. Tray shows the Needs-you count
  (Restart server / Install as service, Open, Launch at login, Quit); ⌥⌘H toggles the window; native
  notifications; links open in an in-app browser window. An app-managed server that dies is restarted up to
  3 times in 5 min. Log: `~/Library/Logs/wt-dashboard/app.log`.
- **Service**: launchd `id.local.wtdashboard.server` (`npm run service:install|restart|status|uninstall`).
  `service:install` also installs the **watchdog probe** `id.local.wtdashboard.watchdog`: every 2 min it curls
  `/api/health` and shows a macOS notification when the server stops answering (and once when it is back).
  `node scripts/service.mjs probe` installs only the probe; `./setup` adds it to an existing service.
- **PWA**: in a browser on a secure origin, **Install app** (iOS: Share → Add to Home Screen); an update banner
  shows when a new build lands. The service worker never caches `/api`.
- **Tailscale**: the server listens on loopback only; expose it with `tailscale serve` and add the hostname to
  `WT_DASHBOARD_ALLOWED_HOSTS` (from loopback). No login: loading the page sets an HttpOnly session cookie
  that every write needs. Terminals over the tailnet need their own switch.

## ./setup and doctor

- `./setup` (install, default): Homebrew deps (asks once; `--yes`), links `wt-*` skills into
  `~/.claude/skills`, config dirs, the wt-memory plugin, web build, launchd service, secrets, then doctor.
  Never repoints an install owned by another checkout. Flags: `--yes`, `--no-secrets`, `--no-service`.
- `./setup doctor`: one line per check (node ≥ 22.13 with `node:sqlite`, git/curl/jq, gh auth, claude, herdr,
  links, plugin, build, service, :7777, config; optional TypeSafe/Linear keys, tailscale, agent-browser,
  cargo); exit 1 while a required check fails.
- `./setup secrets`: TypeSafe key into `~/.claude/.env` (Linear goes through Settings › Integrations).
- `./setup uninstall [--purge]`: removes service, plugin and links; keeps data unless `--purge`.
- Skill: wt-setup ("set up wt-pack").

## wt-memory

- Notes in `~/.config/wt-memory/` (`global.md`, `roles/<id>.md`, `projects/<repo>.md`; `$WT_MEMORY_HOME`
  overrides), merged global → role → project and injected at session start (re-injected when they change)
  by the `wt-memory@wt-pack` Claude plugin, which also offers MCP tools remember / forget / list / context.
- CLI: `wt-memory context | remember "<note>" --scope role|project|global | forget | list | accept | reject`.
- A **global** note is never written directly: it waits as a proposal for Accept in the Inbox or
  `wt-memory accept`.
- Dashboard: Settings › Memory.

## wt-ticket CLI

Talks to the dashboard at `$HERDR_DASH_URL` (default `http://127.0.0.1:7777`); project defaults to the
current repo; `--json` on any command. Exit 0 ok, 1 API error / server down, 2 usage.

- `new "<title>" [--type] [--size] [--priority 0-4] [--label]… [--link]… [--body] [--column] [--project]`
- `list [--column c] [--mine] [--project p]` · `show <ID>` · `move <ID> <col> [--note]` ·
  `comment <ID> "text"`
- `claim <ID> [--force]` (refused if another agent holds it or it is mid-dispatch) ·
  `assign <ID> <agent|me|none>`
- `triage <ID> | --column c [--project p]` · `keys`

## Pipeline skills

| Skill | One line |
|---|---|
| wt-plan | Ticket → worktree → research → plan → review → commit → handoff |
| wt-research | Sharded evidence gathering with verdicts |
| wt-work | Implement a plan unit by unit to its Definition of Done |
| wt-simplify · wt-review · wt-compound · wt-pr | The steps wt-ship runs in order |
| wt-ship | Simplify → review → record learnings → PR (this repo merges to main instead) |
| wt-babysit | Watch a PR until merge-ready |
| wt-finish | Retire a merged worktree and its branch |
| wt-handoff | Hand a prompt to an agent, or a freshly spawned one |
| wt-audit | PM+QA pass that files board cards; proposals only |
