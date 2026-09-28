# WP-125 — `wt-agents respawn`: restart live agents onto the pkill guard and PATH shims

## Goal

Every herdr pool agent started before WP-120 runs without the `pkill`/`pgrep`/`killall` PATH shims, and every
claude session started before the current wt-memory install runs without its plugin kill guard. Today the only
fix is closing each tab and spawning by hand, which loses the agent's name, session and tokens. Add
`wt-agents respawn <name|pane>` (one agent) and `wt-agents respawn --stale` (every pool agent that lacks either
layer, one step), each keeping the agent's name, role, cwd, pane tokens and Claude session (`--resume`).

## What research corrected

- **"Resume" in the dashboard cannot be reused as-is.** The watchdog's Resume restarts claude *in the same pane*:
  `skills/wt-dashboard/watchdog.mjs:193` — `['agent', 'start', r.name, '--kind', 'claude', '--pane', pane, '--', '--resume', r.session, ...]`.
  The shims are pane **environment**, set only when the tab is created:
  `skills/wt-agents/scripts/agents.sh:194` — `set -- "$@" --env "PATH=$shim:$PATH" --env "WT_KILL_SHIM_DIR=$shim" --env "CLAUDE_ENV_FILE=$envf"`,
  passed to `herdr tab create` at `:197`. A same-pane restart therefore picks up the plugin guard but **not** the
  shims. Respawn must create a new tab.
- **The session id is available for live agents without the watchdog.** `herdr agent list` rows carry
  `agent_session: {"kind":"id","source":"herdr:claude","value":"<uuid>"}` (observed live, 2026-09-28).
- **herdr names are global** (`agents.sh:115-117` — "two repos numbering from 1 collide … with agent_name_taken"),
  so the old tab must be closed before the new agent is started under the same name.
- The two doctor lines the ticket quotes are real: `setup:153` (sessions predating the guard, via plugin
  `installPath` birth time vs `ps lstart`) and `setup:171` (sessions whose `ps eww` env lacks
  `WT_KILL_SHIM_DIR=*wt-agents/bin*`). Both only *tell* the user to restart.

## Approach

`settled:` (no synchronous user; assumption recorded) **CLI in wt-agents, no dashboard button in this ticket.**
The ticket offered "respawn command or a dashboard action on the stale-hooks finding". The CLI is the root: a
dashboard action would have to call it anyway (as Resume calls `agents.sh mcp-file`). Dashboard action deferred.

Shape, all in `skills/wt-agents/scripts/agents.sh`:

1. **spawn gains two internal options**, `--label <name>` (use this name instead of numbering) and
   `--resume <session-id>` (append `--resume <id>` to the claude args). Both are optional; plain `spawn` is
   unchanged (CLAUDE.md: keep every CLI backward compatible).
2. **`respawn <name|pane> [--force]`**: resolve the agent row (`herdr agent list`, same jq match as `rm` at
   `:227-228`), read `name`, `cwd`, `agent_session.value`, pane `tokens` (including `role`). Refuse a `working`
   agent unless `--force` (same rule and message shape as `rm`, `:233-235`). Refuse a row with no name, no
   `role` token, or no session id (nothing to resume into). Then: `rm` the old tab, run the spawn path with
   `--label <name> --resume <session>` in `<cwd>` for `<role>`, and re-apply the old pane's non-spawn tokens
   (e.g. `task`, `task_state`, `ticket`) onto the new pane with `herdr pane report-metadata --source wt-dashboard`.
   Prints `<name> <new-pane>` like spawn.
   Implementation hint: re-invoke `"$0" spawn …` rather than duplicating the spawn block.
3. **`respawn --stale [--force]`**: over every pool agent of this repo (roles found in the pool workspaces, as
   `list` does, not only worker/planner), select those that lack the shim (claude process env has no
   `WT_KILL_SHIM_DIR=`) **or** started before the installed wt-memory plugin (same test as `setup:146-152`).
   Find each claude pid with `ps -axo pid=,command=` matching `--name <name>` — **never `pgrep`/`pkill`** (the
   shims and the WP-109 trap). Respawn each; skip `working` ones without `--force` and report them. Prints one
   line per agent: respawned / skipped (why). Nothing stale → "no stale agents".
4. `setup doctor` lines at `setup:153` and `:171` name the fix: `— wt-agents respawn --stale`.

Alternatives rejected: same-pane restart (no shims, see above); `herdr pane` env mutation (herdr has no such
command `[unsourced]`, and a running claude would not see it anyway).

## Implementation units

**U1 — spawn `--label` / `--resume`, `respawn <name|pane>`** (`skills/wt-agents/scripts/agents.sh`,
`skills/wt-agents/scripts/spawn-env.test.mjs` or a new `respawn.test.mjs`, `skills/wt-agents/SKILL.md`).
Verify: test with a stubbed `herdr` on PATH (the pattern `spawn-env.test.mjs` already uses) asserting the
`agent start` argv contains `--resume <id> --name <label>`, the tab create carries the shim `--env`s, the old tab
is closed before the start, and `working` is refused without `--force`.

**U2 — `respawn --stale`** (same files). Verify: stubbed test where one agent's fake process env has the shim and
one does not; only the second is respawned.

**U3 — doctor wording + docs** (`setup`, `docs/features.md` wt-agents CLI line at `:164`). Verify: `./setup doctor`
runs clean of syntax errors; grep shows the new hint.

## Files

- `skills/wt-agents/scripts/agents.sh`
- `skills/wt-agents/scripts/respawn.test.mjs` (new) — or extended `spawn-env.test.mjs`
- `skills/wt-agents/SKILL.md`
- `setup`
- `docs/features.md`

## Verification

- `node --test skills/wt-agents/scripts/*.test.mjs` passes.
- `sh -n skills/wt-agents/scripts/agents.sh`.
- Live smoke on a **throwaway** agent only (CLAUDE.md: never prompt the user's real agents for tests):
  `agents.sh spawn worker <tmp repo>`, give it one prompt so a transcript exists, `agents.sh respawn <name>`;
  confirm same name, new pane, `ps eww` of its claude shows `WT_KILL_SHIM_DIR`, and the conversation resumed.
  Then `agents.sh rm <name>`.
- `./setup doctor` still runs.

## Definition of Done

- `agents.sh respawn <name|pane>` exists, keeps name/role/cwd/session/tokens, refuses `working` without `--force`.
- `agents.sh respawn --stale` respawns exactly the agents lacking shim or guard, skipping `working` ones.
- Plain `spawn` behaviour unchanged (existing tests pass).
- Checkable from the transcript: `node --test skills/wt-agents/scripts/*.test.mjs` output shows the respawn
  tests passing; the throwaway smoke prints `<name> <new-pane>` and a `ps eww` line containing `WT_KILL_SHIM_DIR`.
- Doctor lines point at `respawn --stale`; `docs/features.md` and the wt-agents SKILL list the command.
- Committed one commit per skill touched (wt-agents; setup+docs separately), merged to main and pushed.

## Risks and deferred

- **Resume of a session with no transcript** (never took a prompt) fails in claude; the dashboard checks this
  with `findTranscript` (`server.mjs`, resumeExited). Respawn should fall back to a fresh start (no `--resume`)
  and say so, rather than leave the pane dead.
- The respawning agent itself (e.g. an orchestrator running `--stale`) would close its own tab mid-command:
  `--stale` must skip the caller's own pane (`HERDR_PANE_ID`, canonicalised — CLAUDE.md trap).
- Closing the tab kills any in-flight turn; that is why `working` needs `--force`.
- Deferred: a dashboard "Respawn" button on the `stale-hooks` watchdog finding (would call this command).
