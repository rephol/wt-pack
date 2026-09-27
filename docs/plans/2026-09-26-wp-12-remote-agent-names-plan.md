# WP-12 — readable, stable names for remote agents

## Goal
Remote herdr agents (machines from `herdr machine list`) show a readable, @mention-able name instead of
`code-reviewer/w5:p8` or a session-topic title, and the name does not change each time the session topic does.

## What research corrected
- **"code-reviewer" is not a role.** It is the machine label: `herdr machine list` gives
  `code-reviewer herdr-box default enabled`. Both remote agents (`w5:p8`, `w5:p9`) have no herdr `name`,
  title `"Claude Code"`, cwd `/work/projects/myapp`, and no pane tokens.
- The name is derived at `wt-dashboard/server.mjs:388-389`:
  `let name = a.name ?? a.terminal_title_stripped ?? a.pane_id` and
  `if (!m.local && (GENERIC.test(name.trim()) || name === a.pane_id)) name = \`${m.label}/${a.pane_id}\``
  with `GENERIC = /^(claude code|claude)?$/i` (`:378`). A session-topic title such as
  "Code-reviewer agent startup command railway" is not GENERIC, so it passes through as the name.
  That second ticket example was not live at research time; it is inferred from this code (medium confidence).

## Approach
settled (planner assumption, no synchronous user): **display-only derivation in the server, no writes to
remote herdr.** A remote agent with a herdr `name` keeps it. Otherwise the name is
`slug(<machine label>-<cwd basename>-<pane index>)`, e.g. `code-reviewer-myapp-p8`. The slug rule is the
same one as `wt-agents/scripts/agents.sh` `repo_slug`: lowercase, `[a-z0-9_-]`, ≤32 characters. The terminal
title is **never** used as a remote name, because it is a session topic and changes.

- Rejected: `herdr --machine <m> agent rename` on first sight. That gives names that survive a herdr restart,
  but it writes to the user's real remote agents, adds SSH writes and needs an opt-in. It becomes a follow-up
  if pane-id-based names prove too unstable. The user can already pin a name with
  `herdr --machine <m> agent rename <pane> <name>`, and U1 honours it.
- The name contains the machine label, so it cannot collide with a local `<repo>-<role>-NN` name. Rooms key
  agents by bare name (`rooms.mjs:47` `new Map(agents.map((a) => [a.name, a]))`), so a collision would
  misdeliver.
- Stability ceiling: pane ids are positional (`w5:p8`), so the derived name changes if the remote layout
  changes. That is still better than today, where it also changes on every session topic.

## Implementation units
**U1 — derive the remote name.** `wt-dashboard/server.mjs:388-389`. Move the name choice after the resolved
cwd line (≈`:401` `p.cwd ?? a.foreground_cwd ?? a.cwd`); at `:388` only `a.cwd` exists, and its basename can
differ from what the UI shows. Export `agentName(m, a, cwd)` and `remoteName(label, cwd, paneId)` from
`server.mjs`. `parse.test.mjs:3` already imports named exports from `server.mjs`, and the server only starts
under `SERVE=1` or when run directly (`:2305`). For a local agent, `agentName` keeps today's expression exactly.
For a remote, it returns `a.name || remoteName(...)`. `remoteName`: take the basename of cwd (`'agent'` if absent) and the pane part after `:`, joined
with `-`, then slugged to ≤32 characters. Truncate the middle (cwd) part first, so the machine and pane stay
distinct. Local agents are unchanged. The `key` (`:417` `${m.label}/${a.pane_id}`) is unchanged, so no cache
or state migration is needed.
Verify: a unit test in `parse.test.mjs` (or the file that hosts `remoteName`) covering
`('code-reviewer','/work/projects/myapp','w5:p8') → 'code-reviewer-myapp-p8'`, a capitalised/spaced
label, a missing cwd, the 32-character cap with distinct panes, and a herdr `name` taking precedence, and a local agent getting
`a.name ?? a.terminal_title_stripped ?? a.pane_id` unchanged (all through `agentName`).

## Files
- `wt-dashboard/server.mjs`
- `wt-dashboard/parse.test.mjs`

## Verification
- `cd wt-dashboard && npm test`.
- Live: `npm run service:restart` once, then `curl -s localhost:7777/api/overview | jq '.agents[] | select(.local|not) | .name'` (there is no GET
  `/api/agents`; agents are served in `/api/overview .agents`, `server.mjs:2115`) and check that the remote agents read `code-reviewer-myapp-p8` / `-p9`. Check the sidebar with
  agent-browser `--session <agent name>`, plus a screenshot via `wt-shared/scripts/screenshot.mjs`.
  Read only; **do not rename or prompt the remote agents** (they are the user's real ones).

## Definition of Done
- No live remote agent name contains `/`, a space or a capital; each is ≤32 characters and matches
  `^[a-z0-9_-]+$` (checked on the live endpoint).
- The `remoteName` unit tests pass. The local-agent case in the `agentName` test passes.
- A screenshot of the sidebar is posted in #wt-pack.

## Risks and deferred
- Deferred: `wt-handoff` / `herdr agent prompt` to remote agents. `handoff.sh` calls local
  `herdr agent list` / `herdr agent prompt "$1"` with no `--machine`. A readable name does not make a remote
  agent reachable by handoff. File as a follow-up.
- Deferred: remote pane tokens/tags (`server.mjs` skips `!m.local` for tokens and `agent-tags.json`) and the
  local-only ticket assignee lookup (`.find((x) => x.local && x.name === b.assignee)`).
- Deferred: persistent renaming via `herdr --machine … agent rename` (see Approach).
- Room members are stored by bare name (`rooms.mjs:308`, `:335`), and delivery filters them by live names
  (`rooms.mjs:60` `filter((n) => byName.has(n))`). A remote agent that joined a room under its old
  `code-reviewer/w5:p8` or topic-title name silently stops receiving messages until it is re-invited. This is
  accepted; no migration.
- Room @mention of the new names is not tested live. Sending to the real remote agents is off-limits.
