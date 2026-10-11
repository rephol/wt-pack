# WP-334 — Repo role trust

Source: `docs/plans/wp-326-envelope-trust-audit.md` S8 (finding 10), user decision **Q5**: repo-level role files
(`<checkout>/.wt-pack/roles/*.md`) load only for projects the user marked trusted with a per-project Settings toggle;
otherwise a one-line notice and the base role applies. Last of the chain. Only WP-334.

## Today (read from the tree)
- `skills/wt-shared/scripts/roles.mjs` (WP-204): role files live in the **repo** folder `<checkout>/.wt-pack/roles` or
  the **user** folder `~/.config/wt-pack/projects/<repo dir>/roles` (`userRoot`, `:32`); `settingsWhere` (`:33`) picks
  the repo folder when `<checkout>/.wt-pack` exists. `load()` (`:70-80`) reads `rolesDir(checkout)`; `list`/`resolve`/
  `personas`/`sections` build on it. Callers: wt-memory `context` (SessionStart hook, 2 s budget), `agents.sh`,
  `handoff.sh`, `model-route.mjs`, `gates.mjs`, `teams.mjs`, `wt-roles`, dashboard `project-roles.mjs`,
  `project-teams.mjs`, `server.mjs` (`headlessRole`).
- The user folder is user-authored (outside any repo) → always trusted. Only the **repo** folder is what a cloned
  third-party repo can plant.
- Per-project settings: `skills/wt-dashboard/project-settings.mjs` `PKEYS` (scope `project`), stored in
  `DATA/wt.db` table `project_settings (project, key, value)` — not readable cheaply from a hook without opening sqlite.
- On this machine only wt-pack has a repo role folder (`.wt-pack/roles/product-planner.md`, `tech-lead.md`);
  umkmall uses the user folder. So the migration answer is clear: trust wt-pack.

## Design
1. **Setting**: `PKEYS.trustRepoRoles = { scope:'project', label:'Trust this repo’s role files (.wt-pack/roles)',
   default:'off', check: oneOf('on','off') }` — shows in the per-project Settings like the other project keys.
2. **Mirror for non-server readers**: whenever `trustRepoRoles` is written (and once at server start), the server writes
   `~/.local/share/wt-dashboard/trusted-projects.json` = `{ "<project>": "<main checkout realpath>", … }` (atomic tmp +
   rename, 0600). Keyed by realpath so a same-named clone elsewhere is not trusted. `[unsourced]`: confirm how
   `project_settings.project` maps to a checkout path (`projectRoots()` in server.mjs) and use that mapping.
3. **Gate in roles.mjs**: `trusted(checkout)` = realpath(checkout) is a value in that JSON (read once per process,
   try/catch → `{}` = untrusted; tiny file, fine for the 2 s hook). In `load()` and `list()`: when the effective folder
   is `repo` and the checkout is not trusted, return no repo roles (the **user** folder is still read if it exists —
   settingsWhere's "repo wins" rule must not hide a user folder behind an untrusted repo folder: when untrusted, fall
   back to the user folder). Export `untrustedNotice(checkout)` → one line or `''`:
   `This repo has .wt-pack/roles but is not trusted; base roles apply. Trust it in wt-dashboard Settings › <project>.`
4. **Notice**: wt-memory `context` appends that line once per session when non-empty (same place roles are injected);
   `wt-roles list|check` print it; `agents.sh spawn <persona>` for an untrusted repo persona fails with it (persona not
   found today → same path, clearer message).
5. **Migration**: a store migration / startup step sets `trustRepoRoles=on` for the project whose checkout is the
   wt-pack repo itself **and** any project that currently has a non-empty `<checkout>/.wt-pack/roles` — they are in use
   today, so turning them off silently would change running teams. Log each one; docs tell the user how to untrust.
   `// ponytail: grandfathered once at migration; new clones start untrusted (Q5)`.
6. Out of scope: other `.wt-pack/*` files (`model-routing.json`, gates) — note as residual for the orchestrator.

## Units (one commit per skill)
- **U1 wt-shared** — `trusted`, gate in `load`/`list`, `untrustedNotice`. Tests (`roles.test.mjs` style, temp HOME +
  temp repo): untrusted repo with `.wt-pack/roles/worker.md` → `resolve` null, notice non-empty; trusted → loads; a
  user-folder role still loads for an untrusted repo; malformed/missing JSON → untrusted; a same-basename clone at
  another path → untrusted.
- **U2 wt-dashboard** — PKEY, mirror writer, migration, Settings row (follow existing project-key rendering; web tsc
  `-p tsconfig.app.json`). Tests: toggling writes the JSON; migration trusts a project with roles and not one without.
- **U3 wt-memory** — notice in `context`; test with an untrusted temp repo.
- **U4 wt-roles / wt-agents** — print/fail with the notice; existing tests green.
- **U5 docs** — `docs/features.md` (roles section: trust toggle, default, notice, grandfathering) and a CLAUDE.md
  skill-map tweak for wt-roles (repo roles need trust).

## Hand-off and reporting
The worker reports the branch **directly to the orchestrator**: `handoff.sh --reply w1M:p2 "WP-334 done: branch … tip …"`.
No merge, no push. Merge order: server (restart, runs the migration and writes the JSON) **before** agents restart with
the new roles.mjs — otherwise wt-pack's own roles disappear until the JSON exists.

## Definition of done
- `npm test` (skills/wt-dashboard), wt-shared, wt-memory, wt-roles, wt-agents tests pass with the U1–U3 cases.
- Throwaway repos/HOME only in tests; the real wt-pack trust entry is created only by the migration on the real server.
- No e2e writing or running.

## QA brief
Settings › a project shows "Trust this repo’s role files" (off for a fresh throwaway repo, on for wt-pack), readable at
412x700 and iPhone 13. Spawn a throwaway agent in a throwaway repo with `.wt-pack/roles/worker.md`: its session start
shows the one-line notice and the base worker role; flip the toggle on, respawn: the repo role applies.
