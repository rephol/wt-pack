# WP-378 — switch wt-pack from herdr to hc (herdr-core), totally

Ticket: WP-378 (feature, L). Branch `wp-378-hc-backend`. Rules: CLAUDE.md (never start a second `herdr server`; throwaway
agents in a temp repo; never touch the user's real terminals; one commit per skill touched; update `docs/features.md`).
Revision 2 after Gate A was REJECTED: revision 1 planned a `WT_BACKEND` switch with both backends. The user decided: **total
switch**. This plan replaces it.

## 1. Decisions (user, Gate A) and what they remove
- hc is the only backend. No `WT_BACKEND`, no compat layer, no old-herdr support, no dual-backend id routing, no `list --all`.
- Every `herdr` CLI call becomes `hc` (or, for app visibility, `herdr-app`). Herdr-only paths are deleted, not ported:
  `agent rename` repair and the tab-label -> agent-name drift fix (WP-222) in agents.sh, `canonicalPane()`/stable-id lookups,
  `herdr server` auto-start (WP-218: `watchdog-probe.sh`, dashboard boot), `herdr integration install claude`, `herdrd.mjs`
  supervision, `--machine`/`herdrOn` remote paths, the `SOURCES.herdr` banner wording.
- Q1 yes: spawned agents show in herdr-app (labels `herdr.space=<id>`, `herdr.tab=<id>`). Q3: spawn with `--no-notify`.
  No remote machines under hc (later ticket). The dashboard never starts the hc core; `./setup doctor` reports `hc server status`.
  No migration of live agents: agents started under herdr are simply not seen after the flip.
- One adapter module only where it helps the code (dedupe of label limits, name rules, spawn+launcher, `--json` parsing for node
  callers). It is not a contract with a second implementation. Shell callers call `hc` directly.
- Consequence to state in docs, not a question: the dashboard's remote-machine UI is disabled with a clear "not supported on hc yet"
  message until the follow-up ticket.

## 2. Evidence (read-only: `hc --help`, `hc run --help`, `hc --skill`, `herdr-app --skill`, `~/.config/herdr-app/AGENTS.md`, `herdr-app ls`, `hc ls --json`; no terminal started in this revision; revision 1 verified names/labels with one probe terminal, since removed)
| herdr today | hc | Port |
|---|---|---|
| `agent start <NAME>`, `agent rename` | `hc run --bg --name N` (1-32 of `a-z0-9-_`, unique among **live** terminals, `name_taken`); no rename | Names fixed at start. `<repo>-<role>-NN` takes the next free number over `hc ls` names. Rename/drift repair deleted. |
| pane tokens (`report-metadata --source wt-dashboard`) | labels: `--label k=v` at run, `hc label <t> k=v...`, `key=` removes, `.labels` in `hc get/ls --json`, `hc ls --label k=v` (AND) | Token -> label 1:1, no source namespace. The pack keeps its 32 keys / 80 chars / unknown-role-dropped rules (hc's own limits are looser). `task`/`handoff_*` stay out of the agents table (WP-348). |
| workspace per pool + tab | none in hc; herdr-app shows a terminal only if it has `herdr.space=<id>` (tab via `herdr.tab=<id>`, else the app makes a tab) | Pool = label `wt.pool=<repo>-<role>s`. For app visibility: one space per pool (`herdr-app do space.new --name <pool> --folder <repo>`, looked up in `herdr-app ls`), tab per agent. Labelling also makes the app adopt the terminal with core keep. |
| `HERDR_PANE_ID` (+ stable-id lookup) | `HC_TERMINAL_ID` (`t7`, stable, in the child env with `HC_SCOPE`) | Identity = `HC_TERMINAL_ID` read from env only (hook budget, mods have no Node). Header names `x-herdr-pane`/`x-wt-pane-key` unchanged (they are the dashboard protocol; value = terminal id). |
| `agent prompt`/`send-text`/`send-keys`/`read`/`wait --until idle` | `hc send` (paste+enter, refuses a `blocked` terminal unless `--force`), `hc keys`, `hc read --lines`, `hc wait` (until it stops working), `hc interrupt` | Direct. `--force` is never used by the pack (it would bypass a permission decision; a blocked agent surfaces in the Inbox). Picker parser needs a ANSI-vs-text read check (S2). |
| agent state from the herdr claude integration | status from the program's OSC 7501 (`idle/working/done/blocked/error`); plain programs report none | **Unknown for claude under hc: spike S1**, with the fallback in §4. |
| panes outlive the spawner | children end with the parent unless `--outlive-parent`/`--no-parent`; parent gets typed `<hc ...>` notes unless `--no-notify` | agents.sh/handoff spawn: `--outlive-parent --no-notify`; dashboard-spawned: `--no-parent --no-notify`. A second prompt-injection form (`<hc>` text) never reaches pack agents. |
| `tab create --env` (agents.sh:392-409: `GH_TOKEN`, `WT_PANE_KEY`, kill-shim `PATH`/`WT_KILL_SHIM_DIR`, `CLAUDE_ENV_FILE`, `WT_MEMORY_MCP`) | **no `--env`**; terminal env is the login-shell/core's (`hc --skill`: a no-command terminal is a login shell; explicit commands unchanged) | Launcher, §4. |
| process-tree walk to `herdr` (wt-deliver, WP-320) | holder process name unknown | S3. |
| `herdr server` | `hc server start|status`; core already live (v0.1.16, 0 terminals, so no pack agent exists in hc yet) | Doctor reports `status` only. |

Inventory of herdr references to convert or delete (verified by grep in revision 1 plus tech-lead additions): `wt-agents/scripts/agents.sh`
+ `wt-agents/bin` + `mcp`, `wt-handoff/scripts/handoff.sh`, `wt-dashboard/{server,dispatch,headless,watchdog,terminals,herdrd,agents-table,promptOn,recovery}.mjs`
+ `scripts/watchdog-probe.sh`, `wt-room/mod/scripts/wt-deliver`, `wt-shared/scripts/{task-state.sh,agent-pane.sh,pane-submit.mjs,wt-message-cli.mjs,wt-gate}`
+ `wt-shared/mcp/wt-server.mjs`, `wt-ask`, `wt-room/scripts/room`, `wt-ticket`, `wt-mods/scripts/wt-keepwarm`, `wt-mods/hooks/{commands,guards}.ts`
(`SENDS` regex matches `\bherdr\b`: must match `\bhc\s+(send|keys|run)\b`), `wt-memory/claude-plugin/hooks/inject.mjs`, `wt-memory/scripts/wt-memory`,
`wt-watch-prs`, `setup`, Tauri `app/src-tauri/src/main.rs`, every SKILL.md/README/docs/CLAUDE.md mention.

## 3. Scope and non-goals
Scope: everything above; docs/CLAUDE.md/setup describe hc only. Non-goals: remote machines (`hc --on`, follow-up ticket); `hc events` instead of
polling; hc templates/`hc keep` use beyond what app adoption does; migrating live agents; changing dashboard auth, headers or the pane-key scheme;
changing the 32/80 limits; herdr-app layout/mods; the dashboard starting the hc core.
Release shape: there is no compat layer, so `main` is not releasable between units. All units land on `wp-378-hc-backend` and merge to main
once, after QA. Units are independent branches off U1 only to run in parallel; the tech lead merges them `--no-ff` into the ticket branch.

## 4. Design
- **Adapter** `skills/wt-shared/scripts/hc.mjs` (node, no deps): `hc(args)` runner (`--json` parse, error `{kind}` mapping, timeouts passed by caller),
  `list()` normalised to `{id,name,cwd,status,labels,alive}`, `spawn({name,cwd,argv,labels,parent})` (adds `--bg --outlive-parent --no-notify`),
  `setLabels/clearLabel` (enforces 32/80/unknown-role), `send/keys/read/wait/interrupt/kill/rm`, `nextName(prefix)`. Imported dynamically inside the
  subcommand that needs it (CLAUDE.md trap on top-level imports). Shell callers use `hc ... --json` directly; no bash wrapper.
- **Spawn env launcher (hc has no `--env`).** `skills/wt-agents/scripts/hc-launch <envfile> -- <argv...>`. agents.sh/Dispatch write the env
  (`GH_TOKEN`, `WT_PANE_KEY`, kill-shim `PATH`/`WT_KILL_SHIM_DIR`, `CLAUDE_ENV_FILE`, `WT_MEMORY_MCP`) to a mode-0600 file in a 0700 dir under
  `~/.local/share/wt-agents/launch/` (user-private, not `$TMPDIR`), named by agent name + random nonce, and run
  `hc run --bg --name N --cwd D --label ... -- hc-launch <file> -- claude ...`. The argv carries only the path. The launcher sources the file,
  **deletes it first**, exports, then `exec`s claude, so `PATH` is set after any shell rc and the kill shims stay first (WP-120). Bonus: the launcher
  has `HC_TERMINAL_ID` in its env, so it writes `~/.local/share/wt-dashboard/pane-keys/$HC_TERMINAL_ID` (0600) from `WT_PANE_KEY` itself before the
  exec; this closes the old window where an agent's first dashboard call preceded the key file (grace until `WT_PANE_KEY_STRICT=1` remains for
  hand-started panes). A crash between write and delete leaves a 0600 file only; the next spawn sweeps files older than 10 min. Not sound only if S5
  shows hc passes the caller's env through *and* hides argv: then plain env would also work, but the launcher is still used (one path).
- **Agent state (S1) and fallback.** Ordered: (1) claude reports OSC 7501 natively under `hc run`: use `hc get` status and `hc wait`.
  (2) it does not: a wt-memory hook set (`UserPromptSubmit` working, `Notification` blocked, `Stop` idle) writes the OSC 7501 report to the terminal
  (`/dev/tty`; the exact sequence is read from `hc schema`/herdr-app docs and recorded in S1), so hc and herdr-app both see status. (3) hooks cannot
  reach the tty: idle detection uses the record `inject.mjs` already writes (`~/.cache/wt-memory/turn-<pane>.json`, Stop stamps `ended`) and
  `mux`-style waits become "poll that record + screen settled via `hc read`"; herdr-app shows these agents as plain terminals. The engineer reports
  which tier was chosen; U8 exists only for tier 2.
- **Identity.** `HC_TERMINAL_ID` from env everywhere (`inject.mjs` 2 s budget, CLAUDE.md WP-204; `commands.ts` uses `$.env.get`, WP-206). No subprocess
  to learn who you are.
- **herdr-app space lookup.** agents.sh asks `herdr-app ls` for the pool's space (exact name match + folder), creates it once with `space.new`, labels the
  terminal `herdr.space=<id>`. If `herdr-app ls` fails (window not open) the agent is spawned hidden (no `herdr.*` labels), a warning is printed, and
  the spawn succeeds (see open question R1).
- **Tests.** A PATH-shim fake `hc` that replays real `hc ... --json` output recorded on an isolated core (`HC_SESSION=wtt-<id>`, scratch `XDG_*`) for
  every verb used (no verb is shimmed from memory); the same for `herdr-app ls`. One opt-in real-hc test on the isolated session with `wtt-*`
  terminals in a temp repo, torn down by recorded ids; teardown asserts the default session's `hc ls` is unchanged and stops only the isolated core
  (`HC_SESSION=wtt-<id> hc server stop`). Tests pin `HERDR_DASH_URL` to a closed port. Child-`claude` env in tests strips `HC_*`. All herdr fakes are deleted.
- **Red proof.** Each new guard/fix lands with a test run failing first (output in the commit message): env-not-in-argv and env-file-gone for hc spawn,
  `--outlive-parent --no-notify` present, label limits, name-taken numbering, the `SENDS` guard on `hc send`, wt-deliver stand-down under hc,
  pointer typed byte-for-byte after the record.
- **Spikes** (U1, throwaway `claude` in a temp repo on the isolated session; results in a `## Spike results` section appended to this plan and the unit's commit):
  S1 does claude report 7501 under `hc run`, what `hc wait`/`hc get` return across a turn and a permission prompt, and the sequence format;
  S2 `hc read` plain vs ANSI for the picker parser (the old `--ansi` read; fixtures in `wt-dashboard/test-fixtures/picker-*`);
  S3 holder ancestor process name for wt-deliver's tree walk;
  S4 `hc send` into a claude: paste handling of the WP-352 pointer line and `first_message.sent` equivalent;
  S5 which env a `hc run --bg` terminal receives, that the launcher's `PATH` survives to claude's Bash tool, and that `hc get --json` shows no secret in argv.

## 5. Units
Order: U1 first; U2-U6 in parallel; U7 after all; U8 only if S1 lands on tier 2. Every unit: `Owner: wt-pack:wt-engineer`.

### U1 — adapter + spikes (skill: wt-shared)
Owner: wt-pack:wt-engineer
- `hc.mjs`, recorded fixtures, fake `hc` shim helper for tests (shared by all units), spikes S1-S5, `## Spike results` in this plan, chosen state tier.
- Tests (`hc.test.mjs`): normalisation from recorded `ls/get --json`; label set/clear and 32/80/unknown-role limits; `name_taken`; error mapping; spawn flags;
  `nextName`. One opt-in real-hc test.
- Docs: wt-shared SKILL/README note.

### U2 — agents (skill: wt-agents)
Owner: wt-pack:wt-engineer
- `agents.sh spawn|list|rm|dnd|context`, `bin/` shims, `mcp` on hc; `scripts/hc-launch`; pool label; herdr-app space lookup/creation; model/effort/role/project/
  team/persona as labels; delete rename/tab-drift/stable-id paths; model-floor behaviour (WP-157/160) unchanged and still asserted.
- Tests: spawn-env, list, dnd, respawn, `mcp.test.mjs` on the fake hc; hc spawn argv has no env value and the env file is gone (red first); numbering; hidden
  fallback when `herdr-app ls` fails; launcher writes the pane-key file.

### U3 — handoff and pane helpers (skills: wt-handoff, wt-shared task-state/agent-pane/pane-submit/wt-message-cli)
Owner: wt-pack:wt-engineer
- `handoff.sh` delivery, queue-then-type, WP-352 `ptr()` typed after the record, WP-360 record once, `--buddy` pair label, `--session` spawn,
  `task-state.sh`, `agent-pane.sh`, `pane-submit.mjs`, `wt-message-cli.mjs`; waits per the S1 tier (`hc wait` or the fallback).
- Tests: `handoff.test.mjs`, `jev-route.test.mjs`, `pane-submit.test.mjs` on the fake hc; record-before-send order; pointer byte-for-byte; no `--force`.

### U4 — identity and CLIs (skills: wt-room mod, wt-ask, wt-ticket, wt-mods, wt-memory, wt-watch-prs, wt-shared gate/mcp)
Owner: wt-pack:wt-engineer
- `HC_TERMINAL_ID` replaces every `HERDR_PANE_ID` read in `wt-deliver` (incl. the WP-320 walk from S3), `wt-gate`, `wt-ask`, `room`, `wt-ticket`,
  `wt-keepwarm`, `inject.mjs`, `wt-memory`, `commands.ts`, `watch-prs.sh`, `wt-server.mjs` env pass-through; `guards.ts` `SENDS` -> `hc` (red first).
- One commit per skill touched (several commits; each is a mechanical swap).
- Tests: each skill's existing test with `HC_TERMINAL_ID` set and no `HERDR_*`; wt-deliver nested-claude stand-down; `paths.test.mjs`, `plugin-agents.test.mjs`;
  `skills/wt-mods/scripts/test`.

### U5 — dashboard read side (skill: wt-dashboard)
Owner: wt-pack:wt-engineer
- `server.mjs` herdr helpers -> `hc.mjs`; agent list, `paneMeta` label sync, `agents-table.mjs` reconcile, ghost detection from `hc ls` (live/finished), `/api/agents`,
  pair/task label clear on ticket move, banner/source wording ("hc core"), remote UI disabled message.
- Tests: `agents.routes`, `agents-table`, `pins.routes`, `memory.routes`, `keepwarm.routes`, `pane-key.routes`, `gate.routes` with the fake `hc` on PATH; web typecheck.

### U6 — dashboard write side and spawn (skill: wt-dashboard)
Owner: wt-pack:wt-engineer
- `deliver()` paste callbacks (`send`), deliveries sweep/resend, terminals send/keys (`herdrKeys` map -> `hc keys`), `promptOn.mjs`, Dispatch spawn (via `hc-launch`,
  `--no-parent --no-notify`), `headless.mjs`, `watchdog.mjs`, `recovery.mjs`, `terminals.mjs`; delete `herdrd.mjs`, `scripts/watchdog-probe.sh`'s `herdr server` start
  (probe reports `hc server status` only, never starts); Tauri `main.rs` check.
- Tests: `dispatch.test`, `headless.test`, `watchdog.test`, `recovery.test`, `envelope.routes`, `verify.routes`, `promptOn.test` with the fake `hc`; `npm test`.

### U7 — setup, doctor, docs, sweep (skills: setup script, wt-setup, docs)
Owner: wt-pack:wt-engineer
- `./setup doctor`: `hc` present, `hc server status`, `herdr-app` presence (info), and a warning for leftover `herdr`-era settings/launchd entries; installs nothing;
  remove herdr integration install/doctor checks.
- `docs/features.md`, every touched SKILL.md/README, CLAUDE.md (herdr -> hc throughout; Traps rewritten: labels vs tokens, `--outlive-parent`, no rename, names unique,
  no `--env` so the launcher, `--no-notify`; delete herdr-only traps such as the second-`herdr server` and `HERDR_PANE_ID` stable-id ones, keeping the lessons that still apply).
  A short flip note: restart the dashboard once, old herdr agents are not carried over.
- The final grep gate (DoD) and `npm test` at root green.

### U8 — status bridge (skill: wt-memory), conditional on S1 tier 2
Owner: wt-pack:wt-engineer
- Hooks emit OSC 7501 working/blocked/idle to the tty; tests with a pty/fake tty file; hook stays inside its timeouts; no behaviour change when `HC_TERMINAL_ID` is unset.

## 6. Definition of Done
- [ ] Zero herdr remains: `grep -rniE '\bherdr\b|HERDR_PANE_ID|canonicalPane|--machine|herdrOn|herdr server'` over the repo (excluding `docs/plans/`, `node_modules`, the literal header name
  `x-herdr-pane`, `HERDR_DASH_URL`, the `herdr-app` command/path, and `herdr.space`/`herdr.tab` labels, each excluded by exact string) returns nothing; QA runs it.
- [ ] Root `npm test` and dashboard `npm test` (incl. web typecheck) pass; the opt-in real-hc test passes on an isolated `HC_SESSION`.
- [ ] Spawn, list, rm, dnd, handoff delivery (pointer typed byte-for-byte, recorded before send), wait, read, label set/clear work on hc.
- [ ] A spawned agent survives its spawner (`--outlive-parent`), has `--no-notify`, shows in the dashboard Agents list with role/project/model/effort, and shows in herdr-app
  under its pool space (or a spawn warning is printed when the window is closed).
- [ ] An hc-spawned agent has `WT_PANE_KEY`, `GH_TOKEN` (when configured) and the kill-shim PATH first in its env, and none of them in any argv (`ps`, `hc get --json`); the env file is gone after launch.
- [ ] S1-S5 results recorded in this plan; agent-state tier chosen and works (a blocked/idle agent is detected by the dashboard and by handoff waits).
- [ ] Each new guard or fix has a red proof; wt-deliver nested-claude stand-down works under hc; `SENDS` refuses `hc send` carrying the user-level skills path.
- [ ] Nothing in the pack starts an hc core or a herdr server; `./setup doctor` reports hc state; `docs/features.md`, SKILL.md files and CLAUDE.md are hc-only.
- [ ] One commit per skill touched; pushed only after Gate B; no real terminal touched (QA compares `hc ls` before/after).

## 7. QA brief
A user (or the auditor) does, in a temp repo on a throwaway isolated core (`HC_SESSION=wtqa-<id>`, scratch `XDG_*`; the user's own core is only read with `hc ls`):
1. `agents.sh spawn worker` twice; `list --json`; `dnd on/off`; `rm`. Confirm names `<repo>-worker-01/02`, labels, `hc get` shows no secret in argv, the terminal outlives the spawning shell.
2. `handoff.sh --task` a short prompt to a spawned agent; read its screen; confirm the typed line is the recorded pointer and the message row existed before delivery; a blocked agent is not forced.
3. Start a dashboard against a PATH shim (hc on the isolated session), open Agents, send a room message to an agent; confirm the status shown matches S1's tier.
4. With the herdr-app window open (if available), confirm the agent appears in its pool space; close it and confirm the spawn warns and still works.
5. `./setup doctor` output with the core up and down; the DoD grep.
Evidence kept (nothing else): command transcripts with exit codes for 1, 2, 5; `hc ls --json` before/after on the default session (equal for non-`wtt-`/`wtqa-` terminals);
one `agent-browser` screenshot of the Agents list (session `<agent name>`); test summaries (root and dashboard counts); the grep output. Teardown: kill/rm recorded terminals by address, stop only the isolated core.

## 8. Open questions for the user (defaults used if unanswered)
- **R1** herdr-app window closed at spawn: default spawn hidden with a warning. Alternatives: refuse the spawn (agents always visible) or auto-open `herdr-app`. Changes only U2's fallback branch and the DoD line on visibility.
- **R2** Rename the protocol names (`x-herdr-pane` header, `herdr` wording in route names) to hc names? Default keep: renaming touches dashboard, every CLI and the pane-key scheme (non-goal). Yes adds a rename pass to U4/U5/U6 and a DoD grep tightening.
- **R3** One herdr-app space per pool (`<repo>-<role>s`, tab per agent) as assumed, or one space per repo with all roles as tabs? Default per pool, matching today's workspaces. Changes only U2's space lookup.
Everything else from revision 1 (Q1-Q5, WT_BACKEND, dual-backend routing, union numbering, shell-wrapper cost) is resolved or deleted.

## 9. Review history
- Revision 1 tech-lead review (wt-review plan mode): kept here, still valid: no `--env` -> launcher + S5; `self` env-only; inventory additions (`promptOn.mjs`, `watchdog-probe.sh`,
  `guards.ts SENDS`, `wt-server.mjs`); red proofs; real-fixture shims; S1 failure also breaks handoff waits -> tiered fallback; isolated-core teardown; parallel units on branches.
  Obsolete after the total switch: id-shape routing, `list --all`, union numbering across backends, `mux.sh` wrapper cost.
- Gate A (revision 1): REJECTED by the user in favour of a total switch (§1). Revision 2 needs a fresh plan review before Gate A.
