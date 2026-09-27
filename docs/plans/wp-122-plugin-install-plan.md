# WP-122 — Install wt-pack as a Claude Code plugin only

## Goal

`/plugin marketplace add rephol/wt-pack` followed by `/plugin install wt-pack@wt-pack` gives every `wt-*` skill,
plus wt-memory's hooks and MCP server. It needs no `./setup` and no dashboard. Skills that need the dashboard say
so clearly instead of failing with raw curl errors. The `./setup` symlink install keeps working unchanged.

## What research corrected

- **"About 86 hard-coded paths" is really 94 literal ones plus one that is built in code.**
  - The built one is `server.mjs:2709`, where `packRoot()` resolves `join(homedir(), '.claude', 'skills', 'wt-handoff')`.
  - Of the 94, most are harmless:
    - 64 are prose in SKILL.md and references files.
    - 6 are setup and docs lines that target the symlink install on purpose (`setup:16`, `README.md:92,123`,
      and others).
    - About 9 are in scripts, MCP configs and UI text.
  - Only **7 are strings sent into another agent's shell**, and those are what break a plugin-only install:
    - `handoff.sh:214` "To reply: ~/.claude/skills/wt-handoff/scripts/handoff.sh --reply …"
    - `handoff.sh:277`
    - `inject.mjs:30`, `:62`, `:63` (the room post and `--reply` instructions)
    - `dispatch.mjs:29`
    - `server.mjs:2775`, the error text
- **A plugin install namespaces skills.** The docs say: "Claude Code namespaces every component under it", so
  the skills become `/wt-pack:wt-plan`. Prompts that say "Use wt-plan …" still work, because the model picks the
  skill by its description. A literal slash command such as WP-121's `/wt-watch-prs review …` does not resolve
  under a plugin install. U2 handles that.
- **wt-memory's MCP server isn't inside its plugin directory.** `skills/wt-memory/claude-plugin/.mcp.json:5`
  runs `${WT_MEMORY_MCP:-$HOME/.claude/skills/wt-memory/mcp/server.mjs}`. The server lives at
  `skills/wt-memory/mcp/`, outside the plugin source `./skills/wt-memory/claude-plugin`. The current wt-memory
  plugin therefore depends on the symlink install. On its own it doesn't satisfy "no ./setup".
- **Skills with no dashboard.**
  - `wt-ticket` already says `wt-dashboard not reachable at $API` (`wt-ticket:29`).
  - `wt-room` prints only curl's raw error (`room:10`, `curl -sS --fail-with-body`).
  - `project-setting.mjs` returns nothing when `wt.db` is missing (`if (!existsSync(file)) return []`), so it
    already degrades silently.
  - `wt-agents` and `wt-handoff` need only herdr. The board lookup in `handoff.sh:219` is `|| true`.

## Approach

**Settled decisions** (made without a user; this run is headless):

- *One `wt-pack` plugin rooted at the repo root.* In `marketplace.json`, add
  `{ "name": "wt-pack", "source": "./" }` (the docs: "`"."` on its own means the root itself"). The default
  `skills/` scan then picks up every `skills/wt-*/SKILL.md`, with no `skills` field needed.
  - A root `.claude-plugin/plugin.json` names the plugin and folds in wt-memory:
    - a root `hooks/hooks.json` whose commands point at
      `${CLAUDE_PLUGIN_ROOT}/skills/wt-memory/claude-plugin/hooks/*.mjs`;
    - `mcpServers.wt-memory` running `node ${CLAUDE_PLUGIN_ROOT}/skills/wt-memory/mcp/server.mjs`.
  - The standalone `wt-memory` plugin entry stays, because `./setup` installs it (the backward-compat rule).
  - Rejected: keeping wt-memory as the only plugin, which can't reach its MCP server without the symlinks.
  - Rejected: a `skills` field that lists directories, which is unnecessary because the default scan covers them.
- *Having both plugins enabled is a supported mistake.* It would inject preferences twice and register two
  pkill guards. `./setup doctor` warns when both `wt-pack@wt-pack` and `wt-memory@wt-pack` are enabled, and the
  README says: pick one path.
- *Strings sent to agents carry the sender's resolved absolute path, not `~/.claude/skills`.* Each sender
  computes its own sibling path at send time:
  - `handoff.sh`: `$(cd "$(dirname "$0")" && pwd -P)/handoff.sh`;
  - `inject.mjs` and `dispatch.mjs`: `fileURLToPath(new URL('../../…', import.meta.url))`.

  The receiver is on the same machine and the same install, so the path is valid either way.
  - Rejected: a `wt` launcher on PATH, because a plugin install can't put anything on PATH without a setup step.
