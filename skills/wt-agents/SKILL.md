---
name: wt-agents
description: >
  Spawn, list and remove the named hc (herdr-core) agents this pack hands work to — planners, which start in
  the main checkout because their first job is to create a worktree, and workers, which start inside
  one. Keeps every agent named at its start (hc cannot rename), so a pool stays
  addressable by name instead of only by terminal id. Use when asked to spawn or add a planner or a
  worker, to remove or clean up one, or to see what the pools currently hold. Called by wt-plan's
  handoff; also useful invoked alone.
allowed-tools: Bash
---

# wt-agents

Paths to scripts and files are relative to this skill's base directory (announced when it loads), so they
work both from the `./setup` links and from a plugin install (WP-122).

Manages the two agent pools — `<repo>-workers` and `<repo>-planners` — each the hc label
`wt.pool=<repo>-<role>s` (plus one herdr-app space of that name, so the window shows them). Needs the hc core running:
every subcommand except `mcp-args`/`mcp-file` refuses with "hc core is down" instead of starting it.

```bash
scripts/agents.sh list [role] [--json]    # name, terminal id, status, cwd, dnd (+until), pair
                                           # (--json: + raw labels as tokens, plus dnd:{on,until}, pair, claude session + pid)
scripts/agents.sh spawn worker [cwd] [--mcp figma,railway]  # starts in the worktree
scripts/agents.sh spawn planner [cwd]     # starts in the MAIN checkout
scripts/agents.sh spawn lead [cwd] --agent wt-pack:wt-lead  # WP-368: per-ticket coordinator, role=lead, <repo>-leads; --agent starts claude as that agent definition
scripts/agents.sh spawn auditor           # PM+QA, read-only: <repo>-auditors, main checkout (wt-audit)
scripts/agents.sh spawn <persona> [cwd]   # WP-204: a name with a role file (<repo>/.wt-pack/roles/ or ~/.config/wt-pack/projects/<repo>/roles/, `wt-roles where`) spawns in its BASE role's pool,
                                          # role=<base> persona=<name>, the file's model/effort/mcp as defaults
scripts/agents.sh spawn <role> [cwd]      # any other role: <repo>-<role>s workspace, main checkout by default;
                                          # an explicit cwd in another repo names the agent and pool after THAT repo (WP-199)
scripts/agents.sh dnd <name|pane>              # print current dnd state (on/off, until-when if it expires)
scripts/agents.sh dnd <name|pane> on [--for 2h]  # set dnd; --for writes an expiry, omitted never auto-clears
scripts/agents.sh dnd <name|pane> off          # clear dnd
scripts/agents.sh rm <name|pane> [--force]
scripts/agents.sh respawn <name|pane> [--force]  # same name/role/cwd/tokens, claude --resume, in a NEW tab
scripts/agents.sh respawn --stale [--force]      # every pool agent lacking the kill shim or plugin guard
scripts/agents.sh spawn --headless <role> [cwd] [--prompt t] [--model m] [--effort e] [--name n]  # WP-293: a wt-dashboard headless run, no pane; prints "<name> <id> <state>"
scripts/agents.sh list --headless   # the dashboard's headless runs: "<name> <id> <state> <cwd> <role>" (idle = free to reuse, working = busy)
scripts/agents.sh send --headless <name|id> '<text>'   # WP-317: the run's next user message; a live run beats an ended one of the same name
scripts/agents.sh spawn --headless <role> [cwd] --reuse --prompt t   # an idle run of the same role + cwd takes the prompt: "<name> <id> idle reused"
scripts/agents.sh rm|stop --headless <id>   # stop one: allowed for the pane that spawned it (headless_runs.spawner) and for an orchestrator pane; any other pane gets 403 (answers/resume stay the user's)
```

## DND and pairing

Both are hc labels, both shown by `list`: **dnd** (do-not-disturb) and **pair** (a ticket id, set by
`wt-handoff`'s `--buddy`). `dnd on --for <Nh|Nm|Nd|Ns>` writes an expiry in the same format the dashboard's own
DND toggle uses, so either side's auto-off (a project's `dndAutoOffHours`) clears it; `dnd on` with no `--for`
never auto-clears. `dnd <name|id>` with no on/off just reports the current state.

**A DND or paired agent is invisible to every free-agent pick** — `wt-handoff`'s `candidates()`, the
dashboard's idle-retirement sweep, and routine agent-picks all skip it, so it neither gets handed new work nor
gets reaped while idle. To target one anyway, address it explicitly with `--pane <id>` (`wt-handoff`'s
`--pane` flag): an explicit target bypasses the skip, with a warning if it is DND.

`respawn` exists because the pkill/pgrep/killall shims and the launcher are the terminal's env/program, fixed when it
starts, and plugin hooks load only at session start (WP-120). hc cannot start a program into an existing terminal, so
respawn ends the old terminal and starts a new one under the same name. `--stale` skips `working` agents (unless
`--force`) and the caller's own terminal. A terminal hc recovered after a crash (keep) is a login shell with no labels:
the dashboard's agents-table row (role, cwd, session) is the identity, and nothing is ever typed into that shell.

Run it from anywhere inside the repo; it resolves the main checkout itself, so a worktree works.

## Names

`hc run --name` fixes the name at the start (1-32 of `a-z0-9_-`, unique among **live** terminals) and hc has no rename,
so the old rename/backfill repair is gone. `spawn` passes the same name to `claude --name <label>`, so the session itself
carries it too (verified in the transcript as `"agentName"`). **A stale session name cannot be fixed in place**: replace
the agent (`rm` then `spawn`), which costs the conversation.

## Spawning

