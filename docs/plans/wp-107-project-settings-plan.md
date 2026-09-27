# WP-107 — Project-level settings layer (+ per-project GitHub account)

## Goal
Settings can be set per project, and each one falls back to the global value and then to its default. The first
setting to use this is the GitHub account. Agents that wt-agents or wt-handoff spawns for project P run `gh` and
`git push` as P's account. The dashboard's gh calls for P use that account, and `./setup doctor` proves each account
works. No CLI or env var changes meaning.

## What research corrected
- **"Storage next to the existing config.mjs registry" — that registry is not in wt.db.** `KEYS` (`skills/wt-dashboard/config.mjs:12-32`) is stored in the env file `~/.config/wt-dashboard/env` (`server.mjs:43`), with secrets in the Keychain (`config.mjs:66-75`). `get()` (`:113`) reads "env var > Keychain > env file > legacy > default". The DB has no config. So the new `project_settings` table sits in wt.db and the global layer stays in the env file.
- **Board automation is already per project.** `boards` has the columns `auto, min_priority, dispatch, stall_min, report_room, report_orch` (`store.mjs:156-177`), read through `tickets.settings(project)` (`tickets.mjs:78-101`). Migrating it would move data that is already correctly scoped, and it would break the JSON rollback export. Decision: the resolver treats those keys as project scoped and backed by `boards`. They are **not** copied into `project_settings`, so there is nothing to lose. The ticket asked to "migrate it from the boards table"; this plan reads it where it lives instead, and exposes it on the same Projects page.
- **There is no "default room" setting.** The project room is the room named after the project (`rooms.mjs`). No global value exists to layer over, so it stays out of scope.
- **The integration branch is not stored anywhere.** `worktree.sh:2-43` resolves it, and dispatch and server hardcode `origin/main` (`dispatch.mjs:222-224`, `server.mjs:1074,1083`). This plan adds a `baseBranch` project key and uses it in dispatch and server. `worktree.sh` already honours `WT_BASE`, so the CLI side is untouched.
- **The dashboard's gh calls only query the default repo** (`REPO`: `server.mjs:934,940,944,1068,1115,1122`), and `ghLogin` is cached for the life of the process (`:1122`). "The dashboard's gh calls use the project's account" therefore means those calls get the default project's token, with the login cache keyed by account. Multi-repo PR listing is out of scope.
- **`GH_TOKEN` alone does not change `git push`.** The gh credential helper follows gh's active account unless `credential.https://github.com.username` is set. The per-repo git config is therefore a separate unit.
- **Reused panes keep their old env.** handoff reuses idle panes through `herdr agent prompt` (`handoff.sh:199-202`), so an env var set at spawn time can't follow a reuse into another project. Workers are already per repo (`<repo>-workers`, `agents.sh:66,96`), so a reused worker belongs to the same project. The one gap is an account changed after spawn, which is covered under Risks.
- **herdr can inject env.** `herdr tab create … --env KEY=VALUE` exists; `agent start` has no `--env`. The injection point is the `tab create` in `agents.sh:156-178`. The dashboard spawns through `AGENTS_SH` (`server.mjs:1020`), and handoff spawns through `agents.sh spawn` (`handoff.sh:~306`). Both routes therefore pass through the one place.
- **`setValue` accepts only absolute paths for plain keys** (`config.mjs:169`). A GitHub login needs its own validator.

## Approach
settled (headless, no synchronous user): **one scope table, one resolver.**
- The registry is `skills/wt-dashboard/project-settings.mjs`. It lists, for each key: `scope: 'project'|'overridable'`, its type/validator, its default, and its global source. The global source is a config.mjs key, a `routine_settings` key, or none.
- `resolve(project, key)` returns `{value, source: 'project'|'global'|'env'|'default'}`. An explicit process env var still wins, as `cfg.get` does today, because that keeps backward compatibility.
- Storage is migration stage 8 in `store.mjs`: `CREATE TABLE project_settings (project TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(project,key))`. It has no FK to `boards`, because a project can have settings before it has a board. Like the recent stages, it is not in the JSON rollback export.
- Global-only keys are unchanged: allowed hosts, bind and security, notifications, housekeeping, the TypeSafe/Linear keys, `WT_DASHBOARD_PROJECTS`, and `WT_DASHBOARD_REPO`.

Project keys in this ticket:

