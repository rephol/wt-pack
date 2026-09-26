# WP-21 — wt-dashboard storage on SQLite (node:sqlite)

## Goal

Tickets, rooms (index + messages) and the notifications inbox move from per-file JSON/JSONL under
`~/.local/share/wt-dashboard/data/` into one SQLite file, `data/wt.db`, opened with Node's built-in
`node:sqlite` (`DatabaseSync`). No new dependency. Existing data is imported once on first start, the originals
are moved into a dated backup folder, and a `store.mjs export` command writes the DB back to the old layout so a
rollback to the previous commit loses nothing. Rollout is staged: tickets first, rooms and notifications second.

## What research corrected / established

- **Nothing outside the server touches these files.** `wt-ticket` goes through the API only
  (`wt-ticket/scripts/wt-ticket:37` `show() { call GET "/api/tickets/$1…"`), as does the room CLI
  (`wt-room/scripts/room:21` `call "$API/api/rooms/$slug/messages…"`). A grep of every skill dir, `setup`, and the
  Tauri `main.rs` for `tickets/`, `rooms.json`, `/rooms/`, `notifications.jsonl` finds only `wt-dashboard/*.mjs`,
  its tests and docs (`README.md:35`, `SKILL.md:15`). The `notifications` hit in `wt-memory/mcp/server.mjs:51` is
  MCP protocol notifications, unrelated. So the store swap is invisible to every CLI; no CLI change.
- **The warning cannot be silenced with a flag in every launch path.** Node 22.22.3 (installed) prints
  `ExperimentalWarning: SQLite is an experimental feature` on load. The service plist passes no flags
  (`scripts/service.mjs:38` `ProgramArguments … node, server.mjs`), and the desktop app runs a SEA sidecar built
  by esbuild as **CJS** (`app/scripts/build-sidecar.sh:8` `--format=cjs`), which rules out top-level `await import`.
  Verified in this session: wrapping `process.emitWarning` around
  `process.getBuiltinModule('node:sqlite')` loads `DatabaseSync` with no warning, and esbuild 0.25 leaves that
  call untouched in a CJS bundle.
- **Node floor is currently 22.12** (`setup:46` `a===22&&b>=12`, `setup:76` `node >= 22.12`). `node:sqlite` loads
  without `--experimental-sqlite` only from 22.13 [unsourced: Node changelog, not read this session; the
  implementer confirms with `node -e "process.getBuiltinModule('node:sqlite')"` on 22.12 vs 22.13 if one is at hand,
  else trusts the doc]. `process.getBuiltinModule` needs ≥22.3, so 22.13 covers both.
