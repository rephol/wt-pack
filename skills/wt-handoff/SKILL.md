---
name: wt-handoff
description: >
  Hand a prompt to a herdr agent — a free worker from the repo's pool, a named pane, or a freshly spawned
  one — as a /goal, and leave both ends aware of each other: the target pane is labelled with the task
  (shown in wt-dashboard) and told who sent it and how to reply; the sender is told where it went. Use
  when handing off a plan or any work prompt to another agent instead of the clipboard. Called by
  wt-plan's handoff step; also useful invoked alone.
allowed-tools: Bash
---

# wt-handoff

Paths to scripts and files are relative to this skill's base directory (announced when it loads), so they
work both from the `./setup` links and from a plugin install (WP-122).

```bash
scripts/handoff.sh --list <cwd>     # free workers: pane-id, tab label, cwd
printf '%s\n' "$PROMPT" | scripts/handoff.sh \
  [--pane <id> [--clear] | --new] [--no-goal] [--task "ENG-1192 Tailwind v4 for @acme/ui"] [--mcp figma] [--kind k] [--from name] [--dry-run] <cwd>
scripts/handoff.sh --reply <pane> "text"   # answer a wt-message (or text on stdin)
scripts/handoff.sh --ack <id> [--answered]   # WP-257: acknowledge a wt-message by its id (the id in its tag)
scripts/handoff.sh --cancel <pane|name> ["why"]   # stop a /goal-driven agent for real
```

- **Every prompt is wrapped** (WP-104) as `<wt-message id=<nonce> kind=handoff|dispatch|routine|reply|system
  from="<sender>" [ticket=<ID>]>…</wt-message>` — the sibling of rooms' `<room-message>` — so the target knows it
  is wt-pack traffic, not its user. `--kind` (default `handoff`) and `--from` (default: your agent name) are for
  server callers (Dispatch passes `--kind dispatch --from wt-dashboard`). The wrap counts toward the 4000 cap.
- **`--reply <pane> "text"`** answers whoever sent you a wt-message: a plain `kind=reply` prompt, no `/goal`,
  no tokens, no worker selection. Raw `herdr agent prompt` still works but arrives untagged — describe it only
  as the fallback when `handoff.sh` is unavailable.
