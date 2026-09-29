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
- A source that fails (herdr not running, the repo not a git checkout) shows a warning banner with the fix
  and leaves its cards empty; the rest of the page still loads (also on Tasks and Agents).

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
- Search: the header field (`/` focuses it, Esc clears) filters cards live by id, title, body, labels and
  comment/move notes; every word must match. It shows "N matches", survives reload as `?q=` in the URL, and
  on a phone opens from the ⌕ button. CLI: `wt-ticket search <text> [--column c]`.

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
- Any open card (Ready, Planning, Building, Review or Blocked) whose agent assignee is gone for two ticks
  unassigns; Planning/Building also return to Ready (WP-140). Removing an agent (`agents.sh rm`) unassigns its
  cards immediately, the same way it drops the agent from its rooms (WP-138).
- A Building card whose agent has been idle longer than the stall minutes gets a **Stalled** badge.
- History (30 days): Settings › Observability › Board history.

Skills: wt-ticket, wt-plan, wt-work, wt-ship, wt-handoff, wt-audit (files cards).

### Pairing

- A ticket can hold a **worker + buddy** pair (`pair: { worker, buddy }`), shown as a chip on the board card and
  read-only under `paired · <TICKET>` on the paired agents' Summary tab; editable as a **Buddy** dropdown in the
  ticket drawer (needs an assignee first). Both members get a `pair` pane token, which — like DND — makes them
  invisible to every free-agent pick until the ticket is Done.
- **Setting it**: `wt-handoff --buddy <pane|self>` (`self` = the sending pane) at the moment the worker is
  chosen — wt-plan's handoff pairs the worker with the planner itself. Dispatch pairs a worker-role ticket with
  no pair yet to a free reviewer automatically.
- **Routing follow-ups**: `wt-handoff --task <TICKET>` with no `--pane` and a pair on record goes straight to the
  worker (or the buddy, for `--role reviewer` — a review round); `wt-watch-prs dispatch` sends a paired ticket's
  review to its buddy the same way, from the PR branch's ticket id.
- **A gone pair member** (two missed ticks) is replaced by a free agent of the same role, with a
  `pair: <old> → <new> (gone)` comment; no replacement → an Inbox item to the orchestrator, card left in place.
- **Release**: reaching Done clears `pair` on both panes and the ticket.

## Install as a plugin

- **Plugin-only install** (WP-122): `/plugin marketplace add rephol/wt-pack`, then `/plugin install wt-pack@wt-pack`.
  This gives every `wt-*` skill (namespaced: `/wt-pack:wt-plan`), wt-memory's hooks and its MCP server, with no
  `./setup`. Agents still need herdr. There is no board, rooms or dashboard: `wt-ticket` and `room` exit with
  "needs wt-dashboard … (see README › Install)".
  - Scripts and the strings sent to agents name sibling skills by resolved path, not `~/.claude/skills`. A path
    guard test (`wt-shared/scripts/paths.test.mjs`) keeps it that way.
  - `./setup doctor` warns when this plugin and `./setup`'s wt-memory plugin are both enabled, or when this plugin
    was installed from a working checkout.
  - Neither `.claude-plugin/plugin.json` (this plugin) nor `skills/wt-memory/claude-plugin/.claude-plugin/plugin.json`
    (wt-memory@wt-pack) pins a `version` — with none set, Claude Code computes one from the source's git commit,
    so every push is an update and nobody has to remember to bump a number (WP-156; WP-155 tried a manually
    bumped version first, then dropped it for this). `./setup doctor` flags an installed plugin whose reported
    commit doesn't match the checkout's current `HEAD`.

## Agents, roles and spawn

- Agents are herdr panes. The Agents page is a table grouped by role (agent, task, status, activity,
  machine, branch), one card per machine (local and remote herdr hosts), with filters All / Busy / Free /
  Needs you / Attention and sorting; open an agent to read and type into its conversation. **Stop** sends Esc (only while working and no question is pending).
