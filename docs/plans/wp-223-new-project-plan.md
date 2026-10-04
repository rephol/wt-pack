# WP-223 — Dashboard: create a new project (existing folder, git clone, new empty repo)

## Goal
A **New project** action in the dashboard with three sources — (a) existing local git repo, (b) `git clone <url>`
into a parent dir, (c) `git init` a new empty repo — that persists the root, creates the project's room, optionally
spawns its orchestrator; plus **Remove/hide** a project. Update `docs/features.md`.

## What exists (evidence)
- Project list = `projectRoots()` (`skills/wt-dashboard/server.mjs:1207`): `REPO` + `cfg.list('WT_DASHBOARD_PROJECTS')`
  + every local agent's cwd, keyed by `basename(root)` from `git rev-parse --git-common-dir`. Cached 30 s under
  `'projectRoots'` (callers bust with `store.delete('projectRoots')`).
- Persisting a root already works: `PUT /api/config/WT_DASHBOARD_PROJECTS {value:[…]}` validates each with
  `repoRoot()` (`server.mjs:2714,2772`) then `cfg.setValue`. UI: Settings › Integrations list editor
  (`web/src/integrations.tsx:59`) with `POST /api/config/check-repo`. **So source (a) is ~done server-side**; the
  ticket's "no UI for it" is half-true — there's a settings list, no first-class action.
- `cfg.override(k)` → 409 when the key is set in the server env (`server.mjs:2764`); the new route must honour it too.
- Rooms: `rooms.create({ title, project, slug })` (`rooms.mjs:341`) returns the existing room if `slug` exists — idempotent.
- **Orchestrator cannot go through `spawnAgent`**: default roles have `orchestrator … spawn: null`
  (`roles.mjs:9`) and `spawnAgent` rejects roles without `spawn` (`server.mjs:1236`). Call
  `run(AGENTS_SH, ['spawn','orchestrator', root], root, 120_000, { WT_AGENTS_SPAWNED_BY: 'dashboard' })` directly,
  same output parse as `spawnAgent` (`name pane` last line). agents.sh applies the role floor (opus/low) itself
  (WP-157/160) — no `--model` from the dashboard.
- Agent-cwd projects can't be "removed" from config — they reappear while an agent sits there. Hence a hide list.

## Decisions (no synchronous question needed — all defaulted, recorded here)
1. **One route** `POST /api/projects {source:'existing'|'clone'|'init', path?, url?, parent?, name?, room?:bool, orchestrator?:bool}`
   and `DELETE /api/projects/:name` (hide). Session cookie + Host/Origin already guard every `/api/*` mutation
   (verify the new paths fall under the same gate at `server.mjs:~2227` — no `x-herdr-pane` exemption).
2. **Name rule**: `name` (clone/init) must match `/^[a-z0-9][a-z0-9_-]{0,31}$/` (herdr-safe; CLAUDE.md trap
   "capitalised repo dirs"). For `existing`, reject a root whose `basename` fails the rule with a clear message
   (rename the dir) — don't silently diverge the project key from the dir name, everything keys on `basename(root)`.
3. **Path validation** (new pure helper `projectPaths.mjs`, unit-tested): `resolve()` the path, require it under
   `homedir()` (realpath'd, so a symlink out is rejected), no NUL. clone/init: target = `join(parent, name)`,
   must not exist; parent must exist and be under $HOME. existing: must be a git repo (`repoRoot`) whose root is
   under $HOME. Duplicate name already in `projectRoots()` → 409.
4. **Clone URL**: allow only `https://host/…` and `git@host:path` / `ssh://…`; reject `file:`, `ext::`, `-`-leading,
   whitespace. Run `git clone --no-recurse-submodules -- <url> <target>` via `execFile` (no shell), env
   `GIT_TERMINAL_PROMPT=0`, `-c protocol.allow=never -c protocol.https.allow=always -c protocol.ssh.allow=always`,
   timeout 5 min. On failure remove the half-made target (only if we created it).
5. **Init**: `git init -b main <target>` then an empty initial commit (`git commit --allow-empty -m "Initial commit"`)
   so worktrees/branches have a base. Uses the user's global git identity; if missing, the commit fails → return
   the git error (don't invent an identity).
6. **Persist**: append root to `WT_DASHBOARD_PROJECTS` through the same `cfg.setValue` (409 if env-overridden),
   then `store.delete('projectRoots')`.
7. **Hide**: new list key `WT_DASHBOARD_HIDDEN_PROJECTS` in `config.mjs` `KEYS` (list ':'), names. `DELETE` removes
   the root from `WT_DASHBOARD_PROJECTS` if present and adds the name to the hidden list; `projectRoots()` drops
   hidden names. Re-adding via `POST` unhides. Never deletes files, the room, or tickets.
8. **Room**: default on → `rooms.create({ title: name, project: name, slug: name })`.
9. **Orchestrator**: default off (checkbox) — spawning costs an opus session.

## Units
1. **`skills/wt-dashboard/projectPaths.mjs` + test** — `validName`, `validCloneUrl`, `underHome(p, home)` (realpath
   of nearest existing ancestor). Test file `projectPaths.test.mjs` covering traversal (`~/../etc`), symlink out,
   `ext::`, `file://`, `-u…`, `Foo` name, ok cases. Picked up by `npm test`.
2. **Server** (`server.mjs`): `createProject(b)` / `hideProject(name)`, routes beside `/api/projects` GET
   (`server.mjs:3012`); hidden filter in `projectRoots()`; `HIDDEN` key in `config.mjs`. Server test (pattern of
   existing server tests) using a temp `$HOME`-like dir: init creates repo + commit, existing persists, hide hides,
   duplicate 409, bad url 400. No network clone in tests — clone tested only via URL validation + a `file:` reject.
3. **Web**: `web/src/newProject.tsx` dialog (Astryx; **no `window.confirm`** — `noNativeDialogs.test.ts`): source
   segmented control, fields per source, Room / Orchestrator switches, error toast. Entry points: a **New project**
   button in Settings › Projects (`projects-settings.tsx`) and a palette command (`commands.ts`). **Hide project**
   button on the Settings › Projects row with an in-app confirm. Invalidate `['projects']` query on success.
4. **Docs**: `docs/features.md` — new "Projects" bullets (sources, validation limits, hide semantics,
   `WT_DASHBOARD_HIDDEN_PROJECTS`).

Commits: one per skill touched (wt-dashboard), docs with it.

## Definition of done
- `cd skills/wt-dashboard && npm test` green incl. new `projectPaths.test.mjs` and server cases.
- `npx tsc --noEmit -p tsconfig.app.json` in `web/` clean; `npm run build`.
- Live: create a project via **init** in a temp dir under $HOME → it appears in `GET /api/projects` and a room named
  after it exists; hide it → gone from `GET /api/projects`; clean up the temp repo and room afterwards.
- Worker: no e2e writing or running (done check is unit tests + the live API check).

## QA brief
Screen: Settings › Projects at 412x700 and iPhone 13. Tap **New project** → choose *New empty repo*, parent
`~/tmp-wt-qa`, name `qa-proj`, Room on → Create. Sees: toast success; `qa-proj` in the project picker and a
`#qa-proj` room. Enter name `QA` → inline error "lowercase…". Clone with `file:///x` → error. Tap **Hide** on
`qa-proj` → in-app confirm → gone from the picker. Done when all four behave so; then delete `~/tmp-wt-qa`.

## Risks
- Restricting to $HOME may exclude repos on external volumes `[unsourced: user setup]` — the existing settings list
  still accepts any path, so nothing regresses.
- Server restart required for the server change (`npm run service:restart`, once).