- **`server.mjs` is imported by tests** (`parse.test.mjs:4` `import { parsePane, … } from './server.mjs'`), and the
  stores are constructed at module top level (`server.mjs:1327` `new Inbox(...)`, `:1689` `new Tickets(...)`,
  `:1734` `new Rooms(...)`). Opening the DB in a constructor would make `npm test` open the user's real
  `data/wt.db`. The DB must open lazily on first use (same pattern as today's `load()`).
- **Housekeeping reads room files directly** to find upload references (`housekeeping.mjs` step 1:
  `for (const r of ctx.rooms ?? []) if (!r.archived) refs += await readFile(r.file…)`, fed by
  `server.mjs:2280` `rooms: rooms.index.map((r) => ({ file: join(DATA, 'rooms', …) }))`) and compacts the inbox
  by rewriting the JSONL (`inbox.mjs` `compact()`). Both change in U3/U4.
- Live data is small: `notifications.jsonl` 392K, `rooms/` 308K (4 rooms), `tickets/` 40K (1 board). Import is
  one transaction; no batching needed.

## Approach

- **One module, `wt-dashboard/store.mjs`**: loads `DatabaseSync` quietly, opens `data/wt.db` with
  `journal_mode=WAL`, `busy_timeout=5000`, `foreign_keys=ON`, runs migrations, exposes `db()` (lazy singleton per
  path) and `tx(fn)` (`BEGIN IMMEDIATE … COMMIT`/`ROLLBACK`). Migrations are an array of SQL strings applied in
  order under `PRAGMA user_version` — no migration table.
- **Documents, not normalised rows.** Each ticket / room / message / notification is stored as its existing JSON
  object in a `json` column, plus the few columns queries need (id, project, room, ts). The API shapes do not
  change, so the web app, CLIs and existing tests of the API stay valid. `ponytail:` normalise a field only when a
  query needs it.
- **Single writer = the server.** Verified above that CLIs go through the API. `DatabaseSync` is synchronous, so
  the in-process locks in `tickets.mjs` (`lock()`, `__keys__`) and `inbox.mjs` (`write()` queue) become
  transactions. WAL + busy_timeout covers a second process opening the file (e.g. `npm run dev` while the service
  runs: that server fails `listen` on the port; because the DB opens lazily and every writer path runs only after
  listen or a request, it never writes).
- **Schema (migration 1 — tickets):**
  `boards(project TEXT PRIMARY KEY, key TEXT UNIQUE NOT NULL, next INTEGER NOT NULL)`;
  `tickets(id TEXT PRIMARY KEY, project TEXT NOT NULL REFERENCES boards, seq INTEGER NOT NULL, json TEXT NOT NULL)`
  with index on `(project, seq)`.
  **Migration 2 — rooms + notifications:**
  `rooms(slug TEXT PRIMARY KEY, pos INTEGER NOT NULL, json TEXT NOT NULL)`;
  `messages(seq INTEGER PRIMARY KEY, room TEXT NOT NULL, id TEXT NOT NULL, json TEXT NOT NULL)` with
  `UNIQUE(room, id)`; `notifications(seq INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL, json TEXT NOT NULL)`.
  `delivered` records and inbox `update` lines stop being appended; they become `UPDATE … SET json` on the row.
- **One-time import** (`importLegacy(dataDir)` in `store.mjs`, per stage): runs inside the migration's
  transaction, only when the table is empty and the legacy files exist. Tickets: each `tickets/<p>.json` →
  `boards` + `tickets` (keeps `key`, `next`, ids). Rooms: `rooms.json` order → `rooms.pos`, each
  `rooms/<slug>.jsonl` folded exactly as `Rooms.messages()` folds today (delivered lines merged into
  `deliveredTo`/`undelivered`, torn lines skipped). Notifications: folded as `Inbox.load()` does. After commit
  the imported files are **moved** to `data/pre-sqlite-<ISO>/` (same relative paths), so nothing can read stale
  JSON and the backup is complete. A crash between commit and move is safe: next start sees non-empty tables
  and skips import, and a `store.mjs` start-up check logs any leftover legacy files still in place.
  `*.corrupt-*` quarantine files are moved too (they are only meaningful to the old salvage code).
- **Rollback:** `node wt-dashboard/store.mjs export [--to <dir>]` writes `tickets/<p>.json`, `rooms.json`,
  `rooms/<slug>.jsonl` (one folded line per message) and `notifications.jsonl` (one folded line per item) — the
  formats the old code reads. Rollback = stop the service, `export --to data/`, move `wt.db*` aside,
  check out the previous commit, restart. Documented in `wt-dashboard/README.md`.
- **Out of scope (settled by assumption, no synchronous user):** `settings.json`, `housekeeping.json`,
  `terminals.json`, `roles.json`, `agent-tags.json`, `unfurl-cache.json`, `sent-hashes.log`,
  `terminal-audit.jsonl` stay files — the ticket names tickets, rooms and notifications only. Rejected: moving
  everything at once (larger blast radius, no ask).
- Rejected: `better-sqlite3` (a native dependency, ticket forbids); keeping JSON with fsync hardening (the
  ticket's user-approved decision is SQLite).

## Review corrections (binding — override unit text below where they differ)

1. **Orphan room files:** rooms import runs `reconcileIndex(index, readdir('rooms'))` (`rooms.mjs:211-216`) before
   inserting, so a `rooms/<slug>.jsonl` absent from `rooms.json` still gets a room row. Test with an orphan file.
2. **Export never imports:** `export` opens `wt.db` with `new DatabaseSync(f, { readOnly: true })`, runs no
   migrations and no import, exits non-zero if `wt.db` is missing, and resolves the data dir exactly as
   `server.mjs:45-46` (`WT_DASHBOARD_DATA ?? ~/.local/share/wt-dashboard`, then `/data`).
3. **Move is resumable, not just logged:** inside `open()`, if `user_version` ≥ a stage and that stage's legacy
   files are still in `data/`, finish moving them into the newest `pre-sqlite-*` (idempotent). Test: import, skip
   the move (injected failure), reopen → files moved, no re-import.
4. **`tx(fn)` is synchronous:** `fn` must not be async; `tx` throws if it returns a thenable. Store methods do
   all DB work synchronously inside `tx`; no `await` between `BEGIN` and `COMMIT`.
5. **Test rewrites U4 owns:** `parse.test.mjs:302-313` (`new Inbox(<file>.jsonl)`, `box.file`) and
   `housekeeping.test.mjs:33-65` (jsonl inbox fixture) move to a temp data dir + DB.
6. **Housekeeping inbox summary** reports `dropped` count only (row deletes do not shrink `wt.db`); drop the
   `bytes` figure for the inbox step.
7. **Nothing at import time:** `store.mjs` does no I/O on module load; the leftover-file check is inside `open()`.
8. **Corrupt ticket files are salvaged, not dropped:** tickets import keeps `salvage()`'s logic
   (`tickets.mjs:97-104`) for `<p>.json.corrupt-*`: key and highest id feed `boards.key/next` when no clean board
   exists, and a warning is logged naming each corrupt file moved to backup.
9. **Rollback re-forward:** on open, if any legacy file in `data/` has an mtime newer than `wt.db`, log a loud
   `server.log` line ("legacy JSON newer than wt.db — rolled back? see README") and do not import. README rollback
   recipe keeps "move `wt.db*` aside" as a required step.
10. **Sidecar Node check:** `app/scripts/build-sidecar.sh` fails early unless `node` ≥ 22.13 (same check as
    `setup:46`). Add it to U1's files.
11. **Inbox coverage:** `clear()` and `resolve()` go through `patch()`; the in-memory `items` array is the
    single-process cache (the server is the only writer), updated in the same call as the DB write.
12. **Unsourced items:** sidecar smoke uses the env pattern of `tickets.test.mjs:132` (`PORT`, `WT_DASHBOARD_DATA`,
    `HOME` in a temp dir). The 22.13 floor stays `[unsourced]` until checked as described above.

## Implementation units

### U1 — store module, warning, node floor
Files: `wt-dashboard/store.mjs` (new), `wt-dashboard/store.test.mjs` (new), `wt-dashboard/app/scripts/build-sidecar.sh`, `wt-dashboard/package.json`
(add `store.test.mjs` to `test`), `setup`.
- `store.mjs`: quiet load (wrap `process.emitWarning` only around `process.getBuiltinModule('node:sqlite')`,
  filtering messages matching `/SQLite/`, restored immediately), `open(file)`, `tx(db, fn)`, `MIGRATIONS` array
  with migration 1 only, `user_version` runner, CLI entry (`export`) guarded by `process.argv[1]`.
- `setup`: `node_ok` → `b>=13`; doctor line `node >= 22.13`; add a doctor check
  `node -e "process.getBuiltinModule('node:sqlite')"` → `ok "node:sqlite"` / `bad "node:sqlite unavailable — node >= 22.13"`.
- Verify: `store.test.mjs` — migrations run once (reopen keeps `user_version`), `tx` rolls back on throw,
  and a child `node -e "import('./store.mjs').then(s=>s.open(':memory:'))"` writes nothing to stderr (no
  ExperimentalWarning). `./setup doctor` prints the node:sqlite line.

### U2 — tickets on the store (stage 1)
Files: `wt-dashboard/tickets.mjs`, `wt-dashboard/tickets.test.mjs`, `wt-dashboard/store.mjs` (import + export
for tickets).
- `Tickets` keeps its constructor (`{ dir, reserved, log }`) and every public method's signature and return
  shape; internally `this.db` opens lazily at `join(dir, 'wt.db')`. `read/save/salvage/lock/boards cache`
  are replaced by queries; `board()` key allocation runs in `tx`; `create()` does `next` bump + insert in one
  `tx`; `mutate()` reads, applies `fn`, no-op check as today, writes in one `tx`. `projects()`/`keys()` read
  `boards`. The corrupt-file quarantine and `salvage()` are deleted (SQLite replaces them); their tests are
  replaced by import tests.
- Import: `tickets/*.json` → tables on first open; files moved to `pre-sqlite-<ISO>/tickets/`.
- Verify: existing `tickets.test.mjs` cases for create/list/patch/comment/claim/key derivation pass unchanged
  in behaviour; new cases: import of a fixture board keeps ids, `next`, history; second open does not re-import;
  legacy files end up under `pre-sqlite-*`; `export` round-trips to JSON that the pre-change `Tickets` shape
  expects (`{ key, next, tickets }`).
- **Stage gate:** ship U1+U2, `npm run service:restart` once, confirm `wt-ticket list` shows WP-1…WP-21 and
  `data/pre-sqlite-*/tickets/wt-pack.json` exists. Only then U3.

### U3 — rooms on the store (stage 2)
Files: `wt-dashboard/rooms.mjs`, `wt-dashboard/store.mjs` (migration 2, rooms import/export),
`wt-dashboard/parse.test.mjs` (room cases), `wt-dashboard/housekeeping.mjs`, `wt-dashboard/housekeeping.test.mjs`,
`wt-dashboard/server.mjs` (housekeeping call).
- `Rooms.load()` reads `rooms` ordered by `pos`; `saveIndex()` upserts all rows in one `tx` (index is ≤ tens of
  rows); `messages(slug)` selects by room ordered by `seq`, still cached in `this.msgs`; `append()` of a message
  inserts; the `delivered` path updates the message row's json (and the cached object as today); `delete`
  removes the room row and its messages. `reconcileIndex` and the `rooms.json.corrupt` path go (DB is the
  index). `settings.json` stays a file (`atomicWrite` stays exported — `tickets.mjs` no longer needs it).
- Housekeeping: replace `ctx.rooms: [{file, archived}]` with `ctx.roomRefs: string` — the server passes the
  concatenated json of messages in non-archived rooms (`SELECT m.json FROM messages m JOIN rooms r … WHERE
  json_extract(r.json,'$.archived') IS NOT 1`). `housekeeping.test.mjs` passes that string instead of files.
- Verify: parse.test room cases (post, delivered folding, archive, delete) pass against a temp dir; import of a
  fixture `rooms.json` + two jsonl files (one with a `delivered` line and a torn line) reproduces the same
  `messages()` output as the old fold; housekeeping keeps an upload referenced by a live room and deletes one
  referenced only by an archived room.

### U4 — notifications on the store (stage 2)
Files: `wt-dashboard/inbox.mjs`, `wt-dashboard/store.mjs` (notifications import/export),
`wt-dashboard/parse.test.mjs` (inbox cases), `wt-dashboard/housekeeping.mjs`, `wt-dashboard/housekeeping.test.mjs`,
`wt-dashboard/server.mjs:1327`.
- `new Inbox(file)` → `new Inbox(dir)` (DB at `join(dir,'wt.db')`); `items` stays an in-memory array loaded in
  `load()` (server code reads `inbox.items` directly at `server.mjs:776,1385,1409,1417,1431`, so keep it).
  `add` inserts, `patch` updates rows in one `tx`, `compact(drop)` deletes rows in one `tx` and returns
  `{dropped, bytes}` where bytes = summed json length of dropped rows; the `guard` option is removed and
  housekeeping stops passing it. Add `PRAGMA incremental_vacuum` only if `wt.db` measurably grows — not now.
- Verify: parse.test inbox cases (dedupe window, resolve, clear, open count) pass; import of a fixture jsonl
  with update lines folds as `load()` did; housekeeping compacts old resolved items.

### U5 — docs
Files: `wt-dashboard/README.md`, `wt-dashboard/SKILL.md`, `CLAUDE.md` (wt-dashboard data line).
- Data section names `data/wt.db` (tickets, rooms, notifications), `pre-sqlite-*/` backup, the rollback recipe,
  and node ≥ 22.13. CLAUDE.md: one line under wt-dashboard.

## Files

- new: `wt-dashboard/store.mjs`, `wt-dashboard/store.test.mjs`
- modified: `wt-dashboard/tickets.mjs`, `wt-dashboard/tickets.test.mjs`, `wt-dashboard/rooms.mjs`,
  `wt-dashboard/inbox.mjs`, `wt-dashboard/app/scripts/build-sidecar.sh`, `wt-dashboard/housekeeping.mjs`, `wt-dashboard/housekeeping.test.mjs`,
  `wt-dashboard/parse.test.mjs`, `wt-dashboard/server.mjs`, `wt-dashboard/package.json`,
  `wt-dashboard/README.md`, `wt-dashboard/SKILL.md`, `setup`, `CLAUDE.md`

One commit per skill touched (CLAUDE.md rule): `setup` belongs to wt-setup (repo root script) and `CLAUDE.md`
is repo-level — commit them separately from wt-dashboard.

## Verification

- `cd wt-dashboard && npm test` green after each unit.
- `./setup doctor` shows `node >= 22.13` ok and `node:sqlite` ok.
- `server.log` after restart has no `ExperimentalWarning` line.
- Sidecar: `cd wt-dashboard && npm --prefix app run sidecar` builds, and
  `WT_DASHBOARD_DATA=$(mktemp -d) WT_DASHBOARD_SERVE=1 app/src-tauri/binaries/wt-dashboard-server-aarch64-apple-darwin`
  starts and serves `GET /api/tickets/keys` [unsourced: exact env/port needed to hit it; implementer adapts].
- After each stage restart (once): board, room messages and inbox in the dashboard match the pre-restart view
  (agent-browser, `--session <agent name>`).

## Definition of Done

1. `wt-dashboard/store.mjs` exists; `data/wt.db` holds `boards`, `tickets`, `rooms`, `messages`,
   `notifications`; `PRAGMA user_version` = 2.
2. `grep -n "tickets/\|rooms.json\|\.jsonl\|notifications.jsonl" wt-dashboard/{tickets,rooms,inbox}.mjs` finds
   only import/export code paths in `store.mjs` — none in the three stores.
3. Live data: `~/.local/share/wt-dashboard/data/pre-sqlite-*/` contains the former `tickets/`, `rooms.json`,
   `rooms/`, `notifications.jsonl`; `wt-ticket list` and `room read wt-pack` return the same content as before.
4. `node wt-dashboard/store.mjs export --to <tmp>` produces files the old format describes (tested in
   `store.test.mjs`/`tickets.test.mjs`).
5. `npm test` green; `./setup doctor` reports node:sqlite; no ExperimentalWarning in `server.log` after restart.
6. README/SKILL.md/CLAUDE.md describe `wt.db`, backup and rollback.

## Risks and deferred

- `node:sqlite` is experimental; an API change in a later Node major could break `store.mjs`. Contained to one
  module; the doctor check surfaces it.
- `nvm` users on an older default Node: the service picks node from the login PATH (`service.mjs:56`); doctor
  flags <22.13 but does not fix it.
- Rooms' `saveIndex()` upserting every row is O(rooms) per change — fine at tens of rooms.
- Deferred: moving `settings.json` and the other small JSON files; normalised columns / FTS for message
  search; a DB size housekeeping step (`VACUUM`).