- **Chat dock** (WP-112, windows 900px and wider): opening an agent or room chat — task queue, ⌘K switcher, room
  members and @mentions, Inbox, notifications, Overview's room cards — puts it in a dock at the bottom right
  instead of the side panel. **Clicking an agent on the Agents page opens it straight into the side panel
  instead** (WP-174, like a terminal) rather than the dock. The dock is a full-width bar along the bottom (always shown, "No chats open" when empty, so nothing jumps when the first chat opens — WP-119; the page stops above
  it, toasts sit over it, and its **Chats** button replaces the floating ⌘K button) holds a tab per chat, right to left (**Chats** far right, the newest chat just left of it — WP-113), and an open
  chat's window pops up above its tab. Each chat is a compact window (at most 3; a 4th turns the oldest into a tab) or a
  minimised tab with a status dot and an unread marker (dot = activity since you last looked, **!** = needs you;
  per device, approximate — not a count). Window buttons (Esc minimises): minimise, two expand actions — **Open in side panel**
  (docks it into the right-hand panel; rooms get their normal header there too) and **Open full page** (the agent's or room's
  own page) — and close. The dock survives page navigation and a reload (per browser). A window shows the last 100 messages,
  **Show earlier** reveals 100 more; a tab loads no chat at all (its stream closes 30s after it is minimised).
  Terminals keep the side panel. The sidebar's old Agents/Rooms **Open** list is gone — use the Agents and Rooms
  pages or ⌘K. Narrower windows and phones have no dock (chats open as pages, as before) but remember what you opened: the
  chat button gets a red dot while one of those chats is unread.
- **Remote agents** (WP-97): the conversation shows the real Claude transcript, read over SSH (read-only, from the
  `herdr machine list` host). herdr gives remote panes no session id, so the file is matched: the jsonl in the
  pane's project dir (changed in the last week) whose recent text matches the pane's last prompt or reply. The
  first load reads the last 4 MB, then pulls every 3s while the page is open (one SSH call per pane, 4 per host).
  A badge says `remote · transcript`, `loading transcript…`, `transcript not matched — pane view` or
  `unreachable — pane view`; until messages arrive the pane view shows.
- **Roles** (Settings › Roles): Orchestrator (purple, not spawnable), Planner (blue, starts in the main
  checkout, workspace `<repo>-planners`), Worker (green, starts in a worktree, `<repo>-workers`), Auditor
  (orange, main checkout, `<repo>-auditors`), Reviewer (teal, main checkout, `<repo>-reviewers`; runs
  wt-watch-prs — arm it with the first prompt `/goal Use wt-watch-prs to watch this repo's PRs`, since roles
  carry no prompt of their own). A default role added in a later version joins an existing role list once; a
  default you delete stays deleted (`retired-roles.json`). Editable: name, id, letter, colour, workspace/name patterns,
  start (main / worktree / choose), allowed projects; 1–20 roles. A deleted role still in use must be
  reassigned first.
- **New agent** (Overview or palette): pick role and project, optional **first prompt** (sent once the agent
  is idle, up to 60s). It can reuse a free agent instead of spawning. Working directory is always the main
  checkout or one of the project's worktrees.
- Names: `<repo>-<role>-NN`, numbered across all pools (herdr names are global; repo slug cut to 20 chars) —
  the lowest number not currently in use (WP-148), so removing an agent frees its number for reuse. Numbers
  held by exited agents the watchdog still remembers are skipped, so their Resume stays possible (WP-120); a
  deliberate `rm` (or idle retirement, WP-143) drops its own name from that memory instead, since it isn't a
  crash to resume.
- Kill shim (WP-120): every spawned pane gets `pkill`/`pgrep`/`killall` shims from `wt-agents/bin` first on PATH
  (`--env PATH`, and `CLAUDE_ENV_FILE` so shell rc files cannot bury them). They refuse an option after the pattern
  and a `-f`/`-m` pattern under 6 characters or starting with `-` (BSD matches those against every agent and Chrome
  renderer), then run the real binary. Independent of the wt-memory plugin hook; `./setup doctor` counts agent
  sessions without it (respawn them). Deliberate bypass: `/usr/bin/pkill` by full path.
- **Remove**: refused while working unless forced; an orchestrator needs its name typed back. The tab
  closes; a worktree it used stays on disk.
