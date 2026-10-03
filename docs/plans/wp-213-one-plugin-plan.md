# WP-213: One wt-pack plugin (consolidate wt-memory, wt-ask-mod, wt-deliver-mod, wt-mods)

Base: `origin/main` @ 3fbee1f (WP-212 merged). Branch `wp-213-one-plugin`.

## What research found (evidence)
- **Five plugin manifests exist today.** `find skills -name plugin.json` finds:
  - `skills/wt-mods/.claude-plugin`, `skills/wt-ask/.claude-plugin`, `skills/wt-room/mod/.claude-plugin`, and
    `skills/wt-memory/claude-plugin/.claude-plugin`
  - the root `.claude-plugin/plugin.json`

  The marketplace (`.claude-plugin/marketplace.json`) lists `wt-pack` (`"source": "./"`), `wt-memory`
  (`./skills/wt-memory/claude-plugin`) and `wt-deliver-mod` (`./skills/wt-room/mod`). `setup` explains the other
  two: "mods … load straight from the skill links — skills/wt-ask … and skills/wt-mods … carry their own
  .claude-plugin, so Claude Code lists them as <name>@skills-dir" (`setup:109-111`).
- **The ticket's premise is half wrong.** It says "a plugin's hooks.json takes one mod module", but one module
  can register many mods, and the repo already does this. `skills/wt-mods/hooks/register.ts`, which starts
  "The wt-mods plugin's one hooks module (hooks.json allows a single entry)", calls
  `registerCommands(on, skills); registerRouting(on, skills)`. **One file can also carry both mods and command
  hooks:** the root `hooks/hooks.json` already has `"modules": ["./commands.ts"]` beside `"hooks": {
  SessionStart, UserPromptSubmit, PreToolUse }` (added by `7e01b5b … plugin mod (WP-207)`). So consolidating
  means one `register.ts` that calls every mod's `registerX`. No API limit stands in the way.
- **Duplication found:** the root `hooks/commands.ts` (WP-207 `/room /ticket …`) and `skills/wt-mods/hooks/
  commands.ts` (WP-212 `/wt <room|ticket|…>`) are both slash-command mods. The worker diffs them, keeps the
  WP-212 one, and removes the WP-207 one only if `/wt` covers every command. **[unsourced: whether WP-212 kept
  the bare `/room` etc. as aliases; it must stay backward compatible]**.
- wt-memory's command hooks use `${CLAUDE_PLUGIN_ROOT}/skills/wt-memory/claude-plugin/hooks/inject.mjs` from
  the root, and `${CLAUDE_PLUGIN_ROOT}/hooks/inject.mjs` from its own plugin. The root form already works.
- Each mod's `register.ts` resolves sibling skills relative to its own root (wt-mods: `const skills = (root) =>
  \`${root}/..\``). From the repo root, the siblings are at `${root}/skills`, so every `registerX` must take a
  skills-root function. wt-mods already does this. wt-ask and wt-room/mod need the same parameter.
- **Why full installs use the separate plugins:** the marketplace says the root plugin is "Every wt-* skill …
  Pick this OR ./setup, not both". Its `skills/` would duplicate the skill links (`setup:17`
  `SKILLS="$HOME/.claude/skills"`). That is the real constraint, not the hooks file.

## Settled decisions (headless: stated assumptions)
1. **One plugin, `wt-pack`, from the root manifest, for both installs.**
   - **Plugin-only install:** unchanged. `wt-pack@wt-pack` comes from the marketplace (a cache copy).
   - **Full install:** stop linking skills into `~/.claude/skills`, and load the checkout itself as the
     plugin through `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json`. The mods
     reference says it "names the same folders where no flag can be given … each loaded exactly as a
     `--plugin-dir` … taken from … the `env` block of `~/.claude/settings.json`", and an interactive session
     watches it, so edits stay live. This is what the skill links gave today and what a marketplace cache
     copy cannot. The checkout's skills, hooks, MCP and mods are all in one plugin, so nothing is duplicated.
   - Trade-off: skills appear namespaced (`wt-pack:wt-plan`) rather than bare. **[unsourced: whether
     plugin-dir skills show namespaced; check `claude plugin list` after the change]**. Every script refers to
     siblings relatively, and nothing may hard-code `~/.claude/skills` (`paths.test.mjs`), so paths keep
     working. Bare `/wt-plan` invocations still work if Claude Code resolves unambiguous short names
     **[unsourced]**. If they do not, fall back to keeping the skill links and making the root plugin's
     skills dir opt-out. That is the shape-changing branch, so the worker verifies it first (U1) and records
     the result.
