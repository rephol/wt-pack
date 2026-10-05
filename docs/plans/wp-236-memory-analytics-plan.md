# WP-236 — wt-dashboard: wt-memory analytics

## Goal

Settings › Memory gains an **Analytics** block so the user can see whether memories pay off: how many are
written per day (by scope and by author agent), how often memory reaches a session (session-start injections
and WP-235 per-prompt recalls per day), which memories are recalled most and which never (pruning
candidates), and how many global proposals wait for approval. Aggregated server-side from files, no Claude API.

## What research corrected

- **The read log does not exist yet.** `~/.local/share/wt-memory/` is absent on this machine (`ls` → No such
  file or directory), and WP-235 is `[building]` with no commits on `wp-235-prompt-recall`
  (`git log main..wp-235-prompt-recall` is empty). Its schema is unwritten. This plan therefore **defines the
  line format** both tickets write (below) and the reader tolerates a missing file and unknown lines.
- **WP-235 logs recalls only; nothing logs session-start injections.** The WP-235 ticket says "Log each recall
  (session, ids)". Session-start injection happens in
  `skills/wt-memory/claude-plugin/hooks/inject.mjs` (`if (event === 'SessionStart') text = [ctx, how, rooms, wtm]…`),
  which writes no log. The "injections per day" series needs this ticket to add that line.
- **Injected context carries no ids.** `wt-memory context` strips trailers (`skills/wt-memory/scripts/wt-memory:32`
  `const strip = (s) => s.replace(/ *<!-- wtm:[^>]*?-->/g, '')`), and every SessionStart injects every entry, so
  injections are counted, not attributed. Most/never-recalled is computed from WP-235 `recall` lines only.
- **"by= at=" markers are per entry, day precision.** Trailer is `<!-- wtm:id=… by=… at=YYYY-MM-DD -->`
  (`wt-memory:105` `line`; `today()` = `toISOString().slice(0, 10)`), and `wt-memory list --json` already
  returns `{id, scope, name, by, at, text, pending?}` (`wt-memory:188-189`). Hand-written lines without a
  trailer are not entries and are not counted. Forgotten entries vanish, so "written per day" counts
  **surviving** entries only [known limit, stated in the UI].

## Approach

**Read log contract** (`~/.local/share/wt-memory/reads.jsonl`, override `WT_MEMORY_READS`), one JSON object per
line: `{"at":"<ISO timestamp>","session":"<session_id>","kind":"inject"|"recall","ids":["6-hex", …]}`. `ids` is
`[]` for `inject`. WP-235 writes `kind:"recall"`; this ticket writes `kind:"inject"` from inject.mjs on
SessionStart only (an UPS "Preferences updated" re-injection is not a session start). Appends are best-effort
inside the existing outer `try {}` and never delay the hook. Post this contract to WP-235 as a ticket comment
before writing code, so both writers agree; if WP-235 has merged by then with a different shape, the reader
follows WP-235's shape and the plan's inject line matches it.

**Aggregation** in a new `skills/wt-dashboard/memstats.mjs` (pure function `memStats(entries, readsText, {days})`,
tested in `memstats.test.mjs`), called from a new branch in `memoryApi` (`server.mjs:1047`):
`GET /api/memory/stats?days=30` (behind the same `hasSession` check that opens `memoryApi`). Entries come from
the existing `memoryEntries()` (`server.mjs:1033`, runs `wt-memory list --json`); the read log is read with
`readSafe` and capped to its last 5 MB [unsourced cap; protects the 2 s-ish request]. Output:

```
{ days: [{ day, written: {global, role, project}, inject, recall }],   // last N days, zero-filled
  byAgent: [{ by, count }],                                          // written in window, desc
  top: [{ id, text, scope, name, recalls, lastAt }],                 // ≤10, recalls desc
  never: [{ id, text, scope, name, by, at }],                        // live, non-pending, 0 recalls ever, written ≥7 days ago
  pending: number, logPresent: boolean }
```

Alternatives that lost: aggregating in the browser (ships the whole log to the client, against the ticket's
"server-side"); a new SQLite table in `wt.db` (a second copy of a log wt-memory owns); a new top-level page
(Settings › Memory is where these entries are already managed and forgotten, so pruning acts in place).