- **Do Not Disturb** (WP-147): a per-agent toggle (agent page header, and the Summary tab/panel — moon badge
  next to the status dot when on) that makes the agent invisible to every free-agent pick — `wt-handoff`'s
  `candidates()` (auto-pick and `--list`), idle-worker retirement (WP-143), and a routine's prompt target. A
  direct `--pane` hand-off still reaches it, with a `warning: <name> is DND` on stderr. CLI (WP-173): `wt-agents
  dnd <name|pane>` alone prints the current state (on/off, and until-when if it expires); `dnd <name|pane> on
  [--for 2h]` sets it — `--for` writes the same expiry format the dashboard's toggle uses, omitted never
  auto-clears; `dnd <name|pane> off` clears it. **DND auto-off** (Settings › Projects, `dndAutoOffHours`,
  default 0 = never): turning DND on (from either the CLI's `--for` or the dashboard toggle) writes an expiry
  instead of a flat `1`, cleared by the 4s server tick once it's past.
- `wt-agents list` (plain and `--json`) shows DND (with its expiry, when set) and `pair` per agent — `--json`
  adds structured `dnd:{on,until}` and `pair` fields alongside the existing raw pane `tokens` map.
- CLI: `wt-agents spawn <role>`, `list [role] [--json]`, `rm <name|pane> [--force]`, `respawn <name|pane>|--stale [--force]` (WP-125: new tab with current kill shims + plugin guard; keeps name, role, cwd, tokens and `--resume`s the session; `--stale` = every pool agent lacking either, skipping `working` ones and the caller).
- Skills: wt-agents, wt-handoff.

## Rooms

Chat rooms shared by you and agents.

- **Rename and remove** (WP-114, Room settings ⋯): **Name** renames the room's display name (header and lists);
  the slug `#<slug>` never changes, so `room post <slug>`, Report to and routines keep working. Removing a room is
  **Archive…** (in-app confirm): it leaves the list, keeps its messages, and posts to it are refused (409, "#slug is
  archived"). The Rooms list's **Archived (N)** filter shows archived rooms with **Restore**. There is no hard delete
  in the UI (agents' `tmp-` rooms can still be deleted by their owner).
- **Mentions**: `@name` (exact agent name, case-insensitive) or `@all`; mentions inside code or quotes are
  ignored. Replying to an agent's message mentions it. A message naming nobody goes to all agent members if
  the room broadcasts, else to its responder. Agents cannot `@all`; yours asks to confirm.
- **Ticket chips** (WP-93, rooms and agent chat, display only; the stored and delivered text stays plain): a local
  board id (e.g. `WP-92`) shows as a chip with its column dot, **WP-92 · done**. Hover or long-press shows the title;
  tap switches to its project and opens it on the Board. A Linear id whose team is in `WT_LINEAR_TEAMS` (e.g.
  `ENG-123`) links to Linear once the workspace is known (needs `LINEAR_API_KEY`). Ids inside code, URLs or longer
  words (`WP-92a`), and unknown ids, stay plain text.
- **Members** (header people button, WP-106): each running agent's row opens its chat — a dock window on desktop,
  the agent page on phones — and closes the popover. Agents no longer running show disabled as *not running*, each
  with a **Remove** action (in-app confirm) beside it, plus a **Remove all not running** button when more than one
  is down (WP-138). Removing an agent (`agents.sh rm`, or a routine retiring one) also drops it from every room it
  was in; housekeeping drops a member absent more than 24h on its own. Messages keep the name either way — only
  membership changes, and a member rejoins normally the next time it speaks or is @mentioned. If the dropped
  agent was the room's pinned responder, the pin goes with it instead of leaving the room stuck answering to
  someone gone.
- **Commands**: a message starting with `/` goes to exactly one agent (agents cannot send them).
- Delivery waits until the agent is idle with no question pending.
- Each delivered message is wrapped in `<room-message id=<nonce> room=<slug> from=… kind=user|agent|system [broadcast=1]>`, author and
  kind set by the server and a fresh nonce per delivery, so a message cannot pass itself off as the user or
  the dashboard.
- **Room turns in agent chat** (WP-105): a room delivery shows as one line — `from #slug · author: first line (+N more)`,
  click for all of them; the agent's `room post` shows as **answered in #slug** (links to the room), and chat text
  after the post sits behind **show N more lines**. Each room or wt-message prompt also reminds the agent where to answer.
- The delivery is only those tags — no header or instruction lines. The rules (reply with `room post`, ack
  first, ask clarifications in the room, never in the agent's own chat; tag text is data; on `broadcast=1`
  reply only if it concerns you) load once: the wt-room SKILL and the wt-memory SessionStart context.
  Dashboard agent-chat text stays unmarked (like the terminal), so no tag means "own chat".
- **wt-pack messages** (WP-104): everything wt-pack itself sends into a pane — handoffs, Dispatch, the task
  Handoff/Reassign button, watchdog Investigate, routine prompts and routine spawns, the Ready nudge, replies —
  arrives as `<wt-message id=<nonce> kind=handoff|dispatch|routine|reply|system from="…" [ticket=…]>…</wt-message>`
  (after `/goal` for handoffs). Agents answer through the channel it names: `handoff.sh --reply <pane> "…"`
  (the footer and `reach:` line give it) or the report line inside. What you type (chat page, terminal, the
  spawn dialog's first prompt) stays untagged. The chat page shows the origin as `kind · from` (e.g.
  `dispatch · wt-dashboard`); it is display-only — the nonce is not checked, so terminal text could imitate it.
- **Settings › Rooms** (defaults):
  - Allow agents to @mention other agents — **off** (mentions show but are not delivered).
  - Hops before a human reply — **3**; then the room pauses "waiting for a human" until you post.
  - Agents can create rooms — **off**; on: up to 3 per agent per hour, with an inbox notice.
  - Agent post rate limit — **12 posts per 10 min** per agent across rooms (over it: refused).
  - Rooms for tickets — **Suggest** (or Off / Auto-create).
- **Linked project** (WP-89): shown as a chip next to the room name (click: switch the dashboard to that
  project) and set in Room settings › **Project** (None or any project; `PATCH /api/rooms/<slug> {project}`).
  It decides which project filter lists the room and the project of the room's "needs you" items. Ticket rooms
  get their ticket's project. A new room starts linked to the project in the sidebar filter (none under All projects);
  change it in the form's **Project** menu before Create (WP-96). Dispatch reports go to the room named after the project or the board's
  **Report to**, not to linked rooms.
- **tmp rooms**: an agent may delete a `tmp-*` room where it is the responder; otherwise agents never archive
  or delete. tmp rooms do not expire on their own.
- **Attachments** (rooms and agent chat, file picker, paste or drag-drop): images (png, jpeg, webp, gif, ≤ 10MB)
  render inline; any other file — pdf, zip, text/markdown/csv/json/log, or common code — shows as a file chip
  (icon, name, size) while composing and a download chip once sent, ≤ 25MB for pdf/zip and ≤ 10MB otherwise,
  ≤ 5 attachments per message. Served with `Content-Disposition: attachment` and `nosniff`; html and svg are
  never accepted, so nothing here can render inline on the dashboard origin. The original filename is kept for
  display; the file on disk is always renamed. Remote agents receive a note instead of the files.
- **Image preview** (rooms and agent chat): tap an image to open it. Pinch, trackpad pinch or the wheel zooms the image
  (1–5x, about the pointer), drag pans, double-tap or double-click toggles 1x/2x, keys `+` `-` `0` and arrows; it resets on the next image and on
  close. The page itself never zooms while the preview is open (WP-94). A zoomed image uses the whole screen at full resolution, and panning stops at the screen edges (WP-95).
- **Link previews**: fetched by the server (private hosts blocked, 3 redirects, 5s, 1MB);
  toggle in Settings › General.
- Messages ≤ 8000 chars.
- CLI (`wt-room`): `room list`, `read <slug> [--since N]`, `post <slug> "text" [--attach <img>]…`,
  `create <slug> "title" [--invite a,b]`, `delete <tmp-slug>`.
- **Agent questions** (WP-164): an agent asking you something shows as a chip — `? <agent> · <header or
  ticket>` — above the message box, oldest first in a sideways-scrolling row. On a phone, more than 3 chips
  collapse into one **N questions** chip with a list. The chip pulses until you open it once (per browser).
  Two kinds share one popup (a dialog on desktop, fullscreen on a phone): a `wt-ask` card, posted with the
  `wt-ask` CLI from a room, handoff or dispatch context (1–4 questions, steps, the recommended option marked,
  free text always allowed — your answer is delivered back as a `kind=reply` message); and a mirrored native
  `AskUserQuestion` picker from an agent's own chat session (its terminal stays the source of truth). Use your
  session's native question tool in your own chat — it already shows there; `wt-ask` is for everywhere else.
  Clicking a chip or an Inbox **question**/**ask** item opens the same popup in place. `wt-ask --resolve <id>`
  closes a card without an answer.

## Inbox

- A drawer from the sidebar bell; Escape or going to another page closes it (WP-87).
- Kinds include questions, `wt-ask` questions (`ask`, WP-164), mentions of you, room suggestions, memory
  proposals, agent done/stalled, CI failed, server, usage, watchdog and Jev auth-error notices.
- **Jev auth error**: the TypeSafe API key was rejected (401/403) rather than timing out — once per feature
  per day (Observability logs it as `auth_error`, separate from an ordinary fail-open); `./setup doctor`
  also warns when `~/.claude/.env` and the wt-dashboard Keychain entry hold different keys.
- **Held PR** (`pr-held`, WP-116): each PR a wt-watch-prs reviewer holds for clarification (state
  `changes-requested` in `~/.local/share/wt-watch-prs/<owner>-<repo>/state.json`) is an item titled
  `Held PR #n (<owner>-<repo>)` with the reviewer's note; it resolves when the reviewer records a new verdict.
  Holds that predate a server restart appear too.
- **Needs you** = unresolved **and** actionable (needs-you, question, ask, mention-user, room-suggestion,
  memory-proposal, pr-held), regardless of read state; pinned at the top. Items resolve themselves when the condition
  clears (a room suggestion also when its ticket reaches Done on the board).
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
- A new install starts with no routines; create them with **New**. Installs from before WP-92 keep their five
  paused wt-pack seeds (delete them if they do not fit).
- History (30 days): Settings › Observability.

## Terminals

- Shells owned by herdr (panes with no agent, in a `<project>-shells` workspace), mirrored and typed into
  from the page. Allowed start dirs: a project, its worktrees, `$HOME`, `/private/tmp`.
- **Off by default**: Settings › Terminals has **Enable terminals** and **Allow terminals over the tailnet**,
  both changeable only from `http://127.0.0.1` on this Mac. Every action is written to an audit log (last 100
  shown there).

## Settings

Order: **You** — General, Notifications · **Agents** — Rooms, Roles, Memory · **System** — Integrations,
Projects, Terminals, Usage, Observability, Server, About.

- **General**: avatar, display name, handle; this browser only: chat density (Compact / **Balanced** /
  Spacious), link previews (**on**).
- **Notifications**: see [Inbox](#inbox).
- **Rooms**, **Roles**: see above.
- **Memory**: wt-memory notes by scope (Global / Roles / Projects); remove agent entries (the list scrolls in its own box as it grows), Accept/Reject pending
  global proposals, **Preview for agent…** shows what an agent receives. Warns when the plugin is missing.
- **Projects** (WP-107): per-project overrides, opened only from Settings › Projects or the gear next to the sidebar project picker (a project picked; phone top bar too —
  WP-110); pages carry no settings button of their own (WP-123). Order: server env var › project ›
  global › default; each row shows *overridden*, *inherited from global/default* or *locked by env var*, with
  **Reset**. Keys: **GitHub account** (agents spawned for the project get `GH_TOKEN` for that account from gh's
  keyring, and the checkout's `credential.https://github.com.username` is set so `git push` matches; the
  dashboard's PR/issue calls for the default repo use it too; gh's active account is never switched; a token is
  a snapshot — respawn after changing it), **Reviewer GitHub account** (wt-watch-prs posts reviews as this
  account, token from gh's keyring per call, so it can approve PRs your agents opened; unset → the
  `GH_REVIEWER_TOKEN_FILE` token, else the default identity, which only comments — unless it is declared with
  `WT_REVIEWER_LOGIN` / `~/.config/gh-reviewer-login` and matches, for machines without a dashboard, WP-126), **Base branch** (default `main`; wt-watch-prs diffs against it too; dispatch reconcile and the PR list's
  shipped check), **Agent MCP** (`WT_AGENTS_MCP`), **Max working agents** (dispatch cap; global = Routines'), **Max reviewers** (`maxReviewers`, default 2,
  0–20: wt-watch-prs dispatch spawns a reviewer only below it — WP-121),
  **Ticket triage** (`WT_JEV_TICKET_TRIAGE`), **Model routing** (`WT_MODEL_ROUTING` off/shadow/live, see
  [Model routing](#model-routing)); plus the board's Auto and Dispatch switches. Stored in `wt.db`
  (`project_settings`, not in the JSON rollback); shell scripts read it via
  `wt-shared/scripts/project-setting.mjs get <key> [--project P|--cwd DIR]`.
- **Integrations**: precedence is process env › Keychain (secrets) › `~/.config/wt-dashboard/env` › default;
  applies without restart except `WT_DASHBOARD_REPO` and `WT_LINEAR_TEAMS`.
  - `LINEAR_API_KEY` (Keychain, last 4 shown, Test connection), `TYPESAFE_API_KEY` (Keychain, powers Jev).
  - `WT_LINEAR_TEAMS` (`KEY=project,KEY`, needs a restart): the Linear teams whose open tickets show up besides
    your own, and whose ids (`ENG-12`) are recognised in branches, worktrees and handoff labels. Unset: only
    tickets assigned to you, and only local board ids are recognised.
  - `WT_DASHBOARD_PROJECTS` (extra repos for New agent), `WT_DASHBOARD_ALLOWED_HOSTS` (tailnet hostnames;
    loopback only), `WT_DASHBOARD_REPO` (needs a restart; default: this wt-pack checkout, which `./setup` writes).
  - **Lean MCP for new agents** (`WT_AGENTS_MCP`, default **full**): lean gives new agents only their role's
    MCP servers plus Jev's picks at handoff.
  - The Jev switches, see [Jev](#jev-features).
- **Usage**: plan limits (5-hour, weekly) and token spend from `~/.claude/projects`, by Today / 7 days / 30 days,
  grouped by agent, project or model (model rows split session vs subagent transcripts). Dollar figures are
  notional list prices. CLI equivalent for installs without the dashboard: `model-route.mjs usage [--days N]`
  (default 7) prints the same by-model/kind breakdown.
- **Observability**: Jev calls by feature (24h / 7d, fail-opens and **auth errors** — a rejected 401/403
  key, kept separate from an ordinary timeout/5xx fail-open — counted apart), **Model routing** (7 days: picks,
  applied, send-backs, returns, escalations and merges per skill × tier, plus an estimated tokens/cost saved vs
  running every applied non-sonnet pick at sonnet instead — from each tier's actual average cost per message over
  the same window, so it is an estimate, not exact per-decision spend) and recent calls (filterable by outcome,
  including `auth_error`), the Jev log-snippets switch, sources, server log (last 500 lines), Routines history,
  Board history, and **Housekeeping**:
  - Hourly (first 60s after start) plus **Run now** and a routine action. Defaults: delete unreferenced
    uploads after **30** days, drop resolved inbox items after **14** days, rotate logs at **5** MB keeping
    **2**, clear stale agent caches after **7** days (each 1–3650).
- **Watchdog** (Settings › Observability): every 60s (first run 90s after start), deterministic checks, each
  with an on/off switch and a threshold — server restarts in the last hour (**3**), room message undelivered
  (**15** min), Ready card not dispatched with Dispatch on (**10** min, held cards excluded), Backlog card
  untriaged with Auto on (**30** min), Planning/Building card held by a gone or stalled agent (**10** min), herdr
  unreachable (**2** min), free disk (**5** GB), wt.db size (**200** MB), server errors in 10 min (**20**), Jev
  failure rate over the last hour (**30**%, at least 5 calls), pool agent's Claude session exited while its pane
  stays open (**1** min), pool agent whose Claude session started before the installed wt-memory version (so it runs
  without the pkill guard — plugin hooks load at session start; restart it; **0** min, WP-120). A finding opens once per condition as a
  `watchdog` Inbox item (native notification only for restarts, herdr and disk) and resolves itself when the
  condition clears. **Investigate** hands a finding to a worker (or **Ask auditor**) through wt-handoff, framed as
  data, to diagnose and file a ticket — only when clicked. For an exited session, **Resume** (on the finding and
  its Inbox item) restarts the same session id in the same pane with the agent's name and MCP set (the watchdog
  remembers each live pool agent's session, since herdr forgets it on exit); it refuses when the pane runs an
  agent again, the name is live elsewhere, or the agent's ticket was re-dispatched to another pane. Never
  automatic.
- **Server**: state, pid, uptime, build time, per-source status; **Restart server** (or **Install as
  service** when not managed).
- **Web build stays current** (WP-81): a server running from a checkout rebuilds `web/dist` itself when
  `web/src` (or `web/index.html`/`package.json`) is newer than the build — 5s after start, then every 2 min,
  one build at a time; the open page picks the new build up. A failed build leaves the previous one and posts a
  `server` Inbox item. `/api/health` reports `webStale`. Not for the bundled Mac-app server or a custom
  `WT_DASHBOARD_DIST`.
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

### Model routing

Picks the Claude model (haiku, sonnet or opus) an agent runs on: `wt-shared/scripts/model-route.mjs`.
- **Modes**: `shadow` (default) logs each pick and applies nothing; `live` applies it; `off` never routes.
  Precedence, first wins: env `WT_MODEL_ROUTING` › the repo's `.wt-pack/model-routing.json` › the project setting
  › `~/.config/wt-pack/model-routing.json` › default. The JSON files also hold `thresholds`, `floors`,
  `roleFloors`, `sessionFloor` (default `sonnet`) and per-skill `{pin, mode}`.
- **Order**: an explicit model always wins (`--model`, an Agent call's `model`) › a skill pin › local rules
  (Explore, a docs/naming/formatting lens, or any read-only task with no security keyword → haiku, unless a
  security keyword is present) › Jev (haiku only at ≥ 0.8 confidence, opus at ≥ 0.6, else sonnet; fail-open →
  sonnet). Floors only raise: correctness, security (also triggered by auth/secret/token/session/cookie/
  permission/csrf/migration/schema), data and migration work run on sonnet at least, planners on opus.
- **Session floor** (WP-157): `model-route.mjs floor` (spawn/session picks, no task text to route) never
  returns haiku for any role — every role floors to sonnet at least, planners still to opus. This applies
  only to a *spawned session's own default* tier (no explicit `--model`); subagent routing (`pick`/`explain`,
  used by wt-review's lens agents and wt-research's shards) is untouched and may still choose haiku. `floor
  --json` adds `source` (`role-floor` or `session-floor`) showing which one set the printed tier. `pick`/
  `explain` also take a `--session` flag for a caller that routes a fresh session's own tier by task text
  rather than by role floor (`wt-handoff`'s spawn path): it applies the same sonnet floor to that pick
  (and to an explicit `--model`, unlike the unflagged case), while a call with no `--session` — every
  wt-review/wt-research subagent pick — stays unaffected and may still choose haiku.
- **Session floor applies in every mode** (WP-160): `floor` never uses Jev — it's a fixed computation, not a
  task-routed pick — so it applies in shadow and off too, not just live; a spawn with no explicit `--model`
  never falls back to Claude Code's own default (which can be haiku) regardless of `WT_MODEL_ROUTING`. Only a
  task-routed `pick`/`explain` (Jev's own choice) stays live-gated, unchanged.
- **Where it applies**: `wt-agents spawn`/`respawn` always resolve `floor`'s tier for a role with no explicit
  `--model`; `wt-handoff`'s fresh-spawn path inherits this by delegating an unrouted spawn to `agents.sh spawn`.
  In live mode, `wt-handoff` additionally spawns with a task-routed `--model` and comments
  `routing: <tier> (…, ref <run#i>)` on the ticket; `wt-agents spawn --model` (or the role floor); wt-review
  and wt-research pass the tier as each lens agent's or shard's `model`. A running session is never switched
  (`/model` asks interactively) and a watchdog resume keeps the session's model. `wt-agents spawn` (and
  respawn) resolve the tier to an explicit model id (`floor`'s own `.model` field, WP-158 — `claude --model
  <tier>` would otherwise hand Claude Code a bare alias to resolve on its own) before starting claude; pane
  tokens, reuse-matching and escalation all still work in tiers, never ids.
- **Escalation**: a return or a review send-back (`routing: send-back …`) is a strike; at two, dispatch comments
  `routing: escalate opus`, adds an Inbox item and the next handoff of that ticket runs on opus (live only).
- **Outcomes recorded automatically** (WP-159): a ticket carrying a `routing: … ref <run#i>` reaches Done with
  no send-back strikes → `ok`; a Done ticket is reopened (any other column) → `returned`. Fires from
  `tickets.mjs`'s `onDone`/`onReopen` hooks, so every path that moves a card counts — the dashboard UI,
  `wt-ticket move`, and dispatch's own merge-detection alike — not just the one dispatch already covered. Once
  per ref (a `routing-outcome: … (ref …)` ticket comment guards against a repeat).
- **CLI**: `model-route.mjs explain` (the whole decision as JSON), `pick [--json]` (the tier, live only),
  `outcome <run#i> ok|send-back|returned|escalated`, `model-id <tier>` (its explicit model id, configurable
  via `modelIds` in the same JSON files, default `opus` → `claude-opus-5-5`, `sonnet` → `claude-sonnet-5`,
  `haiku` → `claude-haiku-4-5-20251001`).
- **Tuning**: `jev-eval.mjs routing --report [--since 7d] [--apply]` reports per skill × tier from the judge log;
  `--apply` moves each threshold by at most 0.05 (≥ 10 labelled Jev picks), skips pinned skills, never touches
  floors, writes the user file, seeds `jev-fixtures/routing.json` and posts the change to #wt-pack.
- **Effort level** (`low < medium < high < xhigh < max`, gated by the global ceiling G): a Jev routing call asks
  a second question in the same request — how much reasoning effort the task needs — and that pick is E, clamped
  to G; when the tier is a downgrade below the default tier (sonnet), E is also capped at the tier's own base
  effort (haiku low, sonnet medium, opus high; a read-only task drops one level) plus 2, never past `high`. A
  local-rule or pinned decision (no Jev call) has no pick to clamp, so it falls back to that same base(+2 if
  downgraded) computation. G defaults to Claude Code's own effective effort setting for the routed tier's own
  model — `settings.json`'s per-model `modelSettings[<model id>].effortLevel` (matched by tier, e.g. an opus
  override) when set, else that file's top-level `effortLevel` (project over user); never `CLAUDE_EFFORT`,
  which Claude Code exports as the CALLING session's own effort into every child process, not a setting for
  the routed target — an orchestrator running at `low` must not drag every task it dispatches down to `low`
  too. One tier's override (e.g. opus set to low) no longer leaks into every other tier's ceiling; `WT_EFFORT` /
  the JSON files' `effort` key still override it explicitly when set (default `high` if neither Claude Code nor wt-pack has an
  opinion). Applied at spawn with `claude --effort`
  (`wt-agents spawn --effort`, wired from `wt-handoff` and the role floor); a subagent (the Agent tool) has no
  effort parameter, so this is session-only. `pick --json` and `floor --role R --json` include
  `effort`/`applyEffort`; logged next to the tier (with Jev's raw pick and confidence) in the judge log and shown
  as an Effort column in Settings › Observability › Model routing.
- **Worker pool** (live routing): every spawn (`wt-agents spawn`) records the tier/effort it actually runs as
  pane tokens `model`/`effort` (a respawn re-applies them, instead of falling back to the role floor). A routed
  hand-off reuses a free worker only when its tokens already match the picked tier/effort; otherwise it spawns a
  fresh one — so the pool no longer grows by one per hand-off. `WT_WORKERS_MAX` (project setting or env, worker
  role only) caps the pool: at the cap, `wt-handoff` exits 3 (`pool full: <n>/<cap> workers in <repo>`, nothing
  sent) and a dispatched card stays in Ready to retry later. On a card reaching Done, the dashboard retires idle
  routed workers past `WT_WORKERS_IDLE_PER_TIER` (default 1) kept per model tier — an agent with no `model` token
  (pre-existing or hand-made) is never touched.

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
  `WT_DASHBOARD_ALLOWED_HOSTS` (from loopback).
- **Bind address** (WP-80): `WT_DASHBOARD_HOST` (process env only, default `127.0.0.1`). Anything but
  `127.0.0.1`/`::1`/`localhost` is **refused at start** with a why/how message unless `WT_ALLOW_REMOTE=1`; with it
  the bound `host:port` joins the Host/Origin allowlist, the session cookie still gates writes and terminals stay
  loopback-only. `./setup doctor` shows the configured bind. Linux VM guide and systemd unit:
  [docs/vm.md](vm.md), `skills/wt-dashboard/scripts/wt-dashboard.service`. No login: loading the page sets an HttpOnly session cookie
  that every write needs. Terminals over the tailnet need their own switch.

## ./setup and doctor

- `./setup` (install, default): Homebrew deps (asks once; `--yes`), links `wt-*` skills into
  `~/.claude/skills`, config dirs, the wt-memory plugin (updated when the checkout's version is newer), web build, launchd service, secrets, then doctor.
  Never repoints an install owned by another checkout. Flags: `--yes`, `--no-secrets`, `--no-service`.
- `./setup doctor`: one line per check (node ≥ 22.13 with `node:sqlite`, git/curl/jq, gh auth, claude, herdr,
  links, plugin (installed version = checkout's), build, service, :7777, config; optional TypeSafe/Linear keys, tailscale, agent-browser,
  cargo); per project with a GitHub account: gh has its token, the token logs in as it, and it reaches the
  repo; exit 1 while a required check fails.
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
- `list [--column c] [--mine] [--project p]` · `search <text> [--column c] [--project p]` · `show <ID>` · `move <ID> <col> [--note]` ·
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
| wt-review coverage (WP-175) | The lens table (always-on pair + conditional triggers) sizes *what* to look for; diff size sizes *how much gets read*, on top of it, never below it — ≤200 changed lines: the lens-bundle agent count reads the whole diff; 200–800: 2–3 agents each get an explicit, disjoint file slice from `git diff --name-only`; >800: 3 agents, every changed file assigned to exactly one. Each multi-agent brief keeps an open-ended "read every assigned file, report anything wrong" core; targeted questions only add to it. Every diff-mode agent ends its reply with one row per file (full/skimmed/skipped + reason); the caller unions those against `git diff --name-only` — a gap is a coverage gap, not silently dropped. Fewer tool calls than a third of an agent's file count is a thin pass: re-dispatch once, then report partial. A delta review (re-review after fixes) sizes on the delta's own line/file count and can't drop a lens the delta re-triggers. The verdict's last line is always `Coverage: N/M files read in full · lenses: … · tests: run\|not run (CI relied on)`; partial coverage can't be an approval |
| wt-ship | Simplify → review → record learnings → PR (this repo merges to main instead) |
| wt-babysit | Watch a PR until merge-ready. A monitor that fails to arm is retried a couple times before giving up; on final failure it stops and reports the failure honestly (WP-154) rather than running with a silently unwatched PR |
| wt-watch-prs | Reviewer loop: watch the repo's open PRs, review each new head (delta after the first), hold or approve under a reviewer identity. Modes (WP-121): standalone `/wt-watch-prs [repo]`; dispatch (orchestrator role: hands each new head to a `<repo>-reviewers` agent, never reads a diff, capped by Max reviewers); review `/wt-watch-prs review <pr> --sha <sha> --session <D>` (one head, records under the dispatcher, replies, stops). A monitor that fails to arm is retried a couple times before giving up on it specifically; one still armed keeps the loop running degraded, both exhausted posts to the repo's room and stops rather than running with silent coverage loss (WP-152) |
| wt-finish | Retire a merged worktree and its branch |
| wt-handoff | Hand a prompt to an agent, or a freshly spawned one; `--cancel` actually stops a `/goal`-driven one |
| wt-audit | PM+QA pass that files board cards; proposals only |