A planner starts in the **main checkout**: its first job is to create a worktree, and it cannot do
that from inside one. A worker starts in the **worktree** it is being handed. Passing the wrong cwd
is not an error anything reports — the agent just comes up in the wrong place.

Names are global to the core, not per pool, so numbering takes the lowest free `<repo>-<role>-NN` over every name hc still
knows (live and finished) plus the dashboard's agents table, and carries the repo. A lost race (`name_taken`) takes the
next number, three tries. The repo part is cut so the whole name fits 32 characters.

## How the agent starts (hc-launch)

One `terminal.run` call (via `../wt-shared/scripts/hc.mjs spawn`) with `outlive_parent` and `no_notify`, all labels set
before claude exists (wt-memory's SessionStart reads `role`), and the program `scripts/hc-launch -- claude …`. A terminal
started this way gets the **core's** environment, not the spawner's and not a login shell, so the pack's values (`GH_TOKEN`,
`WT_PANE_KEY`, `WT_KILL_SHIM_DIR`, `CLAUDE_ENV_FILE`, `WT_MEMORY_MCP`, `WT_ROLE`/`WT_PERSONA`/`WT_PROJECT`, and any isolation
variable the caller set) travel in the request body — never argv, never a file — and `WT_LAUNCH_KEYS` names them. The launcher
scrubs what the core may have inherited from another agent (`GH_TOKEN`, `WT_PANE_KEY`, `WT_HEADLESS_*`, `HERDR_*` …), writes
`pane-keys/$HC_TERMINAL_ID`, runs `$SHELL -l -i -c` so claude sees the user's rc (NVM, JAVA_HOME …), then puts the pack values
back over whatever the rc set and re-prepends the kill-shim dir to `PATH`. It never scrubs `HC_SESSION`.

herdr-app shows a terminal only with `herdr.space=<id>`: spawn looks the pool's space up by name in `herdr-app ls` (lowest id if
two) or makes it under a per-pool lock, then closes the plain shell the new space opened. If herdr-app is missing or fails, the
agent runs hidden (no `herdr.space`/`herdr.tab` label), a warning is printed and the spawn still succeeds. Adopting a terminal enables hc's
*keep*, so a dead agent can become a login shell.

## Lean MCP

**Off by default.** On when the dashboard's Settings › Integrations switch "Lean MCP for new agents" is on
(`WT_AGENTS_MCP=lean` in `~/.config/wt-dashboard/env`); the env var `WT_AGENTS_MCP=full|lean` overrides it
(`../wt-shared/scripts/mcp-mode.sh` resolves it). Off, agents start with claude's full set plus any `--mcp` picks.
`agents.sh mcp-args <role> [cwd] [--mcp a,b]` prints the MCP args a spawn would use.
A project's own Agent MCP (dashboard Settings › Projects) sits between the env var and the env file.

## GitHub account per project

When the project has a GitHub account (dashboard Settings › Projects), `spawn` puts `GH_TOKEN` for it
(`gh auth token --user <acct>`) into the new terminal's env (the `terminal.run` body), and sets the checkout's
`credential.https://github.com.username`. It never runs `gh auth switch`. No token for the account: a warning,
and the agent spawns with gh's active account. The token is a snapshot: respawn after changing the account.

When on, `spawn` starts claude with `--strict-mcp-config` and one merged `--mcp-config`, built per agent in
`~/.cache/wt-agents/mcp-<name>.json` (removed by `rm`). Later sources win on a name clash:
1. **Role** `mcp/<role>.json`: worker = wt-memory; planner and auditor = wt-memory + context7 (remote HTTP).
2. **Repo**: the committed `.mcp.json` at the root of the agent's cwd, else the main checkout's.
3. **Task**: `--mcp a,b` picks from `mcp/catalog.json` (figma, context7, railway); an unknown name fails
   before any terminal is made. claude.ai connectors (Linear, Supabase, Drive…) can't be passed this way, so
   they aren't in the catalog; a task that needs one needs `WT_AGENTS_MCP=full`.

Strict mode drops every other MCP server, including plugin-provided ones (context-mode, claude-mem) and
claude.ai connectors, so a spawned agent runs 1 MCP node process instead of 3-4. Plugins' hooks and skills
still load. A role without a file, or `WT_AGENTS_MCP=full`, starts with the full set as before (plus any
`--mcp` picks). figma's server is OAuth: a fresh agent may need `/mcp` to sign in once.

## Removing

`rm` ends the terminal (`hc kill`, then `hc rm`) and forgets its record. It **refuses a `working` agent** unless given `--force` — a turn in flight dies
with it, and until the worker commits, its work exists only in that terminal.

Check `list` first when the pool is unfamiliar. A `done` agent is finished and free; `idle` is
waiting; only `working` is in flight.

## Reuse before spawning

For a handoff, prefer reusing a free worker — `wt-plan`'s `handoff.sh --list` shows the ones sitting
in the main checkout, and a worker parked inside a worktree is work already in flight. Spawn when
there is none free, not by default: panes accumulate and nothing reaps them.

## Roles and tags

Any lowercase role name works (`reviewer`, `release`…): its pool is the `<repo>-<role>s` pool
(`$WT_AGENTS_WORKSPACE` overrides it) and its agents are `<repo>-<role>-NN`. Every spawned
agent gets hc **labels**: `wt.pool`, `role`, `project`, `spawned_by`
(`$WT_AGENTS_SPAWNED_BY`, default `wt-agents`), `created` (YYYY-MM-DD), `model`/`effort` and, when set, `persona`/`team`/`herdr.space`. Labels are display-only
metadata: at most 32 per terminal, values cut at 80 characters (hc itself enforces neither; the adapter does), and they live in the core. A
terminal that hc recovers via *keep* loses them.
