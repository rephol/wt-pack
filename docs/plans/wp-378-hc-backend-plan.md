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
| hc extras | `hc events` (follow changes), `hc keep`, `hc put`, templates, doc store in the API schema (`DocGet/DocSet`, not on the CLI) | `hc events` can replace the 3-4 s poll later; not v1. |

hc state in this environment: core live (v0.1.16), 0 live terminals, so no existing wt-pack agent is visible in hc: matches the ticket.

## 2. Scope
Add a backend switch so every herdr call in wt-pack goes through one adapter that speaks either `herdr` (today) or `hc`.
Default stays `herdr` until the user flips it; `WT_BACKEND=herdr|hc|auto` (auto: `HC_TERMINAL_ID` set -> hc, else `HERDR_PANE_ID`
set -> herdr, else whichever server answers: hc only if `herdr` is absent/not running). Both backends pass the same test suite.

Call-site inventory (verified by grep): `wt-agents/scripts/agents.sh` (spawn/list/rm/dnd/context, ~30 herdr calls),
`wt-handoff/scripts/handoff.sh` (74 refs), `wt-dashboard/server.mjs` (121 refs: `herdr()` / `herdrOn()` helpers, paneMeta
sync, agent list, deliver callbacks, pair/task token clear, terminals send-text/keys), `dispatch.mjs`, `headless.mjs`,
`watchdog.mjs`, `terminals.mjs`, `herdrd.mjs`, `agents-table.mjs`, `wt-room/mod/scripts/wt-deliver`, `wt-shared/scripts/{task-state.sh,
agent-pane.sh,pane-submit.mjs,wt-message-cli.mjs,wt-gate}`, `wt-ask`, `wt-room/scripts/room`, `wt-ticket`, `wt-mods/scripts/wt-keepwarm`,
`wt-mods/hooks/commands.ts`, `wt-memory/claude-plugin/hooks/inject.mjs`, `wt-memory/scripts/wt-memory`, `wt-watch-prs`, `setup`, Tauri `app/src-tauri/src/main.rs`.

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
  `interrupt`, `kill <id>`, `close <id>` (herdr: tab close; hc: kill + rm), `alive <id>`. Per CLAUDE.md "dynamic import per subcommand":
  each backend module is `import()`ed inside the verb that needs it.
- Token API is preserved: callers keep saying tokens; the hc backend writes labels. The 32-key/80-char/unknown-role rules live in the adapter.
- The dashboard imports `mux.mjs` and replaces its `herdr(...)`/`herdrOn()` helpers; it keeps `herdrOn` for remote (herdr only).
- Tests: a PATH-shim fake `hc` (and the existing fake `herdr`) for unit tests; the real `hc` only with its own `HC_SESSION` + scratch XDG
  dirs (per `hc --skill`), throwaway terminals named `wtt-*` in a temp repo, always killed/removed in teardown. Tests pin `HERDR_DASH_URL`
  to a closed port. Never `herdr server`, never the user's core.
- Spikes (inside U1, with a throwaway `claude` in a temp repo on an isolated `HC_SESSION`, recorded in the unit's commit message and
  in a `## Spike results` section appended to this plan by the engineer): S1 does claude report OSC 7501 status under `hc run`, and
  what `hc wait` returns; S2 `hc read` with ANSI/visible screen vs `agent read --ansi` for the picker parser; S3 holder process name
  for wt-deliver's tree walk; S4 `hc send` to a claude: paste handling for the WP-352 pointer line, and `first_message.sent` behaviour.
  If S1 fails (no status), U5 falls back to screen-read heuristics; this is reported, not guessed.

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
  from `hc ls`; no rename/tab repair under hc; pane-key file named by the terminal id; model/effort/role/project/team/persona as labels.
- Tests: extend `spawn-env`, `list`, `dnd`, `respawn` tests to run under both backends (shims); `mcp.test.mjs` green; old-herdr output byte-identical.

### U3 — handoff and pane helpers (skill: wt-handoff, wt-shared task-state/agent-pane/pane-submit/wt-message-cli)
Owner: wt-pack:wt-engineer
- `handoff.sh` delivery, queue-then-type, pointer typing (WP-352 `ptr()`, record once WP-360), `--buddy` pair label, `--session` spawn,
  `task-state.sh`, `agent-pane.sh`, `pane-submit.mjs`, `wt-message-cli.mjs` through the adapter.
- Tests: `handoff.test.mjs`, `jev-route.test.mjs`, `pane-submit.test.mjs` under both backends; pointer line byte-for-byte equal; the
  pack-message record-before-send order asserted on the hc path.

### U4 — identity and CLIs (skills: wt-room mod, wt-ask, wt-ticket, wt-mods, wt-memory, wt-watch-prs, wt-shared gate)
Owner: wt-pack:wt-engineer
- One helper `self` (HC_TERMINAL_ID, else HERDR_PANE_ID) replaces direct `HERDR_PANE_ID` reads in `wt-deliver` (incl. the WP-320
  tree walk from S3), `wt-gate`, `wt-ask`, `room`, `wt-ticket`, `wt-keepwarm`, `inject.mjs`, `wt-memory`, `commands.ts`, `watch-prs.sh`.
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
  `hc keys`), Dispatch spawn path, `headless.mjs`, `watchdog.mjs`, `recovery.mjs`, `herdrd.mjs` (hc: `hc server status` only unless Q4 yes),
  Tauri `main.rs` check.
- Tests: `dispatch.test`, `headless.test`, `watchdog.test`, `recovery.test`, `herdrd.test`, `envelope.routes`, `verify.routes` with hc shim.

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
- [ ] No direct `herdr ` call or `HERDR_PANE_ID` read remains outside the adapter, `herdrOn` remote path and the herdr backend (grep in the QA brief).
- [ ] Spawn, list, rm, dnd, handoff delivery (pointer typed byte-for-byte, recorded before send), wait, read and token set/clear work on hc.
- [ ] A spawned hc agent survives its spawner (`--outlive-parent`) and appears in the dashboard Agents list with role/project/model/effort.
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