2. **One module:** a root `hooks/register.ts` calls `registerCommands`, `registerRouting`, `registerAsk` and
   `registerDeliver` (each takes a `skills` root function). Root `hooks.json` becomes
   `"modules": ["./register.ts"]`, with the existing `"hooks"` block unchanged.
3. **Remove** `.claude-plugin/` and `hooks/hooks.json` from `skills/wt-ask`, `skills/wt-mods`,
   `skills/wt-room/mod` and `skills/wt-memory/claude-plugin`. The mod source files stay where they are (the
   tests next to them keep running). Drop `wt-memory` and `wt-deliver-mod` from `marketplace.json`, and keep
   `wt-pack`. The marketplace manifest stays as setup's `is_pack` marker (`setup:73-74`).
4. **Migration (`setup install`):**
   - `claude plugin uninstall` for `wt-memory@wt-pack`, `wt-deliver-mod@wt-pack` and `wt-ask-mod@wt-pack`,
     each only if listed
   - remove skill links that point into this checkout
   - add the checkout to `CLAUDE_CODE_PLUGIN_DIRS` (idempotent; keep other entries; edit JSON with node, as
     setup already does)
   - if `wt-pack@wt-pack` is also installed from the marketplace on a full install, uninstall it so it is not
     loaded twice

   `setup uninstall` reverses the env entry.
5. **Doctor:** exactly one wt-pack plugin is loaded. `claude plugin list --json` has one id starting
   `wt-pack@` (or the plugin-dir form) and none of the old four. Otherwise it reports a `bad` line naming the
   extras. This replaces the per-mod checks at `setup:190-205`.
6. A respawn is needed: plugin hooks load at session start (CLAUDE.md WP-120). Doctor says so after
   migration.

## Units
1. **Verify the branch:** with a scratch `CLAUDE_CODE_PLUGIN_DIRS=<worktree>` run `claude -p "/wt-plan --help"`
   (or list skills via `claude plugin list --json`) and record how the skills are named. If decision 1's
   check fails, switch to the fallback and note it in the plan commit.
2. **The module:** root `hooks/register.ts` plus the `registerAsk`/`registerDeliver` refactors with a
   skills-root parameter. Merge or remove the WP-207 `commands.ts` duplicate. Tests: `claude plugin validate .`,
   `claude plugin test .` from the repo root run every mod's `*.test.ts`, and `tsc -p .` is clean.
3. **Delete the old manifests and marketplace entries** (decision 3). `grep -rn '"modules"' skills/` →
   nothing.
4. **setup** install/uninstall migration plus doctor (decisions 4–5). Tests: if `test/` has setup tests,
   extend them with a stubbed `claude` on PATH listing the old four → uninstall calls made. Otherwise add
   `test/setup-migrate.test.mjs`.
5. **Docs:** `docs/features.md` (one plugin, migration, respawn), CLAUDE.md Layout and Skill map lines (`wt-mods`
   row, "linked as `~/.claude/skills/<name>` by ./setup" now describes the plugin dir), and README install.

## Definition of done
Each item is checkable from a transcript:
- `claude plugin validate .` and `claude plugin test .` pass from the repo root.
- `find skills -name plugin.json` prints nothing, and `grep -c '"name"' .claude-plugin/marketplace.json` shows
  only the marketplace and `wt-pack`.
- `node --test skills/wt-shared/scripts/paths.test.mjs skills/wt-memory/scripts/*.test.mjs` passes, as do
  `cd skills/wt-dashboard && npm test` and the setup migration test.
- Live on this machine: `./setup install` then `claude plugin list --json`. Exactly one wt-pack plugin is
  listed, `./setup doctor` is clean, and a throwaway agent spawned afterwards has the `/wt` command, wt-memory
  context, AskUserQuestion capture and queued delivery (one check each, as in WP-206/210). Clean up afterwards.

## Order
1 → 2 → 3 → 4 → 5. U1 decides decision 1's branch before anything is deleted. Commit per skill.

## Risks
- Running agents lose the old plugins at their next session start and need a respawn. Announce it in
  #wt-pack at merge.
- `CLAUDE_CODE_PLUGIN_DIRS` loads the whole checkout including `skills/wt-dashboard/node_modules`. Check
  that plugin loading ignores it, or the load is slow **[unsourced]**.
