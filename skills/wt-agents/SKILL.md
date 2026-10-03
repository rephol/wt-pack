---
name: wt-agents
description: >
  Spawn, list and remove the named herdr agents this pack hands work to — planners, which start in
  the main checkout because their first job is to create a worktree, and workers, which start inside
  one. Keeps every agent named, which herdr does not do reliably on its own, so a pool stays
  addressable by name instead of only by pane id. Use when asked to spawn or add a planner or a
  worker, to remove or clean up one, or to see what the pools currently hold. Called by wt-plan's
  handoff; also useful invoked alone.
allowed-tools: Bash
---

# wt-agents

Paths to scripts and files are relative to this skill's base directory (announced when it loads), so they
work both from the `./setup` links and from a plugin install (WP-122).

Manages the two agent pools — `<repo>-workers` and `<repo>-planners` — each a herdr workspace created
on demand.

```bash
scripts/agents.sh list [role] [--json]    # name, pane, status, cwd, dnd (+until), pair
                                           # (--json: + raw pane tokens, plus dnd:{on,until} and pair)
scripts/agents.sh spawn worker [cwd] [--mcp figma,railway]  # starts in the worktree
scripts/agents.sh spawn planner [cwd]     # starts in the MAIN checkout
scripts/agents.sh spawn auditor           # PM+QA, read-only: <repo>-auditors, main checkout (wt-audit)
scripts/agents.sh spawn <persona> [cwd]   # WP-204: a name with .wt-pack/roles/<name>.md spawns in its BASE role's pool,
                                          # role=<base> persona=<name>, the file's model/effort/mcp as defaults
scripts/agents.sh spawn <role> [cwd]      # any other role: <repo>-<role>s workspace, main checkout by default;
                                          # an explicit cwd in another repo names the agent and pool after THAT repo (WP-199)
scripts/agents.sh dnd <name|pane>              # print current dnd state (on/off, until-when if it expires)
scripts/agents.sh dnd <name|pane> on [--for 2h]  # set dnd; --for writes an expiry, omitted never auto-clears
scripts/agents.sh dnd <name|pane> off          # clear dnd
scripts/agents.sh rm <name|pane> [--force]
scripts/agents.sh respawn <name|pane> [--force]  # same name/role/cwd/tokens, claude --resume, in a NEW tab
scripts/agents.sh respawn --stale [--force]      # every pool agent lacking the kill shim or plugin guard
```

## DND and pairing

Both are herdr pane tokens, both shown by `list`: **dnd** (do-not-disturb) and **pair** (a ticket id, set by
`wt-handoff`'s `--buddy`). `dnd on --for <Nh|Nm|Nd|Ns>` writes an expiry in the same format the dashboard's own
DND toggle uses, so either side's auto-off (a project's `dndAutoOffHours`) clears it; `dnd on` with no `--for`
never auto-clears. `dnd <name|pane>` with no on/off just reports the current state.

**A DND or paired agent is invisible to every free-agent pick** — `wt-handoff`'s `candidates()`, the
dashboard's idle-retirement sweep, and routine agent-picks all skip it, so it neither gets handed new work nor
gets reaped while idle. To target one anyway, address it explicitly with `--pane <id>` (`wt-handoff`'s
`--pane` flag): an explicit target bypasses the skip, with a warning if it is DND.

`respawn` exists because the pkill/pgrep/killall shims are pane env, set only when the tab is created, and
plugin hooks load only at session start (WP-120). A same-pane restart gets the guard but not the shims.
`--stale` skips `working` agents (unless `--force`) and the caller's own pane.

Run it from anywhere inside the repo; it resolves the main checkout itself, so a worktree works.

## Why the naming is a step of its own

`herdr agent start <NAME>` names only what it actually **starts**. When it instead DETECTS a claude
already running in the pane — the path a timeout-and-retry takes — it reports success and the name
never lands. Four of six workers in this pool were unnamed for exactly that reason, addressable only
through their tab label.

So the script always follows a start with an explicit `agent rename`, and backfills any unnamed agent
in the pool from its tab label on every call. `rm <name>` therefore works on agents that predate it.

**Do not read a `start` success as "it started."** It may mean "something was already there."

### There are two names, on two layers

