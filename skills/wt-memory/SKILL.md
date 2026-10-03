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
- `remember "<note>" [--scope role|project|global] [--role R] [--project P] [--strict]` — agents maintain memory
  themselves. Default scope: project if inferable, else role. Appends one bullet
  `- <note> <!-- wtm:id=ab12cd by=<agent> at=YYYY-MM-DD -->` (author = herdr agent name of `$HERDR_PANE_ID`);
  `context` strips the trailer. Near-identical notes (same words ignoring case/punctuation) are skipped.
  With `WT_JEV_MEMORY_DUP` on (default), Jev compares the note with the scope's newest 40 entries and prints
  `similar to: …` / `conflicts with: …`; the note is still written unless `--strict`, which refuses (exit 1).
  With `WT_JEV_MEMORY_SUGGEST` on (default off) the plugin's UserPromptSubmit hook adds a remember hint when
  Jev judges the prompt a standing preference (≥ 0.8, 1.5s cap, in parallel with the context read).
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
hash changed since the last injection for that session (state in `~/.cache/wt-memory/`). The plugin also
registers the MCP server below, so Claude gets `remember`/`forget`/`list`/`context` tools.

**MCP server** `mcp/server.mjs` (stdio, Node stdlib): tools `remember {note, scope?, role?, project?}`,
`forget {id}`, `list {scope?}`, `context {role?, project?}` — each shells out to `scripts/wt-memory`
(`$WT_MEMORY_BIN` overrides), inheriting the agent's env and cwd.

**Codex CLI / Gemini CLI** — both run Claude-format `SessionStart` command hooks (stdin JSON with `cwd`,
output `hookSpecificOutput.additionalContext`), so they reuse `claude-plugin/hooks/inject.mjs` as is.
Add to your own configs (not done automatically):

- Codex (`hooks` feature is stable/on), `~/.codex/hooks.json`:
  `{"hooks":{"SessionStart":[{"matcher":"startup|resume|clear|compact","hooks":[{"type":"command","command":"node <wt-pack checkout>/skills/wt-memory/claude-plugin/hooks/inject.mjs","timeout":5}]}]}}`
  and MCP: `codex mcp add wt-memory -- node <wt-pack checkout>/skills/wt-memory/mcp/server.mjs`
  (= `[mcp_servers.wt-memory]` `command = "node"`, `args = ["<abs path>/mcp/server.mjs"]` in `~/.codex/config.toml`).
- Gemini, `~/.gemini/settings.json` (timeout in ms; use absolute paths):
  `"hooks":{"SessionStart":[{"hooks":[{"name":"wt-memory","type":"command","command":"node <wt-pack checkout>/skills/wt-memory/claude-plugin/hooks/inject.mjs","timeout":5000}]}]}`,
  `"mcpServers":{"wt-memory":{"command":"node","args":["<wt-pack checkout>/skills/wt-memory/mcp/server.mjs"]}}`
 .

Install: wt-memory's hooks and MCP server ship in the one wt-pack plugin (`./setup` loads the checkout as it;
`claude plugin install wt-pack@wt-pack` is the plugin-only install, whose copy needs
`claude plugin marketplace update wt-pack && claude plugin update wt-pack@wt-pack` after a change). Self-check: `node --test scripts/wt-memory.test.mjs`.