**UI**: `MemoryStats` component in `web/src/memory.tsx`, rendered in `MemorySection` above `<Entries>`: a
compact per-day table/bars for the window (written by scope, inject, recall), "By agent" list, "Most recalled"
and "Never recalled" lists (never-recalled rows get the existing Forget action), a pending count. When
`logPresent` is false show one supporting line "No read log yet — recalls appear once WP-235's recall hook
runs" instead of empty charts. Use Astryx components already imported in that file; no chart library.

## Implementation units

**U1 — inject log line** (`skills/wt-memory/claude-plugin/hooks/inject.mjs`, `skills/wt-memory/scripts/wt-memory.test.mjs`, which already drives inject.mjs
else `skills/wt-memory/scripts/wt-memory.test.mjs`). On SessionStart, after `out(text)`, append
`{at, session, kind:'inject', ids:[]}` to the read log (mkdir -p). Verify: a test runs inject.mjs with a
SessionStart payload and `HOME`/`WT_MEMORY_READS` pointed at a temp dir and asserts one `inject` line; an
UserPromptSubmit payload writes none. Commit: `wt-memory: WP-236 …`.

**U2 — aggregation + route** (`skills/wt-dashboard/memstats.mjs`, `memstats.test.mjs`, `server.mjs`). Verify:
`memstats.test.mjs` covers zero-filled days, scope split, by-agent, top ordering, never-recalled excludes
pending and entries younger than 7 days, malformed/unknown log lines skipped, missing log → `logPresent:false`.
`npm test` in `skills/wt-dashboard` passes.

**U3 — UI + docs** (`skills/wt-dashboard/web/src/memory.tsx`, `docs/features.md` Settings › Memory bullet
near line 426, and the wt-memory section near line 701 for the log). Verify: `npx tsc --noEmit -p
tsconfig.app.json` in `web`, `npm run build`, then agent-browser (`--session <agent name>`) on Settings ›
Memory shows the Analytics block. Commit: `wt-dashboard: WP-236 …`.

Commits: one for wt-memory (U1), one for wt-dashboard (U2+U3, plus docs) — per "one commit per skill touched".

## Files

- `skills/wt-memory/claude-plugin/hooks/inject.mjs`
- `skills/wt-memory/scripts/wt-memory.test.mjs` (or a new inject test beside inject.mjs)
- `skills/wt-dashboard/memstats.mjs` (new)
- `skills/wt-dashboard/memstats.test.mjs` (new)
- `skills/wt-dashboard/server.mjs`
- `skills/wt-dashboard/web/src/memory.tsx`
- `docs/features.md`

## Verification

As listed per unit. No e2e writing or running. Server change needs one `npm run service:restart` at the end
(not repeatedly).

## Definition of Done

- A SessionStart through inject.mjs appends one `kind:"inject"` line to the read log; UserPromptSubmit does not.
- `GET /api/memory/stats` returns the shape above, 403 without a session; `memstats.test.mjs` passes inside `npm test`.
- Settings › Memory shows Analytics: per-day written (by scope) / inject / recall, by-agent, most- and
  never-recalled (with Forget), pending count; a no-log state when the file is absent.
- `docs/features.md` documents the Analytics block and the read log format.
- WP-235 carries a comment with the read-log contract.

## QA brief

Open the dashboard → Settings › Memory at 412x700 and iPhone 13. See the Analytics block above the entries
list: a per-day row for today with a non-zero inject count after starting any agent session, an author list
naming wt-pack-orchestrator-01, a pending count of 0, and (until WP-235 ships) the "No read log yet" line or
empty recall columns. Tap Forget on a never-recalled row → it leaves the list. Done when all of that renders
without overflow at both sizes.

## Risks and deferred

- WP-235 may land a different log shape; the reader must follow whichever merged first (stated in Approach).
- Written-per-day undercounts forgotten memories — no write log exists; deferred, add a `kind:"write"` line
  only if the user asks.
- Per-project/per-role recall breakdown deferred.