| key | scope | global fallback | readers switched |
|---|---|---|---|
| `githubAccount` | project | none (gh active account) | agents.sh spawn, server gh calls, doctor |
| `baseBranch` | project | none → `main` | dispatch.mjs, server.mjs origin/main sites |
| `mcp` | overridable | `WT_AGENTS_MCP` | agents.sh / handoff.sh via mcp-mode |
| `maxWorking` | overridable | `routine_settings.maxWorking` (4) | dispatch deps.maxWorking(project) |
| `WT_JEV_TICKET_TRIAGE`, `WT_JEV_ROUTE` (triage sites `server.mjs:1857,1903,1922` have a project) | overridable | env file | server `jevOn(key, project)` |
| other `WT_JEV_*` (`NEEDS_YOU`, `STALL`, `INBOX_RANK`, `ROOM_RESOLVE`…) | global | env file | unchanged. Call sites `server.mjs:433,439,1471,1954` have no project [review]. |
| board automation (6) | project | boards defaults | unchanged storage; shown on the page |
| `linearTeams` | — | stays global `WT_LINEAR_TEAMS` | already maps KEY→project, so there is nothing to layer |

Rejected: storing global values in the DB as well. That would give two global stores and break the env-file and
Keychain secrets path. Also rejected: copying the boards columns, for the reason given under What research corrected.

Shell readers use a small node CLI, `skills/wt-shared/scripts/project-setting.mjs get <key> [--project P|--cwd DIR]`.
It opens `${WT_DASHBOARD_DATA:-~/.local/share/wt-dashboard}/data/wt.db` **read-only**. It honours the same override as `store.mjs:244` (`process.env.WT_DASHBOARD_DATA ?? …`), so tests never read the live DB., because `store.mjs:2` says "The server is the only
writer". It resolves the project name via `git rev-parse --git-common-dir` basename, which is how both
`projectRoots` (`server.mjs:977-987`) and `agents.sh` do it. It prints the resolved value, or nothing, and always
exits 0 when the DB is missing. The dashboard writes; CLIs only read. Writes go through the API.

GitHub account flow:
- `agents.sh spawn`: if `githubAccount` resolves, then `tok=$(gh auth token --user "$acct")`. On failure it warns and spawns without the token, and never runs `gh auth switch`. On success it passes `--env GH_TOKEN=$tok` on `tab create`.
- git push: `agents.sh spawn` (idempotently) and the Projects page's save action set `git -C <main checkout> config credential.https://github.com.username <acct>`. That is repo-local and covers every worktree through the common dir.
- server: `ghEnv(project)` returns `{GH_TOKEN}` (from `gh auth token --user`, cached for 10 minutes) and is passed through `run()`'s existing `extraEnv` (`server.mjs:67`). `ghLogin` is cached per account.
- doctor: for each project that has a `githubAccount`, it checks that (a) `gh auth token --user A` succeeds, (b) `GH_TOKEN=… gh api user -q .login` equals A, which catches a wrong token in the keyring, and (c) `GH_TOKEN=… gh repo view <repo> --json name` succeeds. Failures are reported with `bad`.

