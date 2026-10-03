# WP-204: Project roles (per-role instruction files `.wt-pack/roles/<role>.md`, personas, the wt-roles skill)

Base: `origin/main` @ 4b3e6e8. Branch `wp-204-project-roles`. Size L, done in 4 phases. Each phase ships alone,
and with no role files present, behaviour is unchanged (the ticket's compatibility rule).

## What research found (evidence)
- **The injection point already exists and already infers the repo.** `skills/wt-memory/scripts/wt-memory`
  `merge({ role, project })` (`:34-39`) builds the injected markdown from `## Global preferences`,
  `## Role preferences (${role})` and `## Project preferences (${project})`. `infer()` (`:42-55`) reads the role
  and project from the pane tokens (`herdr pane get` → `p.tokens?.role`, `p.tokens?.project`, `cwd ||= p.cwd`) and falls
  back to `git rev-parse --git-common-dir` for the project. The plugin hook calls it:
  `claude-plugin/hooks/inject.mjs:50` runs `[bin, 'context', ...(input.cwd ? ['--cwd', input.cwd] : [])]` with
  `timeout: 2000`. **Project-role injection is therefore a fourth part in `merge()`**, read from
  `<main checkout>/.wt-pack/roles/<persona || role>.md`. It needs no new hook. `merge` must also receive the
  checkout path, which `infer` already has (`cwd`).
- **Pools already accept any role name.** In `agents.sh`, "A pool is a herdr workspace, '<repo>-<role>s' … Any role name
  works ([a-z][a-z0-9-]*)" (header, ~`:30-32`). But the gates downstream key on the **base** role token:
  `retireIdle` keeps `a.tokens?.role === 'worker'` (`wt-dashboard/server.mjs` ~1012), and handoff's
  `--role` accepts only `worker|planner|reviewer` (`handoff.sh:97-98`). So **a persona must carry `role=<base>`
  plus a separate `persona=<name>` token.** Spawning it as `role=frontend-worker` would create a separate
  `<repo>-frontend-workers` pool that retire, DND/pair gates and Dispatch never see.
- Dashboard role resolution: `resolveRole()` (`wt-dashboard/roles.mjs:40-46`) accepts a token only if
  `token === 'other' || roles.some((r) => r.id === token)`, which is the "unknown roles dropped" trap. With
  `role=<base>` this is untouched. `persona` is a new token key, added to `LIVE_KEYS`/`MIRRORED_KEYS`
  (`roles.mjs:29-31`): MIRRORED, so that it survives a herdr restart like `role` does.
- Dispatch picks a role with `roleFor(t)` = `t.size === 'L' || t.labels?.includes('needs-plan') ? 'planner' : 'worker'`
  (`dispatch.mjs:12`). Persona routing goes on top of this.
- MCP: `agents.sh` validates names against the catalog ("unknown MCP server(s): … (see $dir/catalog.json)",
  `:130`), and `--mcp a,b` is already a spawn flag. Model and effort tokens are already set at spawn (WP-143).

## Settled decisions (headless: stated assumptions)
1. **File location:** the repo's **main checkout** `.wt-pack/roles/`, resolved from `--git-common-dir`. A
   worktree reads the main checkout's copy, so every agent in a repo agrees, and an uncommitted edit in a
   worktree does not leak. The trade-off is that a role edit takes effect once merged to the main checkout.
2. **Frontmatter:** a tiny parser in a new shared module `wt-shared/scripts/roles.mjs` (no YAML dependency;
   flat `key: value` lines plus `[a, b]` lists). Fields:
   - `base` (one of orchestrator, planner, worker, auditor, reviewer; required unless the filename is itself
     a base role)
   - `model` (haiku|sonnet|opus, floored by `model-route.mjs floor`, so never haiku for a session)
   - `effort` (low|medium|high)
   - `mcp` (a list of catalog names, added to the role's set)
   - `skills` (a list of hints that are injected as a line, not enforced)
   - `labels` (a list, for Dispatch)

   Unknown keys are a `check` warning. The body is free-form.
3. **Merge order and cap:** global → role → project → project-role. The heading is
   `## Project role (<name>, .wt-pack/roles/<name>.md)`. The cap is 6 KB of body; beyond it, truncate at a line
   boundary and append `… truncated (N bytes over the 6 KB cap; see the file)`. A persona whose base also has
   an override file injects both, base override first.
4. **Personas:** `wt-agents spawn frontend-worker` → `roles.mjs resolve <repo> frontend-worker` → `{base:
   worker, model, effort, mcp}`. agents.sh then spawns into the **base pool** with `role=worker`,
   `persona=frontend-worker`, the persona's model and effort (explicit flags win), and `--mcp` merged. The
   agent name is `<repo>-frontend-worker-NN` (still within the herdr ≤32 limit; agents.sh already cuts the repo
   part to 20). An unknown spawn name with no file behaves as today (any role name is a pool).
5. **Dispatch:** for each Ready ticket, the first persona (in filename order) whose `labels` intersect the
   ticket's labels and whose `base` equals `roleFor(t)` wins. Handoff then prefers a free agent with
   `persona=<p>`, or spawns that persona. That needs `handoff.sh --persona <p>`, a new flag, filtered in
   `candidates()` by the `persona` token. **A free agent with no persona token is not used for a persona ticket,
   and a persona agent is not used for a plain ticket** (strict, so personas don't drift). No match →
   today's behaviour.
6. **Defaults shipped:** `skills/wt-roles/defaults/<base>.md` are example override files. They are **not**
   copied into repos automatically. `wt-roles new --from-default worker` copies one, so no repo changes
   behaviour by installing the pack.
7. **Dashboard editor:** Settings › Projects › Roles lists the files and their `check` status, edits a body
   and frontmatter, and writes to the main checkout. It shows `git status --porcelain .wt-pack/roles`. It never
   commits (decision from the scope comment: edits are committed like code). Paths are confined to
   `<checkout>/.wt-pack/roles/*.md`, and names are validated with the same `NAME` regex as wt-memory (`:21`).

## Phases and units
### Phase 1: read path (wt-shared + wt-memory)
- U1 `wt-shared/scripts/roles.mjs`: `parse(text)`, `list(checkout)`, `resolve(checkout, name)`, and `check(checkout,
  catalog)`. Tests in `roles.test.mjs` cover frontmatter, a missing or bad base, an unknown MCP, a size warning, and
  an override plus a persona.
- U2 `wt-memory` `merge()`: a fourth part per decision 3. Import `roles.mjs` with **dynamic `import()` inside
  `merge`** (CLAUDE.md trap: a top-level cross-skill import breaks every subcommand when wt-shared is absent).
  Tests in `wt-memory.test.mjs`: a temp repo with `.wt-pack/roles/worker.md` → `context --role worker --cwd
  <repo>` contains the section; a persona token picks the persona file; 7 KB → the truncation note; no
  directory → output byte-identical to today.
- `infer()` also reads `p.tokens?.persona`.

### Phase 2: personas spawnable (wt-agents + dashboard tokens)
- U3 `agents.sh spawn <name>`: resolve via `roles.mjs`, spawn into the base pool, and set tokens per
  decision 4. `persona` goes in `MIRRORED_KEYS`. Tests: spawn-env test with a PATH-shimmed herdr asserting
  `role=worker persona=frontend-worker` and the merged `--mcp`.
- U4 dashboard: show a persona chip next to the role badge wherever the role badge renders.

### Phase 3: Dispatch routing (dispatch.mjs + handoff.sh)
- U5 `handoff.sh --persona`, plus the `candidates()` filter (decision 5). Tests: a persona agent listed
  only for `--persona`, and a plain agent not listed for it.
- U6 `dispatch.mjs`: a pure function `personaFor(ticket, personas)` that is unit tested, then passed to
  handoff.

### Phase 4: wt-roles skill, editor, defaults, docs
- U7 `skills/wt-roles`: SKILL.md. Its description triggers on "create a role/persona", "add a QA persona" and
  "change how the worker behaves in this project". It contains the guide (override vs persona, fields and
  allowed values, how to write the body, the cap, labels, and the commit rule), `template.md`, and 2 worked
  examples (`examples/worker-override.md`, `examples/frontend-worker.md`). The CLI `scripts/wt-roles` has
  `new <name> --base <role> [--from-default]`, `check`, and `list` (what is in effect, with the cap status).
  `setup` links it, and CLAUDE.md's skill map gets a row.
- U8 dashboard Roles editor (decision 7), with API tests for path confinement (`../x` → 400) and a name regex.
  No native dialogs. It links to the wt-roles guide.
- U9 `docs/features.md`, plus a README "Roles" section.

## Definition of done
Each item is checkable from a transcript:
- `node --test skills/wt-shared/scripts/roles.test.mjs skills/wt-memory/scripts/*.test.mjs skills/wt-handoff/scripts/*.test.mjs
  skills/wt-roles/scripts/*.test.mjs` all pass. `cd skills/wt-dashboard && npm test` passes (dispatch
  `personaFor`, the roles API confinement). `npx tsc --noEmit -p web/tsconfig.app.json` is clean.
- The no-file baseline: `wt-memory context --role worker --cwd <repo without .wt-pack>` output is identical before
  and after (diff the two runs in the transcript).
- A live check in a **throwaway repo** with a throwaway pool: `wt-roles new frontend-worker --base worker`, then
  `wt-roles check` → ok. `wt-agents spawn frontend-worker` → `herdr pane get` shows `role=worker`,
  `persona=frontend-worker`, and the agent sits in `<repo>-workers`. Its session context contains
  `## Project role (frontend-worker`. Clean up afterwards.
- `./setup doctor` is clean, with `wt-roles` linked. `node --test skills/wt-shared/scripts/paths.test.mjs` passes.

## Order and commits
Phase 1 → 2 → 3 → 4. Make one commit per skill touched, in each unit.

## Risks
- inject.mjs's 2 s timeout: a `herdr pane get` plus a file read is fine, but parsing must stay synchronous and
  small.
- A persona name colliding with a dashboard role id (Settings › Roles). Persona files can't use a base name
  as a persona name, and `check` warns on a collision with a Settings role id **[unsourced: where Settings roles
  are stored; the worker reads `roles.mjs`'s loader]**.
- Strict persona matching (decision 5) can leave a persona ticket waiting while plain workers are free. That is
  accepted: Dispatch spawns the persona instead of waiting.
