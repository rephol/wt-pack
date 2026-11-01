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
- **Launcher `skills/wt-agents/scripts/hc-launch <envfile> -- <argv...>`** (superseded in part by D2/D3: API `env`, no file, `-l -i`). Why: no CLI `--env`; the terminal env is the core's (whoever started it),
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

### U8 — status bridge (skill: wt-memory), conditional on S1 tier 2 — DROPPED (S1 tier 1, D10)
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
- [ ] The user's `~/.local/bin/claude` still points at the same target and resolves after every spike, recorder and QA run (U1's isolated-`XDG_DATA_HOME` spike once repointed it into a
  deleted temp dir). Check: `node skills/wt-shared/scripts/claude-link-guard.mjs snapshot <file>` before, `... check <file>` after (exit 1 on any change or a dangling link); isolated children
  run with `quietEnv()` (DISABLE_AUTOUPDATER=1, DISABLE_INSTALLATION_CHECKS=1, no isolated `XDG_DATA_HOME`); `hc-record.mjs` and the `WT_REAL_HC` test enforce it themselves.
- [ ] One commit per skill touched; pushed only after Gate B; no real terminal touched (QA compares `hc ls`, `pane-keys/` and `turn-*` before/after).

## 7. QA brief
A user (or the auditor) does, in a temp repo on a throwaway isolated core (`HC_SESSION=wtqa-<id>`, scratch `XDG_STATE_HOME`/`XDG_RUNTIME_DIR`, `WT_DASHBOARD_DATA`, `XDG_CACHE_HOME`
(not `XDG_DATA_HOME`: see the isolation rule below); the user's own core is only read with `hc ls`, except step 4):
1. `agents.sh spawn worker` twice; `list --json`; `dnd on/off`; `respawn`; `rm`. Confirm names `<repo>-worker-01/02`, labels, `hc get` shows no secret in argv, the terminal outlives the spawning shell.
2. (U7 brief: also `handoff.sh --goal` and one dashboard dispatch with a goal, expecting the target's reminder to say Verified and the goal to arm (D28); and a free-text AskUserQuestion answer on the isolated core, single-select and multi-select (D26).) `handoff.sh --task` a short prompt to a spawned agent; read its screen; confirm the typed line is the exact recorded pointer (no `<hc>` wrapper) and the message row existed before delivery; a blocked agent is not forced and its message stays queued.
3. Start a dashboard against a PATH shim (hc on the isolated session), open Agents, send a room message to an agent; confirm the status shown matches S1's tier.
4. herdr-app: on the isolated core if S6 says the app can show it; otherwise one `wtqa-` agent and one `wtqa-` space on the default core (CLAUDE.md WP-348 allows throwaway agents on the real mux), removed by recorded id. Confirm the agent appears in its pool space; with the app unreachable, the spawn warns and still works.
5. `./setup doctor` output with the isolated core up and down; the DoD grep.
Evidence kept (nothing else): command transcripts with exit codes for 1, 2, 5; `hc ls --json`, `pane-keys/` listing and `turn-*` listing before/after on the default session
(equal except step 4's recorded `wtqa-` ids, gone at teardown); one `agent-browser` screenshot of the Agents list (session `<agent name>`); test summaries; the grep output.
Teardown: kill/rm recorded terminals by address, remove the recorded space, stop only the isolated core.
Isolation rule: never give a `claude` child an isolated `XDG_DATA_HOME` (its installer keeps versions and the `~/.local/bin/claude` link there) and start children with `DISABLE_AUTOUPDATER=1 DISABLE_INSTALLATION_CHECKS=1`.
Run `claude-link-guard.mjs snapshot` before step 1 and `check` as the last teardown step; a failure fails QA (do not repair the link from QA, report it).

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

## Spike results (U1, hc 0.1.16, 2026-11-01)
Run on isolated cores only (`HC_SESSION=wtt1`, scratch `XDG_*` under a short `/tmp` dir because a socket path is limited to 103 bytes,
`WT_DASHBOARD_DATA`/`WT_TURN_DIR`/`WT_MEMORY_CACHE`/`WT_MESSAGES_DIR` in scratch, `HERDR_DASH_URL` on a closed port, every hc and claude started
through `env -i` with a clean env so none of the engineer's own `HERDR_*`/`WT_PANE_KEY`/`GH_TOKEN` entered the core). Throwaway `claude --model haiku`
terminals in a temp repo. Every core and terminal was stopped by recorded pid/address; the default core (`hc ls`, `pane-keys/` = 10 files,
`~/.cache/wt-memory/turn-*` = 353) was identical before and after. Recordings: `skills/wt-shared/scripts/fixtures/hc/`.

**Chosen: agent-state tier 1 (claude reports natively; no U8). Pack sends: untagged, S4 route below.**

- **S1 tier 1.** claude reports OSC 7501 on its own under `hc run --bg` (no hook needed). `hc get`: `status:{app:"claude-code",state,msg,kind?}`,
  `turn`, `title`. States seen: `idle` (fresh, trust dialog accepted) -> `working` (during a turn) -> `done` (turn finished; **stays `done`**, over
  several reads and 5+ minutes; it is the resting state, `idle` is only the fresh state) and `blocked` (`kind:"permission"`, `msg:"approve Write: <path>"`;
  `kind:"question"`, `msg:"answer: <question> (<options>)"` for AskUserQuestion). `hc wait <t>` returns `{ended:true,reason:"status",status:"done"|"blocked",turn}`
  on a turn end or a block, `{ended:false,reason:"timeout"}` at its check-in, `reason:"exit"` + `exit_code` for a program that ended.
  **Corrections to the plan**: (1) `hc ls --json` is a slim summary (address, agent, cwd, name, state, status word, turn) with **no labels and no
  foreground**; the full rows (labels, status object, foreground, argv) come from `terminal.list` over `hc connect` in ONE call, which `hc.mjs list()` uses
  (still one hc invocation per tick, ~12 ms). (2) `hc send --if idle` is refused with `status_mismatch` ("is done, not idle") for the normal resting
  `done`: `send({ifIdle})` retries one plain send when the message says `is done`, and does not retry for `working`, `blocked` or a shell. (3) `foreground.name` of a
  claude is its version string ("2.1.316"); `ls` `agent` is `claude-code`; use `argv[0]` basename (`program`) or the status object. (4) The Notification-idle
  concern is moot at tier 1 (claude itself decides `blocked`).
- **S2 picker.** A live 3-question `AskUserQuestion` read with plain `hc read` has exactly the layout of the `picker-*.txt` fixtures (tab bar `←  ☐ Color  ☐ Size  ☐ Shape  ✔ Submit  →`,
  question, options, `Enter to select · Tab/Arrow keys…` footer), so `parsePickerText` works on it. The **focused tab is not recoverable from plain text**
  (the tab row is identical on every tab; only the question text under it changes) and `read` has no ANSI mode. Options for U6: the blocked `msg` carries the current
  question text, so focus can be matched against questions seen on earlier frames/keys the pack pressed, or one ANSI frame from `terminal.attach`'s first paint.
- **S3 holder.** A claude's parent is the holder, command `<dir>/hc hold --socket <state>/…holder.<id>.sock` (the default core shows `herdr-core hold --socket …`);
  its parent is the core `hc serve` / `herdr-core serve`. No shell sits between when the program is run directly. The wt-deliver walk matches basename in
  {`hc`,`herdr-core`} with a following `hold` argument and stands down when more than one `claude` lies below it.
- **S4 send.** Typed text is the argument byte for byte (a `<wt-message …>` pointer line arrived as the exact single line). A long multi-line text collapses to a pasted block
  (as before), so only the pointer is typed. **Tagging depends on the SENDER being an agent terminal**: sent from a plain process (a launchd dashboard, no
  `HC_TERMINAL_ID`), or from a plain `sh` terminal (also as its child), the line is untagged; sent from a **claude** terminal (`hc send` run by its Bash tool) it
  arrives as `<hc from="t5 s2">…</hc>`. The tag is **not** stopped by `--no-notify` or `--no-parent`. Routes: (a) dashboard/no-terminal sender: **untagged**;
  (b) inside an agent terminal: **tagged**; (c) (b) with only `HC_TERMINAL_ID` unset for the call (`env -u HC_TERMINAL_ID hc send …`; unsetting
  `HC_SCOPE` or `HC_TERMINAL_SOCKET` alone does not help): **untagged**. `notes = false` in the (isolated) `config.toml` also made (b) untagged, taking effect on the next
  CLI call with no core restart (R4 yes: valid, but not needed). **Route chosen: dashboard `deliver()` for server sends; script-side sends (`handoff.sh` and the like) run
  `env -u HC_TERMINAL_ID hc send`**, no config edit needed; R4's consent stays unused unless U3 finds a reason. `inject.mjs` still classifies `<hc ` as peer (belt).
  With the pointer sent to a claude whose hooks resolve no pane identity, the hook marked it "unverified": the hooks do fire under hc. `first_message`: not present for a
  plain `hc run … claude "<prompt>"` (the prompt is argv); it is a template-run field.
- **S5 env and core.** (1) A terminal started with an explicit command gets the **core's** environment plus `HC_SESSION`, `HC_SCOPE`, `HC_TERMINAL_ID`,
  `HC_TERMINAL_SOCKET` (and `TERM`/`COLORTERM`/`TERM_PROGRAM`); the **client's** environment is ignored (an `env VAR=… hc run claude` on the client side did not reach it).
  A core started from an agent's shell would therefore carry that agent's `GH_TOKEN`/`WT_PANE_KEY`/`HERDR_*` into every terminal (it did, on the first attempt, before the core was
  restarted clean): the denylist scrub in the launcher is necessary. (2) No login shell: `zsh -l -c` adds only `.zprofile` variables (Homebrew, PATH rewritten to
  start with `/opt/homebrew/bin`); `.zshrc`-only variables (ANDROID_HOME, JAVA_HOME, NVM_*, BUN_INSTALL, …) appear only with `zsh -l -i -c`. **The launcher's `$SHELL -l -c` misses them; U2 must decide `-l -i`.**
  (3) `env VAR=… claude` as the terminal's command reaches claude and its Bash tool (`PATH` with the shim dir first and a custom var arrived unchanged) when no shell rc runs in between;
  a login shell rewrites PATH, hence the planned `CLAUDE_ENV_FILE` re-prepend. (4) The API path works: `hc connect` `terminal.run` with `env:{…}` put the values in the program's
  environment (and `PATH` replaced) while `hc get --json` and `ps` argv show none of them; params are `argv, cwd, env, labels, name, no_notify, no_parent, outlive_parent, parent,
  keep, rm, timeout, wait`. U2 may use it (secrets then need no file at all) — the launcher is still needed for the denylist/pane-key/login-shell steps. (5) **`hc server status`, `hc ls` and `hc get`
  each START a stopped core** on macOS (checked for all three on the isolated session). A non-starting probe exists: `core.lock` holds the socket path; connecting to it answers up/down —
  `hc.mjs coreUp()` does exactly that (doctor and the dashboard must use it, never `hc server status`). (6) `hc server status --json` carries `core.id` (a permanent random id, different
  per session) and `core.name` (hostname), `pid`, `uptime_ms`, `holder`/`holders` with `instance` ids, `live`, `finished`: the identity to compare for "core changed". Terminals persist across a
  core stop/start (`hidden_finished` kept). (7) hc enforces **no label limits** (a 200-char value and the key `bad key` were stored); the 32/80/key rules live in `hc.mjs`. (8) A **keep** terminal whose program
  was killed by a signal becomes a login shell at the same address (`argv:["/bin/zsh","-l"]`, `agent:"zsh"`, `keep:true`) and **its labels are gone** (`labels:{}`): identity must not
  depend on labels once a terminal may have been recovered; the agents table row (name/pane id) is the identity. `hc send --if idle` to that shell is refused ("silent, not idle"): never typed into.
  (9) `hc ls --json` also reports `machines` (connected hosts) at top level and `machine/tN` rows; `list()` drops the rows.
- **S6.** `herdr-app --skill`, `--help` and `AGENTS.md` mention only `HERDR_APP_HOME` and a configurable core binary; nothing selects a core session, and showing an isolated core would
  need a second app instance (opens a window) — not attempted. Treat as **no**: QA step 4 uses a `wtqa-` agent and space on the default core. `herdr-app ls` with no spaces prints
  `{"spaces":[],"recent":[{"name":"","folder":"…"}]}`; the **non-empty `spaces` shape is unrecorded** (it needs a space in the user's window; U2/QA records it with step 4's throwaway space).
  Adoption by `herdr.space` labels enables core keep on that terminal (AGENTS.md:141), so an adopted agent that dies becomes a login shell with no labels (see S5-8).

**Per-pane paths under `$HOME` (audit; the isolation vars the pack really honours).** Pane-key files `$WT_DASHBOARD_DATA/pane-keys/<id>` (agents.sh:414, handoff.sh:115, server.mjs:3312);
turn records `$WT_TURN_DIR/turn-<id>.json` (inject.mjs:52, wt-gate:31) — **not** `XDG_CACHE_HOME`; agents.sh `mcp-<name>.json`/`env-<name>.sh` under `$XDG_CACHE_HOME/wt-agents`; message bodies
`$WT_MESSAGES_DIR` (handoff.sh:514; ignores `WT_DASHBOARD_DATA`); receipts `$WT_RECEIPTS_DIR`; recall state `$WT_MEMORY_CACHE` (wt-memory:246). Not isolated and keyed by session id, not address
(no aliasing, but an isolated run still writes the real `~/.cache/wt-memory/<session>.{recalled,hash,ctx}`): inject.mjs:120,139 (U4 may honour `WT_TURN_DIR`/`WT_MEMORY_CACHE` there).
`XDG_DATA_HOME` is honoured by none of them. The isolation set for spikes/QA is therefore `WT_DASHBOARD_DATA`, `WT_TURN_DIR`, `WT_MESSAGES_DIR`, `WT_MEMORY_CACHE`, `XDG_CACHE_HOME`
(+ `HERDR_DASH_URL`), and U2's new launch dir (`~/.local/share/wt-agents/launch/`) needs an env override honoured the same way.

## Tech-lead decisions after U1 (override §4/§5 where they differ)
- **D1 list.** Confirmed: `hc.mjs list()` = one `hc connect` `terminal.list` per tick (full rows: labels, status object, foreground, argv); `hc ls --json`
  is not used for state. Every caller that must not start a core (dashboard tick, doctor, the wt-memory fallback) calls `coreUp()` first and skips hc when it
  is down; U5 records whether `hc connect` itself starts a stopped core (fixture + test), but the `coreUp()` gate stays either way.
- **D2 launcher shell: `$SHELL -l -i -c`.** Reason: agents ran in the user's interactive shell under herdr; S5-2 shows `-l -c` drops every `.zshrc`-only
  var (NVM, JAVA_HOME, BUN, …) that claude's Bash tool relies on today. Pack values must win over the rc: stage 1 (before the shell) scrubs the denylist
  except keys the spawner set, writes the pane-key file and keeps the pack values in the env; the shell runs `hc-launch --after-rc -- claude …` (no value
  in argv), which re-applies the pack values and the shim-first `PATH`, unsets its own bookkeeping vars and `exec`s claude. Red test: an rc that sets
  `GH_TOKEN` and rewrites `PATH` does not win. **`HC_SESSION` leaves the denylist**: the core sets it to its own session for the terminal (S5-1), and
  scrubbing it would point an isolated-core agent's `hc` calls at the default core.
- **D3 secrets: `terminal.run` API `env`, no env file.** Reason: S5-4 shows the values reach the program and appear in neither `hc get --json` nor `ps`
  argv, so nothing secret touches disk; the 0600 file, its launch dir, the delete-on-failed-run path and the 10-min sweep are dropped (the launch-dir env
  override is moot). `hc.mjs spawn` sends `terminal.run` over `hc connect` with `argv,cwd,env,labels,name,no_notify:true,outlive_parent:true` and passes
  `WT_LAUNCH_KEYS=<names it set>` so stage 1 knows which denylisted names to keep; `name_taken` over the API is recorded as a fixture and mapped like the CLI.
  Red proofs kept: no value in argv/`hc get`, denylist scrubbed, pack values beat the rc.
- **D4 core never started.** `hc server status`, `hc ls`, `hc get` start a stopped core (S5-5). Doctor and the dashboard use `coreUp()`, then (only if up)
  `hc server status --json` for `core.id`. `agents.sh spawn|respawn` refuses with "hc core is down" when `coreUp()` is false. The dashboard stores `core.id`
  and drops agents-table rows and pane keys when it changes (the §4 "if S5 finds a core identity" is now a U5 task).
- **D5 sends (S4).** Server sends: `deliver()` from the launchd dashboard (untagged). Script sends (`handoff.sh`, the `herdr agent prompt`/`send-text` sites
  at handoff.sh:274,299,301,470,498,500 today): `env -u HC_TERMINAL_ID hc send`, after the record, pointer only. Ready = status `idle` or `done` (S1: `done` is
  the resting state) everywhere: dispatch's free-worker check, handoff waits, watchdog, `hc.mjs send({ifIdle})` (its retry on "is done, not idle" is
  approved; it never retries for working/blocked/a shell). R4: the user allows `notes = false`; the pack does not need or set it, doctor reports it (info).
  New gate class (U4, red first): a Bash command that calls `hc send`/`hc keys` itself with `HC_TERMINAL_ID` unset or emptied (`env -u HC_TERMINAL_ID`,
  `HC_TERMINAL_ID=`) is a forged-untagged send to another terminal: ask. Pack scripts run that call inside their own process, so they are not affected.
- **D6 picker focus (S2).** No `terminal.attach` ANSI reader. U6 tracks the focused tab: index 0 when a picker first appears (new blocked `kind:"question"`),
  updated on each key the dashboard sends, and resynced by matching the displayed question text (and the blocked `msg` question) against questions seen
  on earlier frames. Red test on the `picker-*.txt` fixtures plus a recorded multi-tab sequence.
- **D7 wt-deliver walk (S3).** Holder = a process whose argv[0] basename is `hc` or `herdr-core` with argv[1] `hold`; stand down when more than one `claude`
  lies between it and the caller. Red test with a faked process table.
- **D8 identity after keep.** Labels are lost on a kept terminal (S5-8): the agents-table row (name, address) is the identity; a terminal whose foreground is not
  claude is exited (Resume offered), never typed into.
- **D9 isolation paths.** U4 makes `inject.mjs` write its `<session>.{recalled,hash,ctx}` under `$WT_MEMORY_CACHE` (default unchanged), so an isolated run
  touches no real `~/.cache/wt-memory` file. Isolation set for tests/QA: `WT_DASHBOARD_DATA`, `WT_TURN_DIR`, `WT_MESSAGES_DIR`, `WT_MEMORY_CACHE`,
  `XDG_CACHE_HOME`, `HERDR_DASH_URL`, scratch `XDG_STATE_HOME` under a short path (socket ≤103 bytes).
- **D10 U8 dropped** (S1 tier 1). The tier-2/3 fallback text in §4 is history.

## Tech-lead decisions after U2-U5 integration (merged into `wp-378-hc-backend`: U2 a9572c6, U3 79e51d7, U4 bdedc17, U5 df971cc)
No textual conflicts. U5's `hc.mjs` change (CLI guard without top-level await, for the sidecar's CJS bundle) and U2's `hc.mjs` changes
(`terminal.run` spawn, `core-up`) touch different lines; `fake-hc/hc` (U2) and `wt-dashboard/test-hc.mjs` (U5) are separate stubs.
- **D11 protocol names stay** (R2 answered keep): `x-herdr-pane`, `x-wt-pane-key`, `HERDR_DASH_URL` and the `HERDR_DASH_*` aliases keep
  their names; only the value changes (`HC_TERMINAL_ID`). The DoD grep exclusions stay.
- **D12 `hc-kill` gates every raw `hc kill|rm`, no allowlist.** The sanctioned path is `agents.sh rm` (refuses a working agent), which runs
  `hc` inside its own process where the Bash gate never looks; a raw `hc kill tN` typed by an agent is an ask, not a deny. An "I started it"
  allowlist would need an `hc get` inside the gate hook (§4: no hc call in a hook but the wt-memory fallback), and parentage is no identity
  once `--outlive-parent`/keep apply (S5-8).
- **D13 pool label agreed.** `agents.sh` sets `wt.pool=${WT_AGENTS_WORKSPACE:-<basename of the target's main checkout>-<base role>s}`;
  `handoff.sh` `ws_label` (`HANDOFF_WORKSPACE` or `<basename main>-workers` / `-<role>s`) and `watch-prs.sh` (`<basename MAIN>-reviewers`)
  compute the same string. A persona spawns into its base role's pool on both sides. No change.
- **D14 bare `tN` ids across cores, kept.** Pane keys, turn records and agents-table rows key on the bare address. The dashboard and the pack
  talk to the default core only; tests and QA isolate with the D9 set; the dashboard drops rows and keys when `core.id` changes (U5); agents.sh
  sweeps keys of non-live ids at spawn. A core prefix in the key would change the pane-key scheme (non-goal).
- **D15 `agents.sh spawn` prints `<name> <id>`** (unchanged from herdr's `<label> <pane>`): `handoff.sh --session`, dispatch and the tests
  parse it; warnings go to stderr. Keep.
- **D16 script-side blocked = exit 1, no script queue.** A shell script has no lifetime to hold a queue; the dashboard queue (`queue_pulled`,
  WP-272) already covers a live mod, and the caller (dispatch keeps the card in Ready) retries. Fix (F1, U3 follow-up): `handoff.sh` checks the
  target row's status BEFORE recording and exits 1 with nothing recorded when it is `blocked`; a row recorded as `delivered` and then refused
  would otherwise be acked by `seen()` (it still counts `blocked`, U6 removes that) or resent by the sweep beside the caller's retry.
- **D17 `waitReady` keeps accepting `agent_status`** until U6 moves the server callers to hc rows; U6 deletes the fallback.
- **D18 session id from `claude agents --json` only: approved.** It was already the WP-324 cross-check (3 s cache, 5 s timeout, best effort);
  the launcher execs claude through the shell, so the terminal's foreground pid is claude's pid and the pid match holds. No session = Resume
  starts fresh, as before.
- **D19 a down core is 503, not 500** (U6). `agents()` keeps throwing `core_down` (the `soft('hc')` banner relies on it); the request error
  handler maps `code === 'core_down'` to 503 `{error:'hc core not running — run hc server start'}` in one place. Red test: a route that calls
  `agents()` uncaught (e.g. `GET /api/agents/by-name/x` as a pane) with the stub core down returns 503.
- **D20 hc timeouts under test load (F2).** `hc connect timed out after 2000 ms` failed `agents.routes` (2 tests) and `dnd.test` (1) when the
  dashboard and root suites ran at once: the fake `hc` is a node script and a cold start under load passes 2 s. `hc.mjs` multiplies `TIMEOUT`
  by `WT_HC_TIMEOUT_SCALE` (integer 1-10, default 1, anything else ignored); `test-hc.mjs` `hcStub` and `hc-test-kit.mjs` set 5 in the
  child env. Production is unchanged.
- **D21 `agent-pane.sh` identity** — resolved by U3: it sends `x-herdr-pane: $HC_TERMINAL_ID`. Remaining `HERDR_PANE_ID` reads are U6
  (`dispatch.mjs` `runHandoff` blanks it: becomes `HC_TERMINAL_ID: ''`) and U7 (`wt-finish/SKILL.md:92`).
- **D22 herdr-app stray shell (U2) approved, QA-checked.** `space.new` opens a shell (`terminal` in its answer); agents.sh kills+rms it after the
  agent's terminal exists and only while it is still a plain shell (also on a failed spawn). QA step 4 confirms: the pool space shows only the
  agent's tab, no stray shell, and on a failed spawn no stray is left; an empty space left behind is acceptable.
- **D23 isolation vars forwarded (U2) approved.** `WT_DASHBOARD_DATA WT_TURN_DIR WT_MESSAGES_DIR WT_MEMORY_CACHE WT_RECEIPTS_DIR
  XDG_CACHE_HOME HERDR_DASH_URL` ride `terminal.run env` when set in the spawner and survive the launcher's scrub through `WT_LAUNCH_KEYS`.
- **D24 `~/.local/bin/claude` after U5's isolated run.** `claude-link-guard.mjs check` against target `~/.local/share/claude/versions/2.1.316`
  passes (link resolves, newest installed version). The link's own mtime is 16:59, inside U5's work window, so something rewrote it to the same
  target: no damage, but the isolation rule was broken. Every later run uses `quietEnv()` and a guard snapshot taken BEFORE the run.
- **D25 F1/F2 landed** (7896556 wt-handoff, f2bcf57 wt-shared incl. `fake-hc.mjs` default scale 5, 7a65d5f wt-dashboard, b97e119 wt-agents);
  root `npm test` 488/488, dashboard `npm test` 796/796 + web 109/109 + typecheck. Pending, not blocking: `handoff.sh --reply` to a blocked
  target still records a `delivered` reply row before `hc_send … any` refuses it. Replies are not in `ACK_KINDS`, so the sweep neither acks nor
  resends it (a wrong state, no duplicate); U6 gives the reply path the same pre-check when it touches delivery states. `uploads.test.mjs`
  assumes `TMPDIR` is set (fails under a bare `env -i`): run suites with `TMPDIR` kept.

## Tech-lead decisions after U6 (b4a394e wt-shared, c8a2589 wt-handoff, b9f2409 wt-dashboard; dashboard 808/808, root 490/490)
Probe (tech lead, isolated core `HC_SESSION=wtkprobe`, scratch `XDG_*`, one `/bin/cat -v` terminal, no claude; core stopped, dir removed; default core untouched):
`hc keys` sends a key NAME per argument. `A` arrives as `a`; `shift+a` arrives as `A` (every letter); `shift+9`/`shift+1`/`shift+/` arrive UNshifted (`9 1 /`);
`; ] \`` are accepted; `! @ # $ % ^ & * ( ) _ + { } | : " < > ? ~`, `shift+minus`, `shift+semicolon` and non-ASCII (`é`) are `invalid_params` (unknown key).
`pageup home end pagedown` arrive as `ESC[5~ ESC[H ESC[F ESC[6~` (standard xterm). `hc attach` refuses a pipe ("attach needs a terminal"); the API
`terminal.attach` takes raw DATA bytes only on a framed connection whose frame format `hc schema` does not document, and a non-observe attach sets the
terminal's size to the viewer's (it would reflow the agent's TUI).
- **D26 picker free text (Q1): `hc send --force` on the user's answer route only.** Reason: `--force` exists for exactly this ("it may answer its dialog");
  the never-force rule protects deliveries from answering a dialog nobody chose, while `POST /api/agents/<m>/<pane>/answer` needs the session cookie (no
  `x-herdr-pane` exemption, server.mjs:2439-2465), so the force is the user's own act, as herdr's `send-text` was. `answerPlan`'s `{text}` + following `enter`
  becomes one forced send (paste + Enter); keys stay `hc keys`. hc.mjs gains `send(..., { force: true })`, used by `answerQuestion` and nothing else; every
  `deliver()`/sweep/flush path still refuses `force` (test asserts no `--force` in their argv). Single-select: verified live on an isolated core (throwaway
  claude, `AskUserQuestion` with Other, link guard) that the pasted text lands in the Other field and Enter submits it. Multi-select (`text` then `down enter`):
  the forced Enter lands inside the Other field; the engineer verifies live what it does and re-reads the screen (Other checked with the text) before
  continuing to Submit. If that cannot be made reliable, multi-select Other alone keeps the 409 and goes to gate B as an open user question.
- **D27 xterm typing without Enter (Q2): capitals via `shift+<letter>`, the rest stays refused.** Reason: probe above. `typeKeys` maps `A-Z` to
  `shift+a`..`shift+z` and adds `; ] \``; everything else in the list above keeps the 400 with the "use the input line" message (a line with Enter goes
  through `hc send`, any character). No technical route for the remaining characters inside this ticket (undocumented framed attach, resize side effect):
  open user question at gate B (U-Q1 below).
- **D28 pasted `/goal <pointer>` under hc (Q3): a gate B QA item, no code change now.** Reason: S4 showed the pointer arrives as the exact single line, U6
  checked a pasted slash command runs, and `inject.mjs` verification is the same code as under herdr; what is unproven is only the live pair. QA step 2 adds
  `handoff.sh --goal` and one dashboard dispatch with goal: the target's reminder says Verified and the goal arms. A failure routes to `inject.mjs` (U4 area).
- **D29 blocked queue in memory (Q4): accepted as built.** Reason: a dashboard restart is rare and operator-driven (CLAUDE.md: don't restart repeatedly);
  ack kinds (`handoff|dispatch|routine`) stay `queued` and the WP-257 sweep resends them after a restart; the only non-ack envelope kinds are `reply`/`system`,
  whose senders wait on nothing, and a reply to a blocked target is refused at the script before recording (c8a2589). The 30-min give-up marks the row
  `failed` with the reason; the question/Inbox card already asks the user to answer the dialog. No persistence.
- **D30 `hcKeys` pageup/pagedown/home/end (Q5): verified** (probe above). No change.
- **D31 `remoteName` and the remote branch of `agentName` (Q6): remove now (U6 fix).** Reason: §5 U6 deletes remote code; under hc every terminal has a
  name and `machines()` is the single `LOCAL_MACHINE`, so the branch is dead, and its tests carry herdr pane ids (`w5:p8`) and `'Herdr Box'` that fail the
  DoD grep. `agentName` keeps `a.name`, else a name-shaped title, else `<cwd slug>-<tN>`; tests use `tN`. The `machines()`/`m.local` stub itself stays
  (the disabled remote UI reads `/api/machines`); collapsing it is out of scope.
- **D32 `canonicalPane` (found in this pass): delete.** Under hc an address is its own canonical form, so `agentFor`'s fallback (server.mjs:2603) and the
  gate-grant clause (server.mjs:2823) are dead and the name fails the DoD grep. Exact id match only; drop its `parse.test.mjs` test.
- **Fix round F3 (one engineer, wt-dashboard + wt-shared hc.mjs):** D26, D27, D31, D32. Red proofs: free-text single-select answer on the fake hc → keys
  `[n+1]` then `send --force <text>` (409 before); a delivery to a blocked target never carries `--force`; `typeKeys('Ab;')` → `['shift+a','b',';']`
  (400 before). Commits: wt-shared (hc.mjs) and wt-dashboard separately; dashboard `npm test` and root `npm test` green.
- **Open user questions for gate B.**
  - **U-Q1 (D27) Terminals view direct typing.** Typing straight into a shell in the dashboard's Terminals view can no longer send `! @ # $ % ^ & * ( ) _ + { } | : " < > ? ~`
    or non-ASCII without Enter (letters incl. capitals, digits and the input line with Enter all work). (a) Accept: such text goes through the input line
    (Run); interactive programs needing those keys mid-line (vim, a `y/N` that wants `?`) are used from herdr-app. (b) Follow-up ticket: a raw input stream over
    hc's framed `terminal.attach`, which would also give the Terminals view colour (R5's alternative) — needs hc's frame format and a fix for the resize-on-attach.
  - **U-Q2 (D26, only if the multi-select live check fails)** A multi-select question's free-text "Other" cannot be answered from the dashboard: (a) accept,
    answer it in the terminal/herdr-app; (b) follow-up ticket with the same attach stream as U-Q1(b).
- **U7 brief additions.** (1) The DoD grep over code comments and test names too: 52 lines remain in `skills/wt-dashboard` after the exclusions
  (server.mjs 14, parse.test.mjs 13, the rest 1-2 per file), plus every other skill. (2) `docs/features.md`: Terminals direct typing limits (D27) and the
  free-text picker answer (D26 outcome), blocked-queue behaviour (D29: queued behind a dialog, given up after 30 min, a restart falls back to the sweep), no
  remote machines. (3) CLAUDE.md Traps: `hc keys` names keys (capitals only as `shift+<letter>`, no shifted punctuation); `--force` only on the user's answer
  route; the in-memory blocked queue. (4) QA brief step 2 gains D28's `--goal` checks and a free-text picker answer (single-select, and multi-select per D26)
  on the isolated core. (5) Doctor: `hc` version line (probe used 0.1.16; key names and `send --force` semantics are version-bound).
- **F3 landed** (25763e0 wt-shared, 153a525 wt-dashboard; dashboard 808/808 + web 109/109, root 491/491; link guard unchanged, default core untouched).
  D26 live: single-select Other = key `n+1` + forced send, submits. Multi-select: a forced paste+Enter commits the text but leaves Other unticked, so
  `answerPlan` multi = toggles, move to Other (no digit), `{text}` forced, `{ensure:text}` (re-read, one Enter if Other is not ticked with the text, 409
  before Submit if still not), `down enter`; `parsePicker` returns `otherChecked`. **U-Q2 is dropped**: multi-select Other works. D32 reached ~12 users of
  `canonicalPane`: exact id matches, and the pane-identity routes (`/api/deliveries`, `/api/messages`, `/api/watch-prs/event`, keepwarm, `roomAuthor`)
  now use `liveAgent` (a `tN` that hc lists as a local agent). That identity change gets a diff review (security lens) at 153a525 before U7.

## Tech-lead decisions at diff review (pinned b879918; fix rounds F4-F7)
Review: wt-review diff mode, 168 files / 6314+ 2753-, five per-lens agents (correctness+regression, standards, agent-native, testing+learnings,
security/data/scope/adversarial/reliability/performance), an independent validator for high/medium (7 confirmed, 1 refuted: `watchdog-probe.sh` is tested at
`parse.test.mjs` "watchdog probe"), then a delta review per fix round.
- **F4 (known items):** the forced picker send and the multi-select `ensure` Enter re-read the screen and need the same question, else 409 (2c1cd5b); every test
  that spawns `server.mjs` is pinned to `hcStub`/`noCore` and `nocore.guard.test.mjs` fails one that is not (45bfd4f, hardened per spawn in F6); records keyed
  by old pane ids go stale silently, listed in `docs/hc-cutover.md` (ce31307, f5d6472).
- **F5 (review findings):** exited rows are no identity (`liveAgent`, `/verify` senderRole); one `coreIsUp` gate over every server hc call (503); `done` rests like
  `idle` everywhere (`resting`/`isResting`); a core.id change keeps paused rows and session-carrying missing rows (addresses cleared; refines D14); `agents.sh
  rm|respawn` refuse a terminal that is not a pack agent (no override; refines D12's scope); the `hc-launch` denylist covers every pack `WT_*`/token name;
  `hc.mjs` CLI guard compares real paths (was fail-open: `core-up` exited 0); `handoff.sh` gates on `core-up` (headless targets exempt); `wt-deliver` holder =
  argv[0] `hc`/`herdr-core` + `hold` (D7 as written).
- **F6/F7 (delta findings):** gate reads hc after shell keywords, inside literal `sh -c`/`eval` strings, `hc run|exec` carried commands, quoted/escaped/absolute
  `hc`, a lone `&`; `HC_TERMINAL_ID=<value>` spoof and outer markers through `sh -c` are forged sends; new classes `hc-label` (role/persona/wt.pool only; `task`
  stays free for wt-finish) and `hc interrupt` (as keys); input bounded (32 KB, over-cap or nesting > 6 asks as `long-command`); the forced picker send also needs
  the cursor on Other (single and multi). handoff/agents messages never tell an agent to start the core.
- **Accepted, not fixed (follow-ups if they bite):** gate indirection (`$(…)`, pipe-to-shell, `$X kill`) stays unseen (gate is loose by design); a role label is
  writable by its own terminal outside the gate (pre-existing under herdr pane tokens; the gate now asks for `hc label role=`); a timed-out `terminal.run` may
  leave an orphan terminal; `hcList({all:true})` per 3 s tick grows with kept finished terminals; respawn of a kept persona agent comes back as its base role;
  the pane-key sweep at spawn can race a concurrent spawn; the handoff test's 20 ms `afterEach` yield is timing-based (the fake core accepts only between
  sync spawns).
- **R4 opt-in setup action: not added.** D5's untagged route (server `deliver()`, script `env -u HC_TERMINAL_ID hc send`) works without `notes = false`, so
  editing the user's `~/.config/herdr-core/config.toml` buys nothing and would also silence notes for the user's own hc use; doctor keeps reporting it (info).
  The user's consent stays recorded and unused.
- **QA addition (step 2):** capture a real Claude Code picker screen with the cursor on the Other/"Type something" row, single- and multi-select, on the
  isolated core, and confirm the free-text answer still submits (the F6/F7 cursor check is proven only on a hand-edited screen; no recorded capture exists, so
  a wrong cursor read would 409 every free-text answer). Keep the capture as a fixture under `skills/wt-dashboard/test-fixtures/` in a follow-up commit.
- **Open user question (docs):** `hc` has no public install URL or command known to the pack, so `docs/hc-cutover.md` step 2, the README and setup's hint say
  "install hc" without saying how. Answer = the install source (URL / brew tap / internal build) or "unpublished, say so"; it changes only those three texts.