`herdr agent rename` names the agent **to herdr**. The claude session's own display name is a separate
value, set once by `claude --name` at start and never updated afterwards — so a renamed agent keeps
whatever session name it was born with, and this pool held two (`taw-03`, `tw-05`) from a scheme that
had been abandoned. The herdr layer read correct while the session underneath did not.

`spawn` therefore passes the label through both: `herdr agent start <label> ... -- --name <label>`.
Verified in the worker's own transcript as `"agentName"`.

**A stale session name cannot be fixed in place.** It is fixed by replacing the agent — `rm` then
`spawn` — which costs the conversation, so it is worth doing only when the agent is free anyway.

## Spawning

A planner starts in the **main checkout**: its first job is to create a worktree, and it cannot do
that from inside one. A worker starts in the **worktree** it is being handed. Passing the wrong cwd
is not an error anything reports — the agent just comes up in the wrong place.

Names are global to herdr, not per workspace, so numbering is taken from existing agent names across
every pool and carries the repo: two repos both numbering from 1 collide with `agent_name_taken` and
the second agent never starts.

## Lean MCP

**Off by default.** On when the dashboard's Settings › Integrations switch "Lean MCP for new agents" is on
(`WT_AGENTS_MCP=lean` in `~/.config/wt-dashboard/env`); the env var `WT_AGENTS_MCP=full|lean` overrides it
(`../wt-shared/scripts/mcp-mode.sh` resolves it). Off, agents start with claude's full set plus any `--mcp` picks.
`agents.sh mcp-args <role> [cwd] [--mcp a,b]` prints the MCP args a spawn would use.
A project's own Agent MCP (dashboard Settings › Projects) sits between the env var and the env file.

## GitHub account per project

When the project has a GitHub account (dashboard Settings › Projects), `spawn` puts `GH_TOKEN` for it
(`gh auth token --user <acct>`) into the new pane's env via `herdr tab create --env`, and sets the checkout's
`credential.https://github.com.username`. It never runs `gh auth switch`. No token for the account: a warning,
and the agent spawns with gh's active account. The token is a snapshot: respawn after changing the account.

When on, `spawn` starts claude with `--strict-mcp-config` and one merged `--mcp-config`, built per agent in
`~/.cache/wt-agents/mcp-<name>.json` (removed by `rm`). Later sources win on a name clash:
1. **Role** `mcp/<role>.json`: worker = wt-memory; planner and auditor = wt-memory + context7 (remote HTTP).
2. **Repo**: the committed `.mcp.json` at the root of the agent's cwd, else the main checkout's.
3. **Task**: `--mcp a,b` picks from `mcp/catalog.json` (figma, context7, railway); an unknown name fails
   before any tab is made. claude.ai connectors (Linear, Supabase, Drive…) can't be passed this way, so
   they aren't in the catalog; a task that needs one needs `WT_AGENTS_MCP=full`.

Strict mode drops every other MCP server, including plugin-provided ones (context-mode, claude-mem) and
claude.ai connectors, so a spawned agent runs 1 MCP node process instead of 3-4. Plugins' hooks and skills
still load. A role without a file, or `WT_AGENTS_MCP=full`, starts with the full set as before (plus any
`--mcp` picks). figma's server is OAuth: a fresh agent may need `/mcp` to sign in once.

## Removing

`rm` closes the tab. It **refuses a `working` agent** unless given `--force` — a turn in flight dies
with it, and until the worker commits, its work exists only in that pane.

Check `list` first when the pool is unfamiliar. A `done` agent is finished and free; `idle` is
waiting; only `working` is in flight.

## Reuse before spawning

For a handoff, prefer reusing a free worker — `wt-plan`'s `handoff.sh --list` shows the ones sitting
in the main checkout, and a worker parked inside a worktree is work already in flight. Spawn when
there is none free, not by default: panes accumulate and nothing reaps them.

## Roles and tags

Any lowercase role name works (`reviewer`, `release`…): its pool is the `<repo>-<role>s` workspace
(`$WT_AGENTS_WORKSPACE` overrides the label) and its agents are `<repo>-<role>-NN`. Every spawned
agent gets herdr **pane tokens** under source `wt-dashboard`: `role`, `project`, `spawned_by`
(`$WT_AGENTS_SPAWNED_BY`, default `wt-agents`) and `created` (YYYY-MM-DD). Tokens are display-only
metadata: one merged map per pane (any source can overwrite a key), values cut at 80 characters,
and they live in the running herdr server — wt-dashboard keeps its own copy and re-applies them.