## Implementation units
**U1 — store + resolver (wt-dashboard).** Adds migration stage 8, `project-settings.mjs` (the registry, `resolve`, `set`, `reset`, `list(project)`), and API routes `GET /api/projects/:p/settings` (each key's value, source and inherited value) and `PUT|DELETE /api/projects/:p/settings/:key`. The routes sit behind the same session and Origin checks as `/api/config`. Validators: a GitHub login matches `^[A-Za-z0-9-]{1,39}$`; a branch must pass `git check-ref-format --branch`; `mcp` is one of full/lean. Tests go in `project-settings.test.mjs`, which is added to `package.json` test list: project beats global beats default, reset falls back to inherited, an env var wins, invalid values are rejected, and the migration runs on an existing v7 DB.

**U2 — switch dashboard readers.** Switches four readers to the resolver:
- `jevOn(key, project)` at `server.mjs:1949` and its call sites that have a project.
- `deps.maxWorking(project)` in `dispatch.mjs:134`, with the wiring at `server.mjs:2564` (`maxWorking: () => routines.settings().maxWorking`) changed to resolve per project, keeping `routines.mjs` global.
- `baseBranch` at `dispatch.mjs:222-224` and `server.mjs:1074,1083`.
- `ghEnv` plus the per-account `ghLogin` on the gh calls.

Tests go in dispatch.test.mjs, with a project override of maxWorking and baseBranch.

**U3 — web: Settings › Projects.** Adds `web/src/projects-settings.tsx`. It shows one page per project, from the board list plus `projectRoots`. Each row shows its value with an "inherited from global/default", "overridden" or "locked by env var" badge (`source: 'env'`; the project value is shown but inactive) and a reset button. Board automation rows reuse the existing board settings calls. Links are added from the board header and the project header; the board Automation sheet stays and gains a "More project settings" link. There are no native dialogs (`noNativeDialogs.test.ts`). Checks: `npx tsc --noEmit -p .`, `npm run build`, and an agent-browser check at desktop and 390px.

**U4 — CLI reader + wt-agents/wt-handoff (one commit per skill).** Adds `wt-shared/scripts/project-setting.mjs` with a test. `agents.sh spawn` gets the GH_TOKEN `--env` and the credential username. `mcp-mode.sh` takes an optional `--cwd DIR`, resolves `mcp` through the CLI, and falls back to its current sed read. Both bare callers pass the cwd: `agents.sh:125` passes the spawn `$cwd`, and `handoff.sh:165` passes `$main`. Tests: extend `wt-agents/scripts/mcp.test.mjs`, or add `spawn-env.test.mjs` with a stubbed `herdr` and `gh` on PATH, and assert that `tab create` received `--env GH_TOKEN=tok` and that `gh auth switch` was never called.

**U5 — setup doctor.** Adds the per-project account checks described above. They run only when a project has an account set. doctor reads through `project-setting.mjs`, using a list mode (`list-accounts`) that prints `project\taccount\trepoPath`. Check: `./setup doctor` on this machine.

**U6 — docs.** Update `docs/features.md` (the Projects settings page, the scope rules, and the GitHub account) and the wt-agents SKILL.md note on GH_TOKEN.

## Files
- skills/wt-dashboard/store.mjs, project-settings.mjs (new), project-settings.test.mjs (new), server.mjs, dispatch.mjs, dispatch.test.mjs, package.json
- skills/wt-dashboard/web/src/projects-settings.tsx (new), settings.tsx, board.tsx, App.tsx (routes/links)
- skills/wt-shared/scripts/project-setting.mjs (new), project-setting.test.mjs (new), mcp-mode.sh
- skills/wt-agents/scripts/agents.sh, skills/wt-handoff/scripts/handoff.sh, skills/wt-agents/scripts/spawn-env.test.mjs (new), skills/wt-agents/SKILL.md
- setup
- docs/features.md

## Verification
- `cd skills/wt-dashboard && npm test`, and `cd web && npx tsc --noEmit -p . && npm run build`.
- `node --test skills/wt-agents/scripts/*.test.mjs skills/wt-shared/scripts/project-setting.test.mjs`.
- `./setup doctor`: with no account set, output is unchanged. With an account set for wt-pack (`rephol`), the three checks pass.
- Live check: set `githubAccount=rephol` for wt-pack via the API. `wt-agents spawn worker` a throwaway worker in a temp repo, then run `echo ${GH_TOKEN:+set}` and `gh api user -q .login` in it. Remove the worker afterwards. Never prompt real agents.

## Definition of Done
- Migration stage 8 exists, and the `project_settings` table is created on an existing DB with no loss of rows in other tables (tested).
- The resolver order project → global → default, plus the env-var override, is covered by passing tests.
- `agents.sh spawn` passes `GH_TOKEN` via `--env` when the project has an account, and never calls `gh auth switch` (tested with stubs).
- The dashboard's gh calls carry the project's token, and dispatch uses the project's maxWorking and baseBranch (tests).
- The Settings › Projects page shows inherited/overridden values with reset, and is linked from the board and project header (browser check, both widths).
- `./setup doctor` checks per-project accounts (login match plus repo reach).
- `docs/features.md` is updated. All listed test suites and tsc pass. Changes are committed one commit per skill.

## Risks and deferred
- A token is snapshotted into the pane env at spawn. Changing the account, or rotating the token, needs a respawn, and a reused worker keeps its old token. The page notes this. [unsourced: how long gh OAuth tokens stay valid here]
- `GH_TOKEN` is visible in the process env (`ps eww`). This is accepted for a local single-user machine, and it is the same exposure `gh` has via its keyring helper.
- Project key is a directory basename, so two repos with the same name collide. This is pre-existing and shared with `boards`.
- Deferred: multi-repo PR listing in the dashboard, and a default-room setting (there is no such concept today). The deferred physical migration of the boards columns is also deferred. Nothing in the DoD depends on these.
