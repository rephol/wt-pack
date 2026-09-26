---
name: wt-memory
description: Durable agent preferences shared by every agent runtime — global, per role and per project markdown under ~/.config/wt-memory, injected into Claude Code sessions by the wt-memory plugin. Use when asked to remember, set, show or change a standing preference for agents, or to debug what preferences an agent received.
---

# wt-memory

Plain markdown, one file per scope, merged global → role → project:

- `~/.config/wt-memory/global.md` — every agent
- `~/.config/wt-memory/roles/<role-id>.md` — agents whose herdr `role` token is that id (Settings › Roles ids)
- `~/.config/wt-memory/projects/<repo>.md` — agents in that repo (a worktree counts as its main repo)

`$WT_MEMORY_HOME` overrides the directory. Edit the files directly or in wt-dashboard Settings › Memory.

`scripts/wt-memory`:
- `context [--role R] [--project P] [--cwd D]` — the merged markdown an agent gets; without flags inferred
  from `$HERDR_PANE_ID` (pane tokens role/project, pane cwd), project falling back to the cwd's git repo.
  Empty scopes (or ones holding only `<!-- comments -->`) are skipped; nothing at all prints nothing.
  Never fails loudly: it runs in hooks.
- `hash [same flags]` — 16-hex hash of that output, for change detection.
- `path [global | role R | project P]` — the store dir, or one file.
- `remember "<note>" [--scope role|project|global] [--role R] [--project P]` — agents maintain memory
  themselves. Default scope: project if inferable, else role. Appends one bullet
  `- <note> <!-- wtm:id=ab12cd by=<agent> at=YYYY-MM-DD -->` (author = herdr agent name of `$HERDR_PANE_ID`);
  `context` strips the trailer. Near-identical notes (same words ignoring case/punctuation) are skipped.
  **Global is never written directly**: it lands in `pending/<id>.json` and prints "proposed (awaiting
  approval)" until the user accepts it in the dashboard inbox (or `accept <id>` / `reject <id>`).
- `forget <id>` — remove an entry (or a pending proposal). `list [--scope S] [--json]` — agent entries and
  pending proposals. Free-form text you write by hand is never touched. Writes are tmp+rename.

**When an agent should remember** (the plugin tells Claude this at SessionStart): the user states a standing
preference or corrects a recurring behaviour ("always / never / from now on / stop doing") → a concise
imperative, role or project scope; global only for what holds across every project and role. Not one-off
task details. Tell the user in one line what was remembered.

**Dashboard:** role/project entries raise an inbox notice with Undo (forget); global proposals raise one with
Accept / Reject. Settings › Memory lists agent entries (author, date, remove) and pending proposals.

**Claude Code:** the `wt-memory` plugin (`claude-plugin/`, marketplace `wt-pack` at the repo root) injects
`context` at SessionStart and, on UserPromptSubmit, re-injects it prefixed "Preferences updated:" only when its
hash changed since the last injection for that session (state in `~/.cache/wt-memory/`). Other runtimes: run
`wt-memory context` in whatever start hook they have.

Install: `claude plugin marketplace add ~/Work/projects/wt-pack && claude plugin install wt-memory@wt-pack`.
A change to the plugin needs `claude plugin marketplace update wt-pack && claude plugin update wt-memory@wt-pack`
(installs are copies). Self-check: `node --test scripts/wt-memory.test.mjs`.
