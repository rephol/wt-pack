# WP-378 — port wt-pack to herdr-app / hc (herdr-core), as a backend switch

Ticket: WP-378 (feature, L). Branch `wp-378-hc-backend`. Rules: CLAUDE.md (never start a second `herdr server`; throwaway
agents in a temp repo; never touch the user's real terminals; one commit per skill touched; update `docs/features.md`).

## 1. Answer to the ticket's open question (verified read-only against `hc --skill`, `herdr-app --skill`,
`~/.config/herdr-app/AGENTS.md`, `hc --help`, `hc schema`, plus one throwaway terminal `wtplan-probe`, killed and removed)

Does hc keep names, labels and tokens the way pane tokens work today? **Names and labels yes, tokens no (labels replace
them), and several herdr behaviours have no hc equivalent.**

| Today (herdr) | hc | Verdict / what the port must do |
|---|---|---|
| `herdr agent start <NAME>` / `agent rename` (names global, `[a-z0-9_-]` <=32) | `hc run --bg --name N` — same charset, 1-32, **unique among live terminals** (`name_taken` error, probed). **No rename command**; name is fixed at start | Names kept. The `agent rename` repair in agents.sh and the tab-label->agent-name drift fix (WP-222) are dropped under hc. `<repo>-<role>-NN` numbering still works (use `hc ls` names). |
| Pane tokens: `pane report-metadata --source wt-dashboard --token k=v`, `--clear-token`, in `pane list/get` `.tokens`; <=32 keys, <=80 chars (CLAUDE.md) | Labels: `--label k=v` at `hc run`, `hc label <t> k=v...` later, `key=` removes, shown as `.labels` in `hc get/ls --json`, filterable by `hc ls --label k=v` (repeatable, AND). Probed: 200-char value and 43 keys accepted, so the 32/80 limits are a pack contract, not hc's | **Same semantics as tokens**; map token -> label 1:1 (no `--source` namespace, so the pack prefixes nothing: collision risk with `herdr.*` keys only, which the pack never uses). Keep the pack's 32/80 limits in the adapter. |
| `task` / `handoff_*` never stored in the agents table (WP-348) | labels are core state of the terminal, readable by anyone with the socket | unchanged rule: the adapter keeps `task`/`handoff_*` as labels (they are the live pane's), the dashboard still must not copy them into the agents table. |
| Workspace per pool `<repo>-<role>s`, tabs, `tab create --env` | No workspaces/tabs in hc. Visibility is herdr-app's: a terminal appears only with labels `herdr.space=<id>` (+ optional `herdr.tab=<id>`); **unlabelled terminals are hidden workers** | Pool = label `wt.pool=<repo>-<role>s` (query via `hc ls --label`). Whether spawned agents should be shown in the app is an open question (Q1). |
| Identity `HERDR_PANE_ID` (maybe a stable id; `canonicalPane()`) | `HC_TERMINAL_ID` (`t7`, "this terminal forever on this core"; probed present in a child's env, with `HC_SCOPE`, `HC_TERMINAL_SOCKET`). Names and `machine/t7` also resolve | Stable already; no `canonicalPane` lookup needed. Keep the HTTP headers `x-herdr-pane` / `x-wt-pane-key` unchanged (they carry the terminal id) so the dashboard auth is untouched. |
| `agent prompt` / `pane send-text` / `agent send-keys` / `agent read` / `agent wait --until idle` | `hc send <t> <text>` (paste + enter, `--wait`), `hc keys`, `hc read --lines`, `hc wait <t>`, `hc interrupt` | Equivalent. `hc read` returns text; the `--ansi` read used by the picker parser needs a spike (Q-spike S2). |
| Agent state from the herdr claude integration (`herdr integration install claude`) | status `idle/working/done/blocked/error` from the program's OSC 7501 reports; plain programs have none | **Unknown whether `claude` emits 7501 under hc** (templates exist: `hc templates`). Spike S1 decides how dashboard state/idle detection works. |
| Parent/child: panes outlive the spawner | Children **end when the parent ends** unless `--outlive-parent` / `--no-parent`; parent gets typed `<hc ...>` notes unless `--no-notify` | Pack agents spawned by agents.sh/Dispatch must pass `--outlive-parent` (dashboard-spawned: `--no-parent`) and decide notes (Q3). |
| process-tree walk to a process called `herdr` (wt-deliver, WP-320) | the pane process tree is owned by an hc holder, name unknown | Spike S3 finds the ancestor comm to stop at. |
| `herdr server` auto-start (WP-218) | `hc server start|status`; core already runs (`hc server status` JSON) | Dashboard may call `hc server status` only; starting is gated by Q4. |
| `--machine <label>` remote | `--on <machine>`, address `machine/t7` | Out of scope for v1 (non-goal), see Q2. |
| Spawn env: `tab create --env` carries `GH_TOKEN`, `WT_PANE_KEY`, the kill-shim `PATH`/`WT_KILL_SHIM_DIR`, `CLAUDE_ENV_FILE`, `WT_MEMORY_MCP` (agents.sh:392-409) | `hc run` has **no `--env`** (`hc run --help`); a terminal starts a login shell environment, and through the API the core's (`--cwd` help text) | **Not equivalent (tech-lead review).** Env must reach the agent another way and never through argv (secrets would show in `ps` and possibly `hc get` argv). Spike S5 + the launcher in §4. |
| hc extras | `hc events` (follow changes), `hc keep`, `hc put`, templates, doc store in the API schema (`DocGet/DocSet`, not on the CLI) | `hc events` can replace the 3-4 s poll later; not v1. |

hc state in this environment: core live (v0.1.16), 0 live terminals, so no existing wt-pack agent is visible in hc: matches the ticket.

## 2. Scope
Add a backend switch so every herdr call in wt-pack goes through one adapter that speaks either `herdr` (today) or `hc`.
Default stays `herdr` until the user flips it; `WT_BACKEND=herdr|hc|auto` (auto: `HC_TERMINAL_ID` set -> hc, else `HERDR_PANE_ID`
set -> herdr, else whichever server answers: hc only if `herdr` is absent/not running). Both backends pass the same test suite.
`WT_BACKEND` selects the backend for a **single-agent caller** (a CLI inside a pane, a spawn). The dashboard is not a single-backend
caller: it lists every running backend (`list --all`) and routes each write to the backend that owns the id (see §4 "Ids and routing").

Call-site inventory (verified by grep): `wt-agents/scripts/agents.sh` (spawn/list/rm/dnd/context, ~30 herdr calls),
`wt-handoff/scripts/handoff.sh` (74 refs), `wt-dashboard/server.mjs` (121 refs: `herdr()` / `herdrOn()` helpers, paneMeta
sync, agent list, deliver callbacks, pair/task token clear, terminals send-text/keys), `dispatch.mjs`, `headless.mjs`,
`watchdog.mjs`, `terminals.mjs`, `herdrd.mjs`, `agents-table.mjs`, `wt-room/mod/scripts/wt-deliver`, `wt-shared/scripts/{task-state.sh,
agent-pane.sh,pane-submit.mjs,wt-message-cli.mjs,wt-gate}`, `wt-ask`, `wt-room/scripts/room`, `wt-ticket`, `wt-mods/scripts/wt-keepwarm`,
`wt-mods/hooks/commands.ts`, `wt-memory/claude-plugin/hooks/inject.mjs`, `wt-memory/scripts/wt-memory`, `wt-watch-prs`, `setup`, Tauri `app/src-tauri/src/main.rs`.
Added in tech-lead review (missed by the first grep): `wt-dashboard/promptOn.mjs` (the deliver paste path: `herdrOn` `pane read`/`send-text`/
`send-keys`, lines 13-24), `wt-dashboard/scripts/watchdog-probe.sh` (WP-218 `nohup herdr server`, lines 15-16), `wt-mods/hooks/guards.ts`
(`SENDS` regex line 5 matches `\bherdr\b`, so a `hc send` carrying the user-level skills dir path escapes the skills-path guard),
`wt-shared/mcp/wt-server.mjs` (identity comes from the inherited env, line 11: check it passes `HC_*` through).

## 3. Non-goals
- Removing herdr support, or changing the default backend (separate follow-up ticket after QA).
- Remote machines under hc (`--on`); herdr `--machine` keeps working as is.
- Using `hc events` instead of polling; hc templates; `hc keep`.
- Migrating live agents between backends (an agent lives where it was started; the dashboard lists both when both run).
- Changing dashboard auth/headers/pane-key scheme; changing token limits.
- Any layout/mod work in herdr-app itself.

## 4. Design
- **Adapter, one contract, two implementations.** `skills/wt-shared/scripts/mux.mjs` (node; CLI `mux.mjs <verb> --json`) and
  `skills/wt-shared/scripts/mux.sh` (thin bash wrapper that execs the node CLI, for the shell callers). Verbs and normalized JSON:
  `backend`, `self` (own terminal id), `list` -> `[{id,name,cwd,status,labels,pool,alive}]`, `get <id|name>`, `spawn {name,cwd,argv,labels,pool,model...}`
  -> `{id,name}`, `label <id> k=v... | --clear k`, `send <id> <text>`, `keys <id> ...`, `read <id> [--lines N]`, `wait <id> [--until idle]`,
  `interrupt`, `kill <id>`, `close <id>` (herdr: tab close; hc: kill + rm), `alive <id>`. Each backend module is `import()`ed inside the
  verb that needs it, so a machine with only one CLI never loads the other's code.
- **Ids and routing (tech-lead decision).** Options: (a) one backend per process everywhere; (b) backend-qualified ids `hc:t7`; (c) route
  by id shape. Choice: (c). herdr pane ids are `w<N>:p<N>` (test fixtures), hc ids are `t<N>`; the two shapes cannot collide, so ids,
  headers and pane-key file names stay unqualified and backward compatible, and `mux.backendOf(id)` picks the backend for a write. A
  remote id (`machine/t7`, contains `/`) is rejected by every local verb and never becomes a pane-key file name. `list --all` returns
  each row with `backend`; a backend that is down yields no rows plus an `errors[backend]` entry (DoD "degrades only its rows").
- **Names across backends.** The agents table is keyed by `name` (`agents-table.mjs:26`) and hc only enforces uniqueness among hc
  terminals, so `<repo>-<role>-NN` numbering takes the next free number over the union of both backends' live names (plus the
  dashboard's `/api/agents` local names, as agents.sh:331 does today). Two live agents with the same name on two backends is a
  test case for `list --all` (reported, not merged).
- **Spawn env under hc (tech-lead decision).** Options: (a) `env K=V claude` in argv — rejected, puts `GH_TOKEN`/`WT_PANE_KEY` in argv;
  (b) rely on the core's env — rejected, loses per-agent values and the kill-shim PATH (WP-120 second layer); (c) a launcher.
  Choice: (c) `skills/wt-agents/scripts/hc-launch <envfile> -- <argv>`: agents.sh writes the env to a mode-0600 file in a 0700 dir under
  `${XDG_RUNTIME_DIR:-$TMPDIR}`, the launcher sources it, deletes it, then `exec`s claude. Argv carries only the file path. The pane-key
  file is written after `hc run` returns the id; the agent's first dashboard call can precede it, so the launcher's first call must
  tolerate the existing grace window (until `WT_PANE_KEY_STRICT=1`). S5 confirms what env a `hc run` terminal actually receives.
- **Identity is env-only.** `self` = `HC_TERMINAL_ID`, else `HERDR_PANE_ID`, from the environment, never a subprocess: `inject.mjs` runs
  under the 2 s SessionStart budget (CLAUDE.md WP-204 trap) and `commands.ts` is a mod with no Node and only `$.env.get` (CLAUDE.md
  WP-206 trap), so it reads `HC_TERMINAL_ID` with `$.env.get` itself and cannot import the helper. Bash callers get `self` from
  `mux.sh` without starting node.
- **Cost of the shell wrapper.** `mux.sh` resolves `backend` and `self` in bash (env only); `auto`'s server probe runs once per process
  tree and is exported as `WT_BACKEND_RESOLVED`. Other verbs exec `mux.mjs`. U3 records `handoff.test.mjs` wall time before and after;
  a regression over 20% is a finding for review, and the remedy is a bash-native path for that verb, not a cache of terminal state.
- Token API is preserved: callers keep saying tokens; the hc backend writes labels. The 32-key/80-char/unknown-role rules live in the adapter.
- The dashboard imports `mux.mjs` and replaces its `herdr(...)`/`herdrOn()` helpers; it keeps `herdrOn` for remote (herdr only).
- Tests: a PATH-shim fake `hc` (and the existing fake `herdr`) for unit tests; the real `hc` only with its own `HC_SESSION` + scratch XDG
  dirs (per `hc --skill`), throwaway terminals named `wtt-*` in a temp repo, always killed/removed in teardown. Tests pin `HERDR_DASH_URL`
  to a closed port. Never `herdr server`, never the user's core.
- Spikes (inside U1, with a throwaway `claude` in a temp repo on an isolated `HC_SESSION`, recorded in the unit's commit message and
  in a `## Spike results` section appended to this plan by the engineer): S1 does claude report OSC 7501 status under `hc run`, and
  what `hc wait` returns; S2 `hc read` with ANSI/visible screen vs `agent read --ansi` for the picker parser; S3 holder process name
  for wt-deliver's tree walk; S4 `hc send` to a claude: paste handling for the WP-352 pointer line, and `first_message.sent` behaviour.
  S5 (added in review): which env a `hc run --bg` terminal receives (the caller's, the core's, a login shell's), whether `PATH`
  set by the launcher survives the claude's own shell rc (the kill shims must stay first, `wt-agents/bin/env.sh`), and whether
  `hc get/ls --json` exposes argv (it must never contain a secret either way).
  If S1 fails (no status), both U5 (dashboard state) and U3 fall back to screen-read heuristics: `handoff.sh:299` waits with
  `--until idle --until done` and `pane-submit.mjs` confirms submission, so `mux wait --until idle` must have a defined hc
  meaning before U3 starts. This is reported, not guessed.
- **Isolated test core.** The real-hc test and QA run under `HC_SESSION=wtt-<id>` with scratch `XDG_*`; teardown kills/removes only
  recorded terminal ids, then stops only that session's core (`HC_SESSION=wtt-<id> hc server stop`), and asserts the default
  session's `hc server status` and `hc ls` are unchanged (`hc --skill`: "Never `hc server stop` … the user's core").
- **Red proof.** Every new guard or fix lands with a test that was run failing first (output in the commit message or the unit's reply):
  at least the backend selection matrix, env-not-in-argv for hc spawn, union numbering, id routing, the `SENDS` guard on `hc send`, and
  the wt-deliver hc stand-down.
- **Shim fidelity.** The fake `hc` replays recorded real `hc … --json` output (recorded in U1 on the isolated core) for every verb the
  adapter calls, not only `ls`; a verb with no recording is not shimmed from memory.
- **Parallel units.** U2-U5 run in parallel on per-unit branches off the U1 commit, merged `--no-ff` into `wp-378-hc-backend` by the
  tech lead (one committer per worktree at a time). U3 and U4 both touch `wt-shared` files (disjoint ones); each commits only its paths.

## 5. Units
Order: U1 first; U2, U3, U4, U5 in parallel after U1; U6 after U5; U7 last. Every unit: `Owner: wt-pack:wt-engineer`.

### U1 — adapter + spikes (skill: wt-shared)
Owner: wt-pack:wt-engineer
- `mux.mjs`/`mux.sh`, backend selection, herdr backend (wraps current calls), hc backend, token<->label mapping, name rules
  (`[a-z0-9_-]` <=32), `--outlive-parent` default for spawn, spawn readiness via `first_message.sent`.
- Run spikes S1-S4, record results.
- Tests (`mux.test.mjs`): selection matrix (env combos, `WT_BACKEND` override); token set/clear/limits on both backends against shims;
  list normalization from recorded real `herdr agent list`/`pane list` and `hc ls --json` fixtures; name_taken; kill-then-rm; unknown backend error.
  One opt-in real-hc test (isolated `HC_SESSION`).
- Docs: `skills/wt-shared` README/SKILL note.

### U2 — agents (skill: wt-agents)
Owner: wt-pack:wt-engineer
- `agents.sh spawn|list|rm|dnd|context` and `skills/wt-agents/bin` shims, `mcp` through the adapter. Pool = label `wt.pool`; numbering
  over both backends' live names (§4); no rename/tab repair under hc; pane-key file named by the terminal id; model/effort/role/project/team/persona
  as labels; `scripts/hc-launch` carries the spawn env (§4), so `GH_TOKEN`/`WT_PANE_KEY` never appear in argv and the kill shims stay first on PATH.
- Tests: extend `spawn-env`, `list`, `dnd`, `respawn` tests to run under both backends (shims); `mcp.test.mjs` green; old-herdr output byte-identical;
  hc spawn: the recorded `hc run` argv contains no env value and the env file is gone after launch (red first); union numbering with a
  same-named herdr agent (red first).

### U3 — handoff and pane helpers (skill: wt-handoff, wt-shared task-state/agent-pane/pane-submit/wt-message-cli)
Owner: wt-pack:wt-engineer
- `handoff.sh` delivery, queue-then-type, pointer typing (WP-352 `ptr()`, record once WP-360), `--buddy` pair label, `--session` spawn,
  `task-state.sh`, `agent-pane.sh`, `pane-submit.mjs`, `wt-message-cli.mjs` through the adapter. Waits use `mux wait --until idle` with
  the hc meaning fixed by S1 (status, or the screen-read fallback).
- Tests: `handoff.test.mjs`, `jev-route.test.mjs`, `pane-submit.test.mjs` under both backends; pointer line byte-for-byte equal; the
  pack-message record-before-send order asserted on the hc path.

### U4 — identity and CLIs (skills: wt-room mod, wt-ask, wt-ticket, wt-mods, wt-memory, wt-watch-prs, wt-shared gate)
Owner: wt-pack:wt-engineer
- One helper `self` (HC_TERMINAL_ID, else HERDR_PANE_ID) replaces direct `HERDR_PANE_ID` reads in `wt-deliver` (incl. the WP-320
  tree walk from S3), `wt-gate`, `wt-ask`, `room`, `wt-ticket`, `wt-keepwarm`, `inject.mjs`, `wt-memory`, `commands.ts` (own `$.env.get`,
  no import, §4), `watch-prs.sh`, `wt-shared/mcp/wt-server.mjs` env pass-through. `wt-mods/hooks/guards.ts` `SENDS` also matches
  `\bhc\s+(send|keys|run)\b` (red first: a `hc send` carrying the user-level skills dir path is refused).
  Headers `x-herdr-pane` / `x-wt-pane-key` keep their names. Child-`claude` env stripping in tests also strips `HC_*`.
- One commit per skill touched (CLAUDE.md), so this unit yields several commits; sizing is one engineer because each is a mechanical swap.
- Tests: each skill's existing test with `HC_TERMINAL_ID` set and `HERDR_PANE_ID` unset, and the reverse; wt-deliver nested-claude stand-down
  test for hc; `paths.test.mjs` and `plugin-agents.test.mjs` green; `claude plugin test` via `skills/wt-mods/scripts/test`.

### U5 — dashboard read side (skill: wt-dashboard)
Owner: wt-pack:wt-engineer
- `server.mjs` `herdr()` helpers -> adapter; agent listing, `paneMeta` token sync (labels), `agents-table.mjs` reconcile, ghost detection
  (replace `pane process-info`/`claude agents --json` cross-check with hc state/pid), `/api/agents`, pair/task token clear on ticket move,
  both backends listed together when both are up, `SOURCES.herdr` banner text per backend.
- Tests: `agents.routes`, `agents-table`, `pins.routes`, `memory.routes`, `keepwarm.routes`, `pane-key.routes`, `gate.routes` under both
  backends with a shimmed CLI on PATH; `npm test` in the dashboard.

### U6 — dashboard write side and spawn (skill: wt-dashboard)
Owner: wt-pack:wt-engineer
- `deliver()` paste callbacks (`agent prompt` -> `send`), deliveries sweep and resend, terminals `send-text`/`keys` (`herdrKeys` map to
  `hc keys`), `promptOn.mjs` (gets an id-routed sender instead of `herdrOn` for local ids), Dispatch spawn path (through `hc-launch`, `--no-parent`),
  `headless.mjs`, `watchdog.mjs`, `scripts/watchdog-probe.sh` (starts `herdr server` only when the herdr backend is in use; never starts hc unless
  Q4 yes), `recovery.mjs`, `herdrd.mjs` (hc: `hc server status` only unless Q4 yes), Tauri `main.rs` check.
- Tests: `dispatch.test`, `headless.test`, `watchdog.test`, `recovery.test`, `herdrd.test`, `envelope.routes`, `verify.routes`, `promptOn.test` with hc shim.

### U7 — setup, doctor, docs (skills: setup script, wt-setup, docs)
Owner: wt-pack:wt-engineer
- `./setup doctor` reports both CLIs, the selected backend, `hc server status`, `herdr-app` presence, claude integration for hc if S1 requires.
  Installs nothing (existing rule).
- `docs/features.md`, SKILL.md prose of every touched skill (herdr -> "herdr or hc"), CLAUDE.md Traps entry for the learnings (labels vs
  tokens, `--outlive-parent`, no rename, names unique), a short migration note: how to flip `WT_BACKEND` and restart the dashboard once.
- Tests: `setup` doctor test; `npm test` at root green.

## 6. Definition of Done
- [ ] `WT_BACKEND=herdr` (and unset with herdr env): full `npm test` at root and dashboard `npm test` pass, behaviour unchanged.
- [ ] `WT_BACKEND=hc`: the same suites pass with the hc shim; the opt-in real-hc test passes on an isolated `HC_SESSION`.
- [ ] No direct `herdr ` call or `HERDR_PANE_ID` read remains outside the adapter, `herdrOn` remote path, the herdr backend and
  `watchdog-probe.sh`'s herdr-server start (grep in the QA brief; tests, comments, the `x-herdr-pane` header and `HERDR_DASH_URL` are excluded by name).
- [ ] Spawn, list, rm, dnd, handoff delivery (pointer typed byte-for-byte, recorded before send), wait, read and token set/clear work on hc.
- [ ] A spawned hc agent survives its spawner (`--outlive-parent`) and appears in the dashboard Agents list with role/project/model/effort.
- [ ] An hc-spawned agent has `WT_PANE_KEY`, `GH_TOKEN` (when configured) and the kill-shim PATH in its env, and none of them in any argv (`ps`, `hc get --json`).
- [ ] Each new guard or fix has a red proof (test run failing before the change).
- [ ] wt-deliver nested-claude stand-down works under hc.
- [ ] Dashboard lists herdr and hc agents together without duplicates; stopping one backend degrades only its rows.
- [ ] `./setup doctor` reports backend state; `docs/features.md` and touched SKILL.md files updated; CLAUDE.md trap added.
- [ ] One commit per skill touched, pushed to origin; no real herdr server started, no real terminal touched (QA checks `hc ls` before/after).

## 7. QA brief
A user (or the auditor) does, in a temp repo, on a throwaway isolated core (`HC_SESSION=wtqa-<id>`, scratch `XDG_*` dirs; the user's
own core is only read with `hc ls`):
1. `WT_BACKEND=hc agents.sh spawn worker` twice, `list --json`, `dnd on/off`, `rm`; confirm names `<repo>-worker-01/02`, labels, and
   that the terminal outlives the shell that spawned it.
2. `handoff.sh --task` a short prompt to the spawned agent; read its screen; confirm the typed line is the recorded pointer and the
   message row exists before delivery.
3. Start a dashboard against a PATH shim (hc only, user's herdr untouched), open Agents, send a room message to an agent.
4. Repeat 1-2 with `WT_BACKEND=herdr` through the existing fake-herdr tests only (no live herdr).
5. `./setup doctor` output in both states.
Evidence kept (nothing else): command transcripts with exit codes for steps 1, 2, 5; `hc ls --json` before and after (equal for
non-`wtt-`/`wtqa-` terminals); one `agent-browser` screenshot of the Agents list (session `<agent name>`); the test summaries
(`npm test` counts, root and dashboard); the `grep` for leftover direct herdr calls. Teardown: kill/rm recorded terminals by address only.

## 8. Open questions for the user (with what each answer changes)
- **Q1** Should hc-spawned agents be visible in herdr-app (label `herdr.space=<id>`, one space per pool/repo, tab per agent) or hidden
  workers? Visible: U2 creates/looks up an app space via `herdr-app do space.new` (needs herdr-app running; adds a dependency); hidden: no
  app dependency, agents only reachable via the dashboard and `hc attach`.
- **Q2** Do remote machines (`herdr --machine`, hc `--on`) need hc parity now? Yes: adds a unit to U5/U6 and a remote spike; no (planned default): remote stays herdr-only.
- **Q3** Keep hc's typed `<hc from=...>` parent notes on spawned agents, or pass `--no-notify` (planned default: `--no-notify`, since pack messages already go through `<wt-message>` and unverified `<hc>` text is another untrusted input form for the inject hook)? Keeping them changes U3/U4: a new envelope classifier must handle `<hc ...>` (CLAUDE.md: one classifier in `wt-message.mjs`).
- **Q4** May the dashboard start the hc core on boot (like WP-218 starts `herdr server`)? Yes: U6 adds `hc server start`; no (default): doctor only reports it.
- **Q5** When to flip the default backend to hc (after this merge, after N days of QA, or per machine via `WT_BACKEND` only)? Changes only U7's migration note and a follow-up ticket.

## 9. Plan review (tech lead, wt-review plan mode)
Verdict: Approve with fixes (applied above). Lenses: coherence, feasibility, standards, testing, learnings, security, data, scope,
agent-native, reliability, performance. Each finding was independently validated.
- high, confirmed: `hc run` has no `--env`; spawn env (secrets, pane key, kill-shim PATH) had no carrier -> launcher + S5 (§1 row, §4, U2, DoD).
- medium, confirmed: single-backend `auto` vs a dashboard listing both -> id-shape routing, `list --all` (§2, §4).
- medium, confirmed: name-keyed agents table vs per-backend name uniqueness -> union numbering (§4, U2).
- medium, confirmed: `self` must be env-only (2 s hook budget; mods have no Node) (§4, U4).
- medium, confirmed: inventory missed `promptOn.mjs`, `watchdog-probe.sh`, `guards.ts` `SENDS`, `wt-server.mjs` (§2, U4, U6, DoD grep).
- medium, confirmed: no red proof; the hc shim was recorded only for `ls` (§4 Red proof / Shim fidelity, DoD).
- medium, confirmed: an S1 failure also breaks U3's wait-until-idle (§4 spikes, U3).
- medium, unverifiable: node exec per `mux.sh` call -> bash-native `backend`/`self`, cached `auto`, measured in U3 (§4).
- low: isolated-core teardown, and parallel units on per-unit branches (§4).
Open questions Q1-Q5 stay open for the user.