- *SKILL.md prose names paths relative to the skill's base directory.* Claude Code announces "Base directory for
  this skill: …" when a skill loads, so prose uses `scripts/x.sh` for the skill's own scripts and
  `../wt-handoff/scripts/handoff.sh` for siblings, both "(relative to this skill's base directory)". That works
  for symlinks and for the plugin cache alike.
  - Rejected: `${CLAUDE_PLUGIN_ROOT}`, which is empty in a symlink install.
- *Add the marketplace from GitHub or a clean clone, never from a working checkout.* Review ran a real
  local-path install and found that it ignores `.gitignore`. It copied `node_modules`, gitignored dirs and the
  nested `.claude/worktrees/*`, and the main checkout is 2.5G, 603M of it worktrees. That would copy other
  tickets' unmerged code and any local secrets into the cache. `rephol/wt-pack` from GitHub installs from git and
  is fine. The README says this, and `./setup doctor` warns when a `wt-pack` marketplace is registered from a
  local path that has `.claude/worktrees` or `node_modules` under it.
- *The dashboard stays out of the plugin path.* Its gitignored `web/dist` (1.8M) and Tauri build output aren't in
  a git clone. The wt-dashboard SKILL.md says it needs `./setup`.

## Implementation units

### U1 — Root plugin + folded wt-memory (repo root, wt-memory)
- `.claude-plugin/marketplace.json`: add the `wt-pack` plugin (`source: "./"`).
- New `.claude-plugin/plugin.json`: `name` wt-pack, `version`, `description`, `author` (review found that
  `validate --strict` fails "No author information provided" without it),
  `hooks: "./hooks/hooks.json"`, and `mcpServers` wt-memory as above.
- New `hooks/hooks.json`, mirroring `skills/wt-memory/claude-plugin/hooks/hooks.json` with root-relative
  commands.
- `inject.mjs`: its three `~/.claude/skills` uses resolve sibling-relative first
  (`new URL('../../../wt-room/…', import.meta.url)`), falling back to `~/.claude/skills/…`. The standalone
  wt-memory plugin's cache copy has no siblings; the fallback covers it.
- **Verify:** `claude plugin validate .` passes. `node --test skills/wt-memory/scripts/*.test.mjs` passes, plus
  a test for the inject path resolution with and without siblings.

### U2 — Paths in scripts and sent strings (wt-handoff, wt-memory, wt-dashboard, wt-shared, wt-agents)
- Send the resolved absolute path in `handoff.sh:214,277`, `inject.mjs:30,62,63` and `dispatch.mjs:29`.
- `server.mjs:2709` `packRoot()`: use the server's own `<repo>/skills` (`dirname` of `server.mjs`, as `:46`
  does) before `~/.claude/skills/wt-handoff`. Update the `:2775` text to match.
- `jev-mcp.mjs:40` switches to the sibling `../../wt-agents/mcp/catalog.json`, and `eval-plan.sh:30` to
  `$(dirname "$0")/../scripts/wt-eval.mjs`.
- `agents.sh spawn` exports `WT_MEMORY_MCP=<sibling>/wt-memory/mcp/server.mjs` into the herdr tab env. The four
  `mcp/<role>.json` files already honour the variable.
- Dispatched slash commands: `dispatch` in `watch-prs.sh` sends `Use wt-watch-prs to review …` instead of
  `/wt-watch-prs review …`, so it resolves under either install. SKILL.md accepts both forms.
- Tests:
  - Extend the existing tests (`dispatch.test.mjs`, `watch-prs.test.mjs`, `jev-mcp.test.mjs`,
    `spawn-env.test.mjs`) to assert that no sent string contains `~/.claude/skills`.
  - Add a repo-wide guard test: `grep -rn '~/.claude/skills\|\$HOME/.claude/skills'` over `skills/**/*.{sh,mjs}`
    (excluding tests) matches only an allowlist of fallbacks.
- **Verify:** `npm test` (wt-dashboard); `node --test` for wt-handoff, wt-watch-prs, wt-agents, wt-shared.

### U3 — SKILL.md prose (all skills)
- Rewrite the 64 prose paths to be base-dir-relative, as settled above. Mechanical, one commit per skill
  directory (the CLAUDE.md rule).
- **Verify:** the U2 guard test is widened to `SKILL.md` and `references/*.md`. It fails on any remaining
  `~/.claude/skills` outside a list of lines that name the symlink install on purpose.

### U4 — Clear dashboard dependency (wt-room, wt-ticket, wt-dashboard)
- `room`: copy wt-ticket's pattern. wt-ticket has no health probe: `wt-ticket:29` runs `curl … --max-time 5`
  and prints "not reachable" when curl fails, with HTTP errors handled separately. `room` wraps its curl the same
  way, so a connect failure prints `room: needs wt-dashboard running at $URL (see README › Install)` and exits 1,
  and an HTTP error still shows its body.
- `wt-ticket:29`: append the same README pointer.
- The wt-room, wt-ticket and wt-dashboard SKILL.md descriptions each gain one line: "Needs wt-dashboard (full
  `./setup`)".