- **`--cancel <pane|name> ["why"]`** actually stops a `/goal`-driven agent (WP-132): a goal keeps an agent
  working toward its condition no matter what's typed at it — a plain "stop" is not enough (the WP-131
  incident: two agents told to stop kept going). It sends Escape to interrupt whatever the agent is
  mid-doing, then `/goal clear`, waiting for the agent to go idle/done as verification; if that doesn't
  happen (still working/blocked after Escape, or the goal won't let go) it falls back to a plain `/clear`.
  Either way it then clears the pane's `task`/`ticket` tokens, and — if the local board ticket in `tokens.ticket`
  is still assigned to that pane — unassigns it and moves it back to `ready` with a note (`cancelled: <why>`).
  Prints one line: `cancelled <name> (<pane>): <goal cleared|goal clear unverified, sent /clear>[, cleared
  task="…"][, returned <ID> to ready]`. Dispatch and reconcile use it when they withdraw a hand-off.

- No `--pane`/`--new`: the first free worker in `<repo>-workers` that sits in the main checkout; else spawns
  one through `wt-agents`. `--clear` sends `/clear` first. `--no-goal` sends a plain prompt instead of `/goal`
  (why a goal, and its one-line / 4000-character rules: `../wt-plan/references/handoff.md`).
- **Output:** line 1 is `reused <pane>` or `created <name> <pane>` (callers parse it); then
  `target <name> <pane> — <task>` and `reach: scripts/handoff.sh --reply <pane> "..."`. Non-zero exit = nothing was
  sent; print the prompt for a human instead.

## Task label and awareness

- `--mcp a,b` adds MCP servers from `../wt-agents/mcp/catalog.json` when the handoff SPAWNS a worker (see
  wt-agents "Lean MCP"). A reused worker keeps the set it started with, so pair it with `--new` when the
  task needs a server the pool's workers lack.
- Jev's picks only run in lean MCP mode (dashboard Settings switch, or `WT_AGENTS_MCP=lean`); in the default
  full mode every worker already has every server, so Jev is not called.
- Without `--mcp` (and without `--pane`), **Jev picks the servers** from the prompt: `scripts/jev-mcp.mjs` asks
  TypeSafe one yes/no (Noul) question per catalog server and keeps those at ≥ 0.7 (`WT_HANDOFF_JEV_MIN`),
  ~0.4s, 2s timeout; no key, timeout or any error means no picks, so a handoff never blocks on it. A free
  worker is reused only if it already has every pick (full-set workers have them all); otherwise a new one
  is spawned with `--mcp <picks>`. The key is `$TYPESAFE_API_KEY` or the Keychain entry wt-dashboard keeps
  (service `wt-dashboard`, account `TYPESAFE_API_KEY`); it is never printed. `WT_HANDOFF_JEV=off` skips it.
- **Routing** (auto mode only): with `WT_JEV_ROUTE` on (default; dashboard Settings › Integrations, or env),
  `scripts/jev-route.mjs` asks Jev whether the prompt needs a plan before any code (≥ 0.75, `WT_JEV_ROUTE_MIN`).
  Yes → the target is a **planner** from `<repo>-planners` (a free one reused, else spawned in the main checkout)
  and `route: planner (p=…)` is printed after the target lines. A prompt starting `Use wt-work` (wt-plan's own
  handoff) is never re-routed; Jev failing means a worker, as before. `--role worker|planner` forces the role —
  a caller that must get a worker (e.g. an orchestrator handing a clear task) passes `--role worker`.
  `--persona <name>` (WP-204) restricts reuse to agents tagged `persona=<name>` (else it spawns that persona);
  without it, persona agents are never picked.
- `--dry-run` prints what would happen (reuse which worker, or spawn with which `--mcp`) and Jev's
  probabilities, and sends, tags and spawns nothing.
- `--task` labels the target: herdr pane token `task` (source `wt-dashboard`), shown in the dashboard's agent
  list, detail header and switcher. It always **starts with the ticket**; without `--task` the label is just
  the ticket from `<cwd>`'s branch (`ENG-NNN` for a Linear team key, or `<KEY>-N` for a local board key from `wt-ticket keys`), and with
  neither nothing is set. Cut to 80 characters.
- A local board ticket (`WP-12`) handed to a worker moves to **building** and is assigned to the worker
  (`wt-ticket move` + `assign`, best effort; `--dry-run` prints `ticket=` and the move instead).
- Target tokens: `task`, `ticket`, `handoff_from`, `handoff_from_pane`, `handoff_at`. Sender tokens (only
  inside herdr, from `$HERDR_PANE_ID`): `handoff_to`, `handoff_to_pane`.
- The prompt gets a footer: `Handed off by <sender> (pane <id>). To reply: <absolute path of this handoff.sh> --reply <id> "..."`
  (resolved at send time, so it works from the `./setup` links and from a plugin install).
- `handoff_at` is what lets the dashboard adopt the new `ticket` over its own mirrored copy
  (`data/agent-tags.json`); `task` and `handoff_*` are never mirrored, so they vanish on a herdr restart.
- `wt-finish` clears `task` when the work is retired.

## Knowing when a handoff is done

- The target's `handoff.sh --reply` is the mid-task signal. SendMessage's `notify_when_idle` reaches the sender only after
  the sender's own turn ends (WP-259): a hint, never the completion signal.
- A target that acknowledges and then goes idle or exits without moving the card or replying is flagged by the dashboard
  (WP-261): the message becomes `expired`, and an Inbox item says it finished without reporting.
