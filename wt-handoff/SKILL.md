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

```bash
~/.claude/skills/wt-handoff/scripts/handoff.sh --list <cwd>     # free workers: pane-id, tab label, cwd
printf '%s\n' "$PROMPT" | ~/.claude/skills/wt-handoff/scripts/handoff.sh \
  [--pane <id> [--clear] | --new] [--no-goal] [--task "UMK-1192 Tailwind v4 for @umkmall/ui"] <cwd>
```

- No `--pane`/`--new`: the first free worker in `<repo>-workers` that sits in the main checkout; else spawns
  one through `wt-agents`. `--clear` sends `/clear` first. `--no-goal` sends a plain prompt instead of `/goal`
  (why a goal, and its one-line / 4000-character rules: `wt-plan/references/handoff.md`).
- **Output:** line 1 is `reused <pane>` or `created <name> <pane>` (callers parse it); then
  `target <name> <pane> — <task>` and `reach: herdr agent prompt <pane> "..."`. Non-zero exit = nothing was
  sent; print the prompt for a human instead.

## Task label and awareness

- `--task` labels the target: herdr pane token `task` (source `wt-dashboard`), shown in the dashboard's agent
  list, detail header and switcher. It always **starts with the ticket**; without `--task` the label is just
  the ticket from `<cwd>`'s branch (`UMK-NNN`), and with neither nothing is set. Cut to 80 characters.
- Target tokens: `task`, `ticket`, `handoff_from`, `handoff_from_pane`, `handoff_at`. Sender tokens (only
  inside herdr, from `$HERDR_PANE_ID`): `handoff_to`, `handoff_to_pane`.
- The prompt gets a footer: `Handed off by <sender> (pane <id>). To reach it: herdr agent prompt <id> "..."`.
- `handoff_at` is what lets the dashboard adopt the new `ticket` over its own mirrored copy
  (`data/agent-tags.json`); `task` and `handoff_*` are never mirrored, so they vanish on a herdr restart.
- `wt-finish` clears `task` when the work is retired.