- `status.tsx:148` / `integrations.tsx:168` text: say "from your wt-pack checkout: `cd skills/wt-dashboard &&
  npm start`".
- **Verify:** with `HERDR_DASH_URL=http://127.0.0.1:9`, `room list` and `wt-ticket list` print the pointer and
  exit 1.

### U5 — README, features, doctor, end-to-end check (docs, setup)
- `README.md` gets an **Install** section with three paths:
  1. Plugin only: two `/plugin` commands, then herdr for agents. No board, rooms or dashboard.
  2. Full `./setup`.
  3. Self-hosted: link to the self-hosted deployment proposal.

  Say which one to pick, and not to combine 1 and 2.
- `docs/features.md`: a plugin-install entry. `CLAUDE.md` Layout: the root `.claude-plugin/plugin.json` +
  `hooks/`.
- `./setup doctor`: the both-enabled warning, using `opt`.
- **End-to-end check** (run and paste the output):
  1. `T=$(mktemp -d)`.
  2. `CLAUDE_CONFIG_DIR=$T claude plugin marketplace add "$PWD"` (this worktree is clean, about 4 MB; never
     the main checkout), then
     `CLAUDE_CONFIG_DIR=$T claude plugin install wt-pack@wt-pack`.
  3. `ls $T/plugins/cache/wt-pack/wt-pack/*/skills` lists every `wt-*`.
  4. `sh $T/plugins/cache/wt-pack/wt-pack/*/skills/wt-handoff/scripts/handoff.sh --reply x "t" --dry-run` (or
     another script that runs with no herdr) runs from the cache path.
  5. `claude plugin validate --strict .`
  6. `rm -rf $T`.

  Review ran this with `wt-memory@wt-pack`: `CLAUDE_CONFIG_DIR` isolates the install, the real
  `installed_plugins.json` was untouched, and no auth was needed.

## Files

- New: `.claude-plugin/plugin.json`, `hooks/hooks.json`, a path-guard test (`skills/wt-shared/scripts/paths.test.mjs`)
- Modified:
  - `.claude-plugin/marketplace.json`
  - `skills/wt-memory/claude-plugin/hooks/inject.mjs` + its test
  - `skills/wt-handoff/scripts/handoff.sh`, `skills/wt-handoff/scripts/jev-mcp.mjs`
  - `skills/wt-dashboard/dispatch.mjs`, `skills/wt-dashboard/server.mjs`, `web/src/status.tsx`,
    `web/src/integrations.tsx`
  - `skills/wt-shared/hooks/eval-plan.sh`
  - `skills/wt-agents/scripts/agents.sh`
  - `skills/wt-watch-prs/scripts/watch-prs.sh`
  - `skills/wt-room/scripts/room`, `skills/wt-ticket/scripts/wt-ticket`
  - Every `skills/*/SKILL.md` and `skills/wt-plan/references/handoff.md` that has a prose path
  - `setup`, `README.md`, `docs/features.md`, `CLAUDE.md`
  - The existing tests named in U2

## Definition of Done

The transcript shows each command and its output:

1. `claude plugin validate --strict .` passes.
2. The end-to-end check in U5 lists every skill in the cache and runs a script from the cache path.
3. The path-guard test passes. It finds no `~/.claude/skills` in scripts, sent strings or SKILL.md prose outside
   its allowlist.
4. `npm test` (wt-dashboard) passes, plus `node --test` for wt-memory, wt-handoff, wt-watch-prs, wt-agents and
   wt-shared. `tsc` is clean.
5. With the dashboard unreachable, `room list` and `wt-ticket list` print the README pointer.
6. `./setup doctor` still passes on this machine (the symlink install still works), and the both-enabled warning
   shows only when it applies.
7. README Install, features.md and CLAUDE.md are updated. There is one commit per skill touched.

## Risks and deferred

- **Namespaced skill names.** A user typing `/wt-plan` under a plugin-only install must type `/wt-pack:wt-plan`.
  The README says so. Aliases are out of scope.
- **The standalone wt-memory plugin still needs the symlinks for MCP.** It is kept only for `./setup` users.
  Retiring it (so setup installs the root plugin instead) is a follow-up.
- **U3 rests on the "Base directory for this skill" header also appearing for plugin skills.** It is seen for
  symlinked skills in this very session, but review couldn't verify it for plugin skills. That needs a live
  session with the plugin loaded. The implementer checks it once with `claude --plugin-dir . -p "…invoke
  wt-pack:wt-finish and print the base directory line…"` (their own authenticated config; `--plugin-dir` loads
  without installing). If the header is absent, stop after U2 and report back rather than guessing a variable
  syntax.
- **The dashboard isn't installable as a plugin.** That is by design (gitignored build output, a launchd
  service).
