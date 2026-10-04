# WP-228 — Dashboard Sessions page: list/search Claude Code sessions, resume into a herdr pane, pin

## What research found

- **`ccsessions --json`** (`~/.local/bin/ccsessions`, the user's Python script) prints a JSON **array** of rows
  `{ id, cwd, proj, tldr, doing, mtime (epoch s), live, started (ISO), agent, ago, frozen, closed, started_local }`
  (checked on this machine: 2 442 rows). It takes **~5.6 s** (`time ccsessions --json`), so the server must
  never call it per request: cache it.
- **`ccsessions --help` is not help** — it renders the interactive list and waits on a `Resume #` prompt. Never
  call it (or the bare command) from the server; only `--json`.
- Pins: `freeze`/`thaw` store `{ [id]: { note, at, proj } }` in `~/.claude/ccsessions-frozen.json`
  (`FROZEN = …` at the top of the script; `_mark`, L241-249). `freeze [N]` resolves N against the *last
  interactive listing* first (`_resolve_sid`, L218-232), so shelling out `ccsessions freeze <id>` with a
  numeric-looking id prefix can pin the wrong session. **Decision: the dashboard reads and writes that JSON file
  directly**, same shape; that keeps the CLI and the page in sync and works without ccsessions installed.
- Transcripts live at `~/.claude/projects/<dir>/<id>.jsonl`; the server already has `PROJECTS`
  (`server.mjs:636`) and `findTranscript(id)` (`server.mjs:638`).
- **Resume path exists**: `agents.sh spawn <role> <cwd> --label <name> --resume <id>`
  (`skills/wt-agents/scripts/agents.sh:120-128`, respawn's WP-125 flags; L289-290 append `--name <label>
  --resume <id>`). Spawn applies the role floor (WP-157/160) and naming, as the ticket asks. The server already
  calls `run(AGENTS_SH, ['spawn', …], cwd, 120_000, { WT_AGENTS_SPAWNED_BY: 'dashboard' })` (`server.mjs:1243`).
  Note `agents.sh` L404: a session with no transcript dies on `--resume`; the server checks `findTranscript`
  first (the watchdog's `resumeExited` does the same, `server.mjs` ~L3425).
- Web pages are a `Page` union + hash router in `web/src/App.tsx` (L238 type, L316 hash → page, L461 nav list,
  L524 render, e.g. `<RoutinesPage …/>`).

## Decisions

1. **Source**: `ccsessions --json` when `which ccsessions` succeeds, else a built-in reader. Either way the
   server holds one cached list (refresh at most every 60 s, in the background — a request gets the last list
   immediately; first request waits). `[unsourced: 60 s is a judgement.]`
2. **Built-in reader** (`skills/wt-dashboard/sessions.mjs`, new, pure where possible): for each
   `PROJECTS/*/*.jsonl`, newest 500 by mtime: `id` = basename, `mtime`, and from the first 64 KB: `cwd` (first
   line carrying `cwd`), `started` (first `timestamp`), `tldr` (first user text message, 200 chars, skipping
   lines that start with `<command-` or `<local-command`). `proj` = basename of `cwd`. `live` = an agent in
   `agents()` with `session === id`. Same field names as ccsessions so the web code has one shape.
   ponytail: newest-500 cap; paging when someone needs older.
3. **Pins** from `~/.claude/ccsessions-frozen.json` in both modes (overlay `frozen` onto rows); `POST
   /api/sessions/:id/pin {note?}` / `DELETE /api/sessions/:id/pin` write it (read → modify → write; missing file
   = `{}`).
4. **Resume**: `POST /api/sessions/:id/resume { role }`. Server validates `id` against a UUID regex, takes
   `cwd` **from its own row, never the client**, requires `existsSync(cwd)` and `findTranscript(id)`, refuses
   when the row is `live` (409, "already running"), `role` must match `/^[a-z][a-z0-9-]{0,31}$/` (agents.sh
   validates the role itself: base role or persona, `agents.sh:131-140`), else 400. Label: the row's `agent` when it looks like
   a pool name (`/^[a-z0-9_-]{1,32}$/`) and no live agent holds it; otherwise no `--label` (spawn names it).
   Default role in the UI: parsed from the agent name (`<repo>-<role>-NN`), else `worker`.
5. **Search** client-side over `proj`, `tldr`, `doing`, `id` (the list is already in memory); project filter =
   the page's existing project scope. Frozen rows first, then by `mtime` desc; `closed` rows hidden behind a
   toggle.
6. Security unchanged: routes sit behind the existing session cookie + Host/Origin checks like every `/api/*`.

## Units

### Unit 1 — `skills/wt-dashboard/sessions.mjs` + `sessions.test.mjs`
`parseHead(text)` → `{ cwd, started, tldr }`; `listBuiltin(projectsDir, limit)`; `readPins(file)` /
`writePin(file, id, pin|null)`; `overlay(rows, pins, liveIds)`; `isUuid`; `roleFromAgent(name)`.
Tests: a temp dir with two fake `.jsonl` (one starting with a `<command-name>` user line) → right
`cwd/tldr/started`, newest first; pin then unpin round-trips the JSON file and keeps other entries;
`roleFromAgent('wt-pack-worker-07') === 'worker'`, `roleFromAgent('foo') === null`.

### Unit 2 — server routes, `server.mjs`
`GET /api/sessions` → `{ source: 'ccsessions'|'builtin', rows }` (cache per decision 1; ccsessions run with
`execFile`, 30 s timeout, `maxBuffer` 64 MB, JSON parse failure → fall back to builtin for that refresh);
`POST|DELETE /api/sessions/:id/pin`; `POST /api/sessions/:id/resume` (decision 4), then `store.delete('agents:local')`
and invalidate the cache's `live` flags. Route next to the others (~L3002).

### Unit 3 — web page, `web/src/sessions.tsx` + `App.tsx`
`SessionsPage` (TanStack Query on `/api/sessions`): search box, closed toggle, rows `proj · ago · id[:8] ·
tldr`, a ● when live, pin toggle, Resume button opening an inline role select + confirm (no native dialogs —
`noNativeDialogs.test.ts`). Add `'sessions'` to `Page`, the hash map, the nav list and the render switch.
Mutations invalidate `['sessions']` and `['agents']`.

### Unit 4 — docs
`docs/features.md`: a Sessions page entry (source, pin file shared with ccsessions, resume = agents.sh spawn).

## Definition of Done
- `cd skills/wt-dashboard && npm test` passes (includes `sessions.test.mjs` and the web typecheck).
- `npm run build` in `web/` succeeds; with the server running, `curl -s -b <cookie> localhost:<port>/api/sessions | jq '.rows|length'` > 0
  and `.source` is `ccsessions` on this Mac.
- agent-browser (`--session <agent name>`), 390x844 and desktop: `#sessions` lists rows, search narrows them,
  pin moves a row to the top and `~/.claude/ccsessions-frozen.json` gains its id (unpin removes it).
- Resume verified only on a **throwaway** session made in a temp repo (`claude -p hi` in a `mktemp -d` git repo),
  never on a real agent's session (CLAUDE.md traps); the spawned pane is removed afterwards with
  `agents.sh rm <name>`.
- One commit per skill touched; `docs/features.md` updated in the same merge.

## QA brief
Screen: Sessions tab. Taps: type a project name in search → only that project's rows; tap pin on a row → it
jumps to the top with a pin mark; tap Resume on the throwaway session → choose worker → confirm → a new agent
appears on the Agents page in that session's cwd. Done check: those three behave at 412x700 and iPhone 13.
No e2e writing or running — the done check is not an e2e test.

## Out of scope
Closing/reopening sessions, `tbe watch`, remote machines (local `~/.claude/projects` only).
