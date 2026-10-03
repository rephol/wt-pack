---
name: wt-mods
description: The wt-pack Claude Code mods — the instant `/wt <room|ticket|dnd|herd|watch> …` command and per-request model routing. Part of the wt-pack plugin; not something to invoke by name.
---

# wt-mods

Source of two of the wt-pack plugin's mods (the plugin's one hooks module is `hooks/register.ts` at the repo root,
which also registers `skills/wt-ask` and `skills/wt-room/mod`). The other skills are at `<plugin root>/skills`.

- `/wt <sub> …` runs a script directly, with no model turn, also while the agent is mid-turn: `/wt room list|read|post`,
  `/wt ticket show|move|list|comment`, `/wt dnd [on|off]` (this pane), `/wt herd [role]`, `/wt watch status`. `/wt`
  alone prints the usage.
- Per-request model routing (`hooks/routing.ts`, WP-211): the first request of each main-loop turn goes through
  `wt-shared/scripts/model-route.mjs`; only `WT_MODEL_ROUTING=live` rewrites the request. See docs/features.md › Model routing.

`hooks/compose.ts` lets several mods share an event the engine allows one hook on. Test: `scripts/test`. Reload
without a restart: `/reload-plugins`.
