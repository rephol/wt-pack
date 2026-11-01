# WP-378 — switch wt-pack from herdr to hc (herdr-core), totally

Ticket: WP-378 (feature, L). Branch `wp-378-hc-backend`. Rules: CLAUDE.md (never start a second `herdr server`; throwaway
agents in a temp repo; never touch the user's real terminals; one commit per skill touched; update `docs/features.md`).
Revision 2 after Gate A was REJECTED: revision 1 planned a `WT_BACKEND` switch with both backends. The user decided: **total
switch**. This plan replaces it. Revision 2.1 applies the revision-2 tech-lead review (§9).

## 1. Decisions (user, Gate A) and what they remove
- settled: hc is the only backend. No `WT_BACKEND`, no compat layer, no old-herdr support, no dual-backend id routing, no
  agents.sh `list --all` (the dual-backend flag; `hc ls --all` for finished terminals is still used, §2).
- settled: every `herdr` CLI call becomes `hc` (or, for app visibility, `herdr-app`). Herdr-only paths are deleted, not ported:
  `agent rename` repair and the tab-label -> agent-name drift fix (WP-222) in agents.sh, the stray single-pane tab sweep (agents.sh:146-150),
  `canonicalPane()`/stable-id lookups, `herdr server` auto-start (WP-218: `watchdog-probe.sh`, dashboard boot), `herdr integration install claude`,
  `herdr config check`, `herdrd.mjs` (+ `herdrd.test.mjs`) supervision, every remote-machine path (`--machine`/`herdrOn`, `remoteTranscript.mjs`
  + its tests, `streamRemote`/`remoteName`, the `machines` source), the `SOURCES.herdr` banner wording.
- settled: Q1 yes: spawned agents show in herdr-app (labels `herdr.space=<id>`, `herdr.tab=<id>`). Q3: spawn with `--no-notify`.
  No remote machines under hc (later ticket). The dashboard never starts the hc core; `./setup doctor` reports `hc server status`.
  No migration of live agents: agents started under herdr are simply not seen after the flip.
- One adapter module only where it helps the code (dedupe of label limits, name rules, spawn+launcher, `--json` parsing for node
  callers). It is not a contract with a second implementation. Shell callers call `hc` directly, except spawn (one path, §4).
- Consequence to state in docs, not a question: the dashboard's remote-machine UI is disabled with a clear "not supported on hc yet"
  message until the follow-up ticket; its server code is deleted.

## 2. Evidence (read-only: `hc --help`, `hc <cmd> --help`, `hc --skill`, `hc schema`, `herdr-app --skill`, `~/.config/herdr-app/AGENTS.md`, `herdr-app ls`, `hc ls --json`; no terminal started in this revision; revision 1 verified names/labels with one probe terminal, since removed)
| herdr today | hc | Port |
|---|---|---|
| `agent start <NAME>`, `agent rename` | `hc run --bg --name N` (1-32 of `a-z0-9-_`, unique among **live** terminals, `name_taken`); no rename | Names fixed at start. `<repo>-<role>-NN` takes the next free number over `hc ls --all` names plus agents-table names; on `name_taken` retry with the next number (max 3). Rename/drift repair deleted. |
| pane tokens (`report-metadata --source wt-dashboard`) | labels: `--label k=v` at run, `hc label <t> k=v...`, `key=` removes, `.labels` in `hc get/ls --json`, `hc ls --label k=v` (AND) | Token -> label 1:1, no source namespace. The pack keeps its 32 keys / 80 chars / unknown-role-dropped rules. `task`/`handoff_*` stay out of the agents table (WP-348). |
| workspace per pool + tab (`workspace create/list`, `tab create/close/get/list/rename`) | none in hc; herdr-app shows a terminal only if it has `herdr.space=<id>` (tab via `herdr.tab=<id>`, else the app makes a tab). Spaces live in the core's herdr-app document (AGENTS.md:94-95) | Pool = label `wt.pool=<repo>-<role>s`. App visibility: one space per pool (`herdr-app do space.new --name <pool> --folder <repo>`, looked up in `herdr-app ls`), created under a per-pool `mkdir` lock, lowest id wins if two match. **Adoption enables core keep** (AGENTS.md:141-142): see "keep" row. Tab close = `hc kill` + `hc rm`. |
| `HERDR_PANE_ID` (+ stable-id lookup) | `HC_TERMINAL_ID` (`t7`, "this terminal forever on this core", in the child env with `HC_SCOPE`) | Identity = `HC_TERMINAL_ID` read from env only. Header names `x-herdr-pane`/`x-wt-pane-key` unchanged (R2). Every production strip of `HERDR_PANE_ID`/`HERDR_ENV` (server.mjs:581,1259,1737, headless.mjs:160) becomes a strip of `HC_TERMINAL_ID`/`HC_SCOPE`. |
| `agent prompt`/`send-text`/`send-keys`/`read --ansi`/`wait --until idle` | `hc send` (paste+enter, waits for a typing pause, refuses `blocked` exit 9 unless `--force`, `--if idle|working`), `hc keys`, `hc read --lines` (**plain text only**: no ANSI in CLI or schema), `hc wait` (`--timeout` in **seconds**, default 180; a message to the waiter also ends it), `hc interrupt` | `--force` is never used by the pack. Blocked = queued, §4. Waits loop on `reason: message`/timeout until the caller's deadline. Picker/terminals read design in §4 (no ANSI). |
| `pane process-info` + `shellForeground` (server.mjs:571, watchdog.mjs:213) | `hc ls --all` `state` live/finished; `hc get` foreground program | Exited = finished, or live with a non-claude foreground (a keep shell). `shellForeground` deleted. |
| watchdog Resume: `agent start --pane <pane> -- --resume` (watchdog.mjs:235, server.mjs:4446) | no start-into-existing-terminal | Resume = `hc kill`+`hc rm` the old terminal, then `agents.sh respawn` (new terminal, same name, `--resume <session>`); the agents-table row is re-keyed to the new id as respawn already does (watchdog.mjs:215-216). |
| agent state from the herdr claude integration | status from the program's OSC 7501 (`idle/working/done/blocked/error`); plain programs report none | **Unknown for claude under hc: spike S1**, fallback in §4. |
| panes outlive the spawner | children end with the parent unless `--outlive-parent`/`--no-parent`; parent gets typed `<hc ...>` notes unless `--no-notify` | Every spawn goes through agents.sh with `--outlive-parent --no-notify` (a launchd dashboard has no `HC_TERMINAL_ID`, so no parent anyway). |
| (none) | **`hc send` wraps text in `<hc from=...>` tags** unless the user-level `notes = false` (`hc --help`); `--no-notify` does not stop this | A tagged prompt is classified `peer` by `inject.mjs` (WP-356 rule) and the gate denies; pack sends must arrive untagged (§4, S4, R4). |
| (none) | **keep**: "replaces a lost program with a shell", incl. signal death and host shutdown | A kept agent is a live login shell at the same address. Never type into it (§4). |
| `tab create --env` (agents.sh:392-409) | **no `--env` in the CLI**; the API's `terminal.run` takes `env` "set on top of the core's environment" (`hc schema`); an explicit-command terminal gets the **core's** env and no login shell (`hc --skill`) | Launcher, §4. |
| process-tree walk to `herdr` (wt-deliver, WP-320) | holder process name unknown | S3. |
| `herdr server`, `status server` | `hc server start|stop|status|restart`; core live (v0.1.16) | Doctor reports `status` only; whether `ls/get/status` auto-start a stopped core on macOS is unknown: S5. |
| `hc ls` | also lists connected machines' `machine/t7` terminals | `list()` drops addresses containing `/`. |

Inventory of herdr references to convert or delete (grep `\bherdr\b|HERDR_` = 122 files at 28e7705; each file has an owning unit):
- U2: `wt-agents/scripts/agents.sh` + `bin/` + `mcp` + every `wt-agents/scripts/*.test.mjs`.
- U3: `wt-handoff/scripts/handoff.sh` (+ tests), `wt-shared/scripts/{task-state.sh,agent-pane.sh,pane-submit.mjs,wt-message-cli.mjs}`.
- U4: `wt-room/mod/scripts/wt-deliver`, `wt-room/scripts/room`, `wt-ask/scripts/wt-ask`, `wt-ask/hooks/register.ts`, `wt-ticket/scripts/wt-ticket`,
  `wt-mods/scripts/wt-keepwarm`, `wt-mods/hooks/{commands,guards}.ts`, `wt-memory/claude-plugin/hooks/inject.mjs`, `wt-memory/scripts/wt-memory`,
  `wt-watch-prs/scripts/{watch-prs.sh,poller-service.mjs}`, `wt-shared/scripts/{wt-gate,gate.mjs}`, `wt-shared/mcp/wt-server.mjs`, `wt-shared/jev-fixtures/*`, and their tests.
- U5: `wt-dashboard/{server (read side),agents-table,agentinfo,asks,inbox,rooms,routines,roles,project-store,projectPaths,config}.mjs`, `contracts.d.mts`,
  `web/src/{App,main,roles,settings,spawn,status,terminals}.tsx`, `web/public/manifest.webmanifest`, and their tests.
- U6: `wt-dashboard/{server (write side),dispatch,headless,watchdog,terminals,promptOn,recovery}.mjs`, delete `herdrd.mjs`/`herdrd.test.mjs`/`remoteTranscript.mjs`
  (+ test) and the remote parts of `parse.test.mjs`, `scripts/{watchdog-probe.sh,service.mjs,wt-dashboard.service}`, `app/src-tauri/src/main.rs`, `package.json` test list.
- U7: `setup`, `wt-setup`, `.claude-plugin/plugin.json` description, `test/docker/{Dockerfile,smoke.sh}`, `README.md`, `CONTRIBUTING.md`, `CLAUDE.md`, `docs/{features,vm}.md`,
  `docs/mockups/*`, and **every** SKILL.md/README/reference with a herdr mention, touched by another unit or not (e.g. `wt-finish/SKILL.md:92`, `wt-plan/SKILL.md:92,283`,
  `wt-plan/references/handoff.md:52,107`: "When `herdr` is on PATH" becomes `hc`).

## 3. Scope and non-goals
Scope: everything above; docs/CLAUDE.md/setup describe hc only. Non-goals: remote machines (`hc --on`, follow-up ticket); `hc events` instead of
polling; hc templates/`hc keep` use beyond what app adoption does; migrating live agents; changing dashboard auth, headers or the pane-key scheme;
changing the 32/80 limits; herdr-app layout/mods; the dashboard starting the hc core; editing the user's `~/.config/herdr-core/config.toml`.
Release shape: there is no compat layer, so `main` is not releasable between units. All units land on `wp-378-hc-backend` and merge to main
once, after QA, through the flip runbook (§7). Units are branches off U1 to run in parallel where they touch disjoint files; the tech lead merges them `--no-ff` into the ticket branch.

## 4. Design
- **Adapter** `skills/wt-shared/scripts/hc.mjs` (node, no deps): `hc(args, {timeoutMs})` runner (`--json` parse, error `{kind}` mapping incl. exit 9 `blocked`,
  10 `status_mismatch`, 11 `finished`; hc's `--timeout` seconds derived from `timeoutMs`, execFile timeout above it), `list({all})` normalised to
  `{id,name,cwd,status,labels,alive,foreground}` minus `machine/` addresses, `spawn(...)` (§ launcher), `setLabels/clearLabel` (32/80/unknown-role),
  `send/keys/read/wait/interrupt/kill/rm`, `nextName(prefix, taken)`. Imported dynamically inside the subcommand that needs it (CLAUDE.md top-level import trap).
  Also exposed as a CLI (`node hc.mjs spawn ...`) for agents.sh's spawn only.
- **Timeouts (per verb).** Dashboard tick: exactly one `hc ls --all --json` per tick (status comes from it), 2 s; `hc get`/`label` 2 s; `hc send` 8 s
  (it waits for a typing pause); `hc wait` the caller's deadline, looping on `reason: message`/timeout; `hc read` only inside an explicit wait or the
  terminals view, never per tick. No hc call in a hook except the bounded wt-memory fallback below.
- **Spawn: one path, agents.sh (U2).** Dashboard Dispatch, routines, pause/resume, watchdog Resume and `handoff.sh --session` already spawn through
  agents.sh (server.mjs:1152,1420,1463; handoff.sh:833); they keep doing so. agents.sh `spawn|respawn` calls `node hc.mjs spawn`, which runs
  `hc run --bg --outlive-parent --no-notify --name N --cwd D --label ... -- hc-launch <file> -- claude ...`.
- **Launcher `skills/wt-agents/scripts/hc-launch <envfile> -- <argv...>`.** Why: no CLI `--env`; the terminal env is the core's (whoever started it),
  not a login shell. The spawner writes `GH_TOKEN`, `WT_PANE_KEY`, kill-shim `PATH`/`WT_KILL_SHIM_DIR`, `CLAUDE_ENV_FILE`, `WT_MEMORY_MCP`, and
  `WT_ROLE`/`WT_PERSONA`/`WT_PROJECT` as `KEY=value` lines to a 0600 file in a 0700 dir `~/.local/share/wt-agents/launch/` (name + nonce). The launcher:
  (1) reads the lines **without evaluating them** and deletes the file first; (2) unsets a fixed denylist inherited from the core (`GH_TOKEN`, `WT_PANE_KEY`,
  `WT_DELIVER_TOKEN`, `WT_HEADLESS_*`, `CLAUDE_ENV_FILE`, `HC_SESSION`, `HERDR_*`, `WT_KILL_SHIM_DIR`) before applying the file; (3) writes
  `pane-keys/$HC_TERMINAL_ID` (0600) from `WT_PANE_KEY` (closes the first-call-before-key window; strict-mode grace stays for hand-started panes);
  (4) `exec "$SHELL" -l -c` with the shim dir re-prepended to `PATH` after the rc ran, then `exec claude ...`. WP-120's shim-first guarantee for
  claude's Bash tool stays the per-agent `env.sh` copy + `CLAUDE_ENV_FILE` (agents.sh today); the launcher only keeps it true for the claude process.
  The spawner deletes the env file if `hc run` exits non-zero; the next spawn sweeps files older than 10 min. S5 also tries the API path
  (`hc connect` `terminal.run` with `env`): if values reach claude and appear nowhere in `get/ls`/argv, secrets go that way and the file is dropped;
  the launcher stays for steps 2-4.
- **Agent state (S1) and fallback.** Ordered: (1) claude reports OSC 7501 natively under `hc run`: use `hc ls` status and `hc wait`.
  (2) it does not: wt-memory hooks write OSC 7501 to `/dev/tty` (sequence from `hc schema`/herdr-app docs, recorded in S1): `UserPromptSubmit` and
  `PreToolUse` working, `Notification` **with the permission-prompt matcher only** blocked (an idle notice never writes blocked, or `hc send` would
  refuse deliveries), `Stop` idle. (3) hooks cannot reach the tty: idle = the `inject.mjs` turn record (`turn-<pane>.json`, Stop stamps `ended`) +
  screen settled via `hc read`; herdr-app shows these agents as plain terminals. The engineer reports the tier; U8 exists only for tier 2.
- **Never type into a shell.** A terminal counts as an agent only while its foreground is `claude` (or it reports a status); a keep shell at an agent's
  address shows as exited (watchdog `exited` input, Resume offered). Pack sends use `hc send --if idle` on tiers 1-2, and a foreground-is-claude check
  (`hc get`) on tier 3, so a shell is never typed into.
- **Blocked delivery.** `deliver()` maps exit 9 to "queued behind the target" (the existing pending path), not counted as an attempt (WP-360
  attempts count typed sends only); `blocked` is removed from `seen()` (server.mjs:2644); after 10 min blocked the existing question/Inbox card shows.
  Red test with the fake hc returning exit 9.
- **Untagged pack sends (`<hc>` tags).** `inject.mjs` classifies a prompt starting `<hc ` as `trust:'peer'` (gate denies; red test), exactly like
  `<cross-session-message`. Pack messages must reach agents untagged so the WP-352 pointer stays the exact line: S4 records what `hc send` types from
  (a) the launchd dashboard (no `HC_TERMINAL_ID`), (b) inside an agent terminal, (c) (b) with `HC_TERMINAL_ID`/`HC_SCOPE` unset for the call.
  Design by result: if (a) is untagged, every typed pack send goes through the dashboard (`deliver()`; scripts already post to `/api/deliveries`),
  and script-side `hc send` remains only as the dashboard-down fallback via (c) if (c) is untagged, else the fallback queues. The pack never edits
  the user's `config.toml` (R4).
- **Identity.** `HC_TERMINAL_ID` from env everywhere (`inject.mjs` 2 s budget, WP-204; `commands.ts` uses `$.env.get`, WP-206). Role/project for the
  wt-memory hook come from `WT_ROLE`/`WT_PROJECT` set by the launcher; `hc get` (500 ms) only as fallback for a hand-started pane, keeping WP-369's
  `--strict-pane` behaviour. Pane-key and agents-table identity is the bare `t7`: agents.sh keeps today's stale-key sweep against `hc ls --all`;
  if S5 finds a core identity in `hc server status --json`, the dashboard drops rows/keys when it changes.
- **Picker and terminals without ANSI.** `hc read` is plain text. The picker's focused-tab detection (server.mjs:342) moves to plain-text markers,
  red-tested on the `test-fixtures/picker-*.txt` fixtures; if the fixtures show it cannot be done from text, U6 reads one ANSI frame from
  `terminal.attach`'s first paint through the adapter. The terminals view (`<project>-shells`): a shell = `hc run --bg` login shell labelled
  `wt.pool=<project>-shells`, close = `hc kill`+`hc rm`, screen = `hc read` (plain, R5).
- **herdr-app space lookup.** As §2. If `herdr-app ls` fails the agent is spawned hidden (no `herdr.*` labels), a warning is printed, and the spawn
  succeeds (R1). Note for R1: spaces live in the core's herdr-app document, not only the open window.
- **Gate (WP-332).** `gate.mjs classify` gains hc classes, each red-tested: `hc server stop|restart` and `hc update` irreversible; `hc kill|rm` of a
  terminal the caller did not start, `hc keys`/`send --force` to another terminal (answering its dialog); `--on`, `hc put`, `hc file write` as upload.
  `guards.ts` `SENDS` matches `\bhc\b` and `herdr-app\s+do` (any verb, flag-before-verb), red tests for `hc send`, `hc label`, `hc put`.
- **Tests.** A PATH-shim fake `hc` replaying real `hc ... --json` output recorded on an isolated core for every verb and flag in §2 (U1 records them
  all, one fixture file per verb, plus a recording script units use to add one); the same for `herdr-app ls`. **Isolated runs** (spikes, the opt-in
  real-hc test `WT_REAL_HC=1`, QA): `HC_SESSION=wtt-<id>` and scratch `XDG_*`, **plus** `WT_DASHBOARD_DATA`, `XDG_CACHE_HOME`, `XDG_DATA_HOME` in scratch
  and `HERDR_DASH_URL` on a closed port or the test's own dashboard, passed through the launcher env file so claudes inside the isolated core get them
  (addresses `t1..` repeat across cores and would alias real agents' turn and pane-key files). U1 lists every per-pane path the pack writes under
  `$HOME` and makes each honour one of those vars. Teardown kills/rms recorded ids, stops only the isolated core, and asserts the default session's
  `hc ls`, the real `pane-keys/` dir and the real `~/.cache/wt-memory/turn-*` set are unchanged. Child processes in tests strip `HC_*`. All herdr fakes
  are deleted. Dashboard tests are listed explicitly in `skills/wt-dashboard/package.json`; every new or deleted test file updates that list.
- **Red proof.** Each new guard/fix lands with a test run failing first (output in the commit message): env-not-in-argv, env-file-gone (also on a failed
  `hc run`), denylist scrub, `--outlive-parent --no-notify` present, label limits, `name_taken` retry, `<hc>` wrapper -> peer, gate classes, `SENDS`,
  blocked -> queued, no send into a shell, wt-deliver stand-down under hc, pointer typed byte-for-byte after the record.
- **Spikes** (U1, throwaway `claude` in a temp repo on the isolated session; results in `## Spike results` appended here and in the commit):
  S1 does claude report 7501 under `hc run`, what `hc wait`/`hc ls` return across a turn and a permission prompt, the sequence format;
  S2 superseded (no ANSI): instead, does plain `hc read` of a live picker match the `picker-*.txt` fixtures;
  S3 holder ancestor process name for wt-deliver's tree walk;
  S4 `hc send` into a claude: the WP-352 pointer line's paste handling, `<hc>` tagging for senders (a)/(b)/(c) above, `first_message.sent` equivalent;
  S5 env a `hc run --bg` terminal receives, the launcher's `PATH` reaching claude's Bash tool, a var only in the user's shell rc visible to claude,
  no secret in `hc get --json`/argv, the `terminal.run env` API path, whether `hc ls`/`get`/`server status` start a **stopped** isolated core,
  and whether `hc server status --json` carries a core identity;
  S6 can herdr-app show an isolated `HC_SESSION` core (`herdr-app --skill` lists only `HERDR_APP_HOME`); if not, QA step 4 uses the default core (§7).

## 5. Units
Order: U1 first; then U2, U3, U4 and U5 in parallel (disjoint files); U6 after U5 (same `server.mjs`, U6 builds on U5's helper swap); U7 after all;
U8 only if S1 lands on tier 2. Every unit: `Owner: wt-pack:wt-engineer`.

### U1 — adapter + fixtures + spikes (skill: wt-shared)
Owner: wt-pack:wt-engineer
- `hc.mjs` (+ CLI spawn), recorded fixtures for every §2 verb/flag + recording script, fake `hc` shim helper, the `$HOME` per-pane path audit, spikes S1-S6,
  `## Spike results` in this plan, chosen state tier and untagged-send route.
- Tests (`hc.test.mjs`): normalisation from recorded `ls/get --json` (incl. a `machine/` row dropped, a keep-shell row); label set/clear and limits;
  `name_taken`; error mapping (9/10/11); spawn flags; seconds-from-ms timeouts; `nextName`. The opt-in real-hc test (`WT_REAL_HC=1 node --test skills/wt-shared/scripts/hc.test.mjs`).
- Docs: wt-shared SKILL/README note.

### U2 — agents (skill: wt-agents)
Owner: wt-pack:wt-engineer
- `agents.sh spawn|respawn (incl. --stale)|mcp-args|mcp-file|list|rm|dnd|context`, `bin/` shims, `mcp` on hc; `scripts/hc-launch`; pool label; herdr-app space
  lookup/creation under the lock; model/effort/role/project/team/persona as labels; `name_taken` retry; stale pane-key sweep on `hc ls --all`; delete rename/
  tab-drift/stray-tab/stable-id paths; model-floor behaviour (WP-157/160) unchanged and still asserted.
- Tests: spawn-env, list, dnd, respawn, headless-cli, `mcp.test.mjs` on the fake hc; argv has no env value, env file gone incl. after a failed run, denylist
  scrubbed (red first); numbering + retry; hidden fallback when `herdr-app ls` fails; launcher writes the pane-key file.

### U3 — handoff and pane helpers (skills: wt-handoff, wt-shared task-state/agent-pane/pane-submit/wt-message-cli)
Owner: wt-pack:wt-engineer
- `handoff.sh` delivery through the S4 untagged route, queue-then-type, WP-352 `ptr()` typed after the record, WP-360 record once, `--buddy` pair label,
  `--session` spawn via agents.sh, `task-state.sh`, `agent-pane.sh`, `pane-submit.mjs`, `wt-message-cli.mjs`; waits per the S1 tier with seconds and
  the message/timeout loop.
- Tests: `handoff.test.mjs`, `jev-route.test.mjs`, `pane-submit.test.mjs` on the fake hc; record-before-send order; pointer byte-for-byte; no `--force`;
  `--if idle`/foreground check.

### U4 — identity, CLIs, gate (skills: wt-room, wt-ask, wt-ticket, wt-mods, wt-memory, wt-watch-prs, wt-shared gate/mcp/jev-fixtures)
Owner: wt-pack:wt-engineer
- `HC_TERMINAL_ID` replaces every `HERDR_PANE_ID` read in `wt-deliver` (incl. the WP-320 walk from S3), `wt-gate`, `wt-ask`, `room`, `wt-ticket`,
  `wt-keepwarm`, `inject.mjs`, `wt-memory` (role/project from `WT_ROLE`/`WT_PROJECT`, bounded `hc get` fallback), `commands.ts`, `watch-prs.sh`,
  `poller-service.mjs` PATH, `wt-server.mjs` env pass-through; `inject.mjs` `<hc ` -> peer; `gate.mjs` hc classes; `guards.ts` `SENDS` (all red first);
  jev-fixtures text says hc.
- One commit per skill touched.
- Tests: each skill's existing test with `HC_TERMINAL_ID` set and no `HERDR_*`; wt-deliver nested-claude stand-down; `hook-verify.test.mjs` for the `<hc>` wrapper;
  `gate.test.mjs`; `paths.test.mjs`, `plugin-agents.test.mjs`; `skills/wt-mods/scripts/test`.

### U5 — dashboard read side (skill: wt-dashboard)
Owner: wt-pack:wt-engineer
- `server.mjs` `herdr`/`herdrOn` helpers -> `hc.mjs` (remote branches deleted); agent list from one `hc ls --all` per tick, `paneMeta` label sync,
  `agents-table.mjs` reconcile, ghost/exited detection (finished or non-claude foreground), `/api/agents`, pair/task label clear on ticket move,
  banner/source wording ("hc core"; `SOURCES.herdr` -> `hc` incl. `web/src/status.tsx`), remote UI disabled message, production `HC_*` env strips,
  herdr wording in the U5 files and web copy.
- Tests: `agents.routes`, `agents-table`, `pins.routes`, `memory.routes`, `keepwarm.routes`, `pane-key.routes`, `gate.routes`, `asks`, `roles` with the fake `hc`; web typecheck.

### U6 — dashboard write side (skill: wt-dashboard), after U5
Owner: wt-pack:wt-engineer
- `deliver()` paste callbacks (`send --if idle`), blocked -> queued, deliveries sweep/resend (attempt counted only on a typed send), terminals send/keys
  (`herdrKeys` map -> `hc keys`) and shells pool, picker plain-text read, `promptOn.mjs`, `headless.mjs`, `watchdog.mjs` (exited from hc state; Resume via
  agents.sh respawn), `recovery.mjs`, `terminals.mjs`; wait timeouts in seconds (server.mjs:1498,4369); delete `herdrd.mjs`, remote code, the probe's
  `herdr server` start (probe reports `hc server status` only); `service.mjs`/`wt-dashboard.service` PATH and comments; Tauri `main.rs` check; `package.json` test list.
- Tests: `dispatch.test`, `headless.test`, `watchdog.test`, `recovery.test`, `envelope.routes`, `verify.routes`, `deliveries.routes`, `promptOn.test`, `parse.test`
  (picker from plain fixtures) with the fake `hc`; dashboard `npm test`.

### U7 — setup, doctor, docs, sweep (skills: setup script, wt-setup, docs)
Owner: wt-pack:wt-engineer
- `./setup doctor`: `hc` present, `hc server status` (non-starting per S5), `herdr-app` presence (info), info on `notes` in the user's hc config (read only),
  and a warning for leftover old-multiplexer settings/launchd entries (its literals in one block marked `legacy-herdr`); installs nothing; remove herdr
  integration/config checks. `test/docker` installs and starts hc. `plugin.json` description.
- `docs/features.md`, every SKILL.md/README/reference with a herdr mention (§2 inventory), CLAUDE.md (hc throughout; Traps rewritten: labels vs tokens,
  `--outlive-parent`, no rename, names unique, no CLI `--env` so the launcher, `--no-notify` vs `<hc>` tags, keep shells, plain-text read; herdr-only traps
  deleted, lessons that still apply kept and worded "the old multiplexer"). The flip runbook (§7) in docs.
- The final grep gate (DoD) and root `npm test` green.

### U8 — status bridge (skill: wt-memory), conditional on S1 tier 2
Owner: wt-pack:wt-engineer
- Hooks emit OSC 7501 per §4 (permission-prompt matcher for blocked, working again on PreToolUse); tests with a fake tty file incl. an idle notification that
  leaves status idle; hook stays inside its timeouts; no behaviour change when `HC_TERMINAL_ID` is unset.

## 6. Definition of Done
- [ ] Zero herdr remains: `grep -rniE '\bherdr\b|HERDR_PANE_ID|HERDR_ENV|canonicalPane|--machine|herdrOn|herdr server'` over the repo (excluding `docs/plans/`,
  `node_modules`, and lines matching exactly one of: `x-herdr-pane`, `x-herdr-session`, `HERDR_DASH_URL`, `HERDR_DASH_PROJECTS`, `HERDR_DASH_ALLOWED_HOSTS`
  (legacy aliases, CLI back-compat), `herdr-dash` (upload path, package name, fixture path), `herdr-app`, `herdr-core`, `herdr.space`/`herdr.tab`,
  `legacy-herdr`) returns nothing; QA runs it. If R2 is answered yes, the protocol exclusions go.
- [ ] Root `npm test` and dashboard `npm test` (incl. web typecheck) pass; `skills/wt-mods/scripts/test` passes; `WT_REAL_HC=1` real-hc test passes on an isolated `HC_SESSION`.
- [ ] Spawn, respawn, list, rm, dnd, handoff delivery (pointer typed byte-for-byte, untagged, recorded before send), wait, read, label set/clear, watchdog Resume work on hc.
- [ ] A spawned agent survives its spawner (`--outlive-parent`), has `--no-notify`, shows in the dashboard Agents list with role/project/model/effort, and shows in herdr-app
  under its pool space (or a spawn warning is printed when the app is unreachable).
- [ ] An hc-spawned agent has `WT_PANE_KEY`, `GH_TOKEN` (when configured) and the kill-shim PATH first in its env, none of them in any argv (`ps`, `hc get --json`),
  none inherited from the core unless the spawner set them; the env file is gone after launch and after a failed launch.
- [ ] S1-S6 results recorded in this plan; agent-state tier chosen and works (a blocked/idle agent is detected by the dashboard and by handoff waits); a blocked agent's
  message is queued, not forced, not counted; a keep shell is never typed into.
- [ ] Each new guard or fix has a red proof; `<hc>`-wrapped prompts are peer; gate classes for hc verbs; wt-deliver nested-claude stand-down under hc; `SENDS` refuses an `hc`
  call carrying the user-level skills path.
- [ ] Nothing in the pack starts an hc core or a herdr server or edits the user's hc config; `./setup doctor` reports hc state; docs, SKILL.md files and CLAUDE.md are hc-only.
- [ ] One commit per skill touched; pushed only after Gate B; no real terminal touched (QA compares `hc ls`, `pane-keys/` and `turn-*` before/after).

## 7. QA brief
A user (or the auditor) does, in a temp repo on a throwaway isolated core (`HC_SESSION=wtqa-<id>`, scratch `XDG_*`, `WT_DASHBOARD_DATA`, `XDG_CACHE_HOME`,
`XDG_DATA_HOME`; the user's own core is only read with `hc ls`, except step 4):
1. `agents.sh spawn worker` twice; `list --json`; `dnd on/off`; `respawn`; `rm`. Confirm names `<repo>-worker-01/02`, labels, `hc get` shows no secret in argv, the terminal outlives the spawning shell.
2. `handoff.sh --task` a short prompt to a spawned agent; read its screen; confirm the typed line is the exact recorded pointer (no `<hc>` wrapper) and the message row existed before delivery; a blocked agent is not forced and its message stays queued.
3. Start a dashboard against a PATH shim (hc on the isolated session), open Agents, send a room message to an agent; confirm the status shown matches S1's tier.
4. herdr-app: on the isolated core if S6 says the app can show it; otherwise one `wtqa-` agent and one `wtqa-` space on the default core (CLAUDE.md WP-348 allows throwaway agents on the real mux), removed by recorded id. Confirm the agent appears in its pool space; with the app unreachable, the spawn warns and still works.
5. `./setup doctor` output with the isolated core up and down; the DoD grep.
Evidence kept (nothing else): command transcripts with exit codes for 1, 2, 5; `hc ls --json`, `pane-keys/` listing and `turn-*` listing before/after on the default session
(equal except step 4's recorded `wtqa-` ids, gone at teardown); one `agent-browser` screenshot of the Agents list (session `<agent name>`); test summaries; the grep output.
Teardown: kill/rm recorded terminals by address, remove the recorded space, stop only the isolated core.

**Flip runbook (U7 doc, used at merge).** The plugin is the checkout (`CLAUDE_CODE_PLUGIN_DIRS`), so the merge switches every live herdr agent's hooks to
`HC_TERMINAL_ID` at once: they lose identity, including the lead and orchestrator driving this ticket. Steps: finish everything gate C needs on the ticket
branch; then, in the window R6 picks, stop the herdr agents, merge and push, `npm run service:restart` once, respawn the orchestrator and lead under hc
(`agents.sh spawn`), confirm `./setup doctor`. Gate C accounts for this step.

## 8. Open questions for the user (defaults used if unanswered)
- **R1** herdr-app unreachable at spawn: default spawn hidden with a warning. Alternatives: refuse the spawn (agents always visible) or auto-open `herdr-app`. Changes only U2's fallback branch and the DoD line on visibility. (Spaces live in the core's app document, not only the window.)
- **R2** Rename the protocol names (`x-herdr-pane`/`x-herdr-session` headers, `HERDR_DASH_*` legacy aliases, `herdr` wording in route names) to hc names? Default keep: renaming touches dashboard, every CLI and the pane-key scheme (non-goal). Yes adds a rename pass to U4/U5/U6 and drops those DoD grep exclusions.
- **R3** One herdr-app space per pool (`<repo>-<role>s`, tab per agent) as assumed, or one space per repo with all roles as tabs? Default per pool, matching today's workspaces. Changes only U2's space lookup.
- **R4** If S4 shows `hc send` tags every pack send and no untagged route exists: may the pack require `notes = false` in the user's `~/.config/herdr-core/config.toml` (doctor checks it, setup offers it), which also silences hc notes for the user's own hc use? Default no: the pack never edits it; agent-originated sends then queue through the dashboard only. Changes U3/U4 fallback and U7 doctor.
- **R5** The dashboard Terminals view becomes plain text (no colour) because `hc read` has no ANSI. Default accept plain text. Alternative: stream colour from `terminal.attach` through the adapter (adds a streaming reader to U6). Changes only U6's terminals view.
- **R6** When to flip (§7 runbook): every live herdr agent stops working at merge. Default: the user picks a window after gate C; nothing merges before. Changes only the merge timing.
Everything else from revision 1 (Q1-Q5, WT_BACKEND, dual-backend routing, union numbering, shell-wrapper cost) is resolved or deleted.

## 9. Review history
- Revision 1 tech-lead review (wt-review plan mode): kept here, still valid: no `--env` -> launcher + S5; `self` env-only; inventory additions (`promptOn.mjs`, `watchdog-probe.sh`,
  `guards.ts SENDS`, `wt-server.mjs`); red proofs; real-fixture shims; S1 failure also breaks handoff waits -> tiered fallback; isolated-core teardown; parallel units on branches.
  Obsolete after the total switch: id-shape routing, `list --all`, union numbering across backends, `mux.sh` wrapper cost.
- Gate A (revision 1): REJECTED by the user in favour of a total switch (§1). Revision 2 needs a fresh plan review before Gate A.
- Revision 2 tech-lead review (wt-review plan mode, lenses coherence, feasibility, standards, agent-native, testing, learnings, security, scope, reliability,
  performance; 18 confirmed, 0 refuted, 1 unverifiable): applied in 2.1. Inventory completed with an owner per file (remote code, web, service, docker, SKILL prose);
  unmapped verbs added (resume-into-pane, process-info, tabs/workspaces, shells); `<hc>` tags not stopped by `--no-notify` -> peer classification + untagged route (S4, R4);
  isolated-core address aliasing -> scratch data/cache dirs + teardown asserts; keep shells never typed into; blocked delivery queued; `hc wait` seconds/message;
  launcher scrubs core env, login shell, no eval, API `env` tried (S5); name race retry; gate classes for hc verbs; U6 after U5, spawn only via agents.sh;
  no ANSI read -> plain-text picker (R5); tier-2 Notification matcher; DoD grep exclusions; flip runbook (R6). Unverifiable: whether `hc ls/get/server status`
  start a stopped core on macOS -> S5.
