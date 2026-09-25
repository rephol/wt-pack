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

Manages the two agent pools — `<repo>-workers` and `<repo>-planners` — each a herdr workspace created
on demand.

```bash
~/.claude/skills/wt-agents/scripts/agents.sh list [role] [--json]    # name, pane, status, cwd (--json: + pane tokens)
~/.claude/skills/wt-agents/scripts/agents.sh spawn worker [cwd]      # starts in the worktree
~/.claude/skills/wt-agents/scripts/agents.sh spawn planner [cwd]     # starts in the MAIN checkout
~/.claude/skills/wt-agents/scripts/agents.sh spawn <role> [cwd]      # any other role: <repo>-<role>s workspace, main checkout by default
~/.claude/skills/wt-agents/scripts/agents.sh rm <name|pane> [--force]
```

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

