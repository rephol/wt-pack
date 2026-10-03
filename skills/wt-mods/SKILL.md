---
name: wt-mods
description: The wt-pack Claude Code mods — the instant `/wt <room|ticket|dnd|herd|watch> …` command and per-request model routing. Loaded as a plugin from this directory by ./setup; not something to invoke by name.
---

# wt-mods

A Claude Code *mod* (a plugin of function hooks, `hooks/register.ts`), linked in by `./setup` like every skill
like every skill. The other skills are its siblings, which is how it reaches their scripts.

- `/wt <sub> …` runs a script directly, with no model turn, also while the agent is mid-turn: `/wt room list|read|post`,
  `/wt ticket show|move|list|comment`, `/wt dnd [on|off]` (this pane), `/wt herd [role]`, `/wt watch status`. `/wt`
  alone prints the usage.
- Per-request model routing (`hooks/routing.ts`, WP-211): the first request of each main-loop turn goes through
  `wt-shared/scripts/model-route.mjs`; only `WT_MODEL_ROUTING=live` rewrites the request. See docs/features.md › Model routing.

Test: `claude plugin test skills/wt-mods`. Reload without a restart: `/reload-plugins`.
