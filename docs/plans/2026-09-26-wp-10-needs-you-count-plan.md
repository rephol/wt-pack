# WP-10 — one "needs you" count (badge, Inbox, Overview, tray)

## Goal
Everywhere the dashboard says "needs you" shows the same number: items waiting on a decision from the user.
FYI items ("X is done", "Server started", memory updates) stop turning the badge red.

## What research corrected
- The ticket names **three** counts. There are **four**. Live server (port 7777), at research time:
  sidebar badge 99, Inbox "Needs you" 2, Overview tile 0, Tauri tray 0.
  - Badge = every unread item: `web/src/inbox.tsx:33` `unread: items.filter((it) => !it.read).length`.
  - Inbox section = unresolved actionable: `inbox.tsx:119` `!it.resolvedAt && ACTIONABLE_KINDS.includes(it.kind)`.
  - Overview tile = derived **tasks** in state needs_you: `server.mjs` counts `needsYou: n('needs_you')`
    (≈`:1268`). Room suggestions and memory proposals are never tasks.
  - Tray = `server.mjs` `trayOfInbox`: `inbox.open().filter((it) => it.kind !== 'room-suggestion')`, which Rust
    renders (`app/src-tauri/src/main.rs:595` `set_title(n.to_string())`).
- The server already computes the right count and nobody uses it. `inbox.mjs` has
  `open() { … !it.resolvedAt && !it.clearedAt && ACTIONABLE.has(it.kind) }`, and `GET /api/notifications`
  returns `open: inbox.open().length`. The web recomputes its own count from `items`.
- The actionable kind list exists twice: `inbox.mjs` `ACTIONABLE` and `web/src/notifyGate.ts:27` `ACTIONABLE_KINDS`
  (`question, mention-user, needs-you, room-suggestion, memory-proposal`).

## Approach
One definition: **needs you = `Inbox.open()`**, meaning unresolved, uncleared and of an actionable kind.
Read/unread does not matter. Reading a question does not answer it; the resolve rules (`toResolve`) are what
close it.

- settled (planner assumption, no synchronous user): **room suggestions and memory proposals count.** They
  already sit in the Inbox "Needs you" section and each needs a decision. Rejected: keep the tray's
  room-suggestion exclusion. That exclusion is exactly why the tray disagrees with the Inbox.
- settled: **the Overview "Needs you" tile shows the inbox open count.** Agents that are waiting produce inbox
  items of kind `question` or `mention-user` (not `needs-you`): `inbox.mjs:12-14` `itemFromTransition`. That
  holds only after U5. Today the task state uses `asker` (`server.mjs:1067`), which includes
  `a.stall === 'waiting_on_user'`, while the snapshot/inbox side uses only `a.asks && a.status !== 'working'`
  (`server.mjs:1286`, `:1387`). So a stall-classified waiting agent is a needs-you task with no inbox item.
  Review caught this; the first draft claimed the inbox count was already a superset of the task count.
  Rejected: relabel the tile "Agents waiting" and keep two numbers. The ticket asks for them to agree. The task
  count stays where it is (the Tasks queue section, the sidebar Overview badge in `App.tsx`); only the tile
  changes.
- The unread count stops being a badge. It stays as per-row bold/dot styling in the Inbox.
- The per-kind desktop prefs filter (`inbox.tsx:32`) keeps applying on the web, so the badge counts the open
  items the user has not muted. The tray has no such filter; it keeps using the raw count
  [unsourced: whether prefs should also mute the tray; leaving it as is].

## Implementation units
**U1 — web badge and Inbox section use one predicate.** `web/src/inbox.tsx`, `web/src/notifyGate.ts`.
In `useInbox`, `open` is the single predicate. No `clearedAt` guard is needed: `inbox.mjs:102` `list()` already
drops cleared items, and `InboxItem` has no such field. `InboxButton` shows
`open.length` instead of `unread`: the badge, the collapsed dot and its label ("N need you"). The `isPinned`
check at `:119` reuses the same predicate function, exported once from `notifyGate.ts` beside
`ACTIONABLE_KINDS`. Verify with `npx tsc --noEmit -p .` and `npm test`, adding a notifyGate test: a fixture
with 3 done, 1 server, 1 unresolved question, 1 resolved question, 1 room suggestion gives count 2.

**U2 — tray agrees.** `server.mjs` `trayOfInbox`: drop `.filter((it) => it.kind !== 'room-suggestion')`.
No test asserts the exclusion (`parse.test.mjs:311` tests `Inbox.open()`, not `trayOfInbox`, which is not
exported), so there is no test change. Verify with `npm test` in `wt-dashboard` and by reading the diff.

**U3 — Overview tile agrees.** `web/src/overview.tsx` Needs-you tile value = `useInbox().open.length`, with
the href changed to `#inbox`. `counts.needsYou` stays in the snapshot for its other consumers. Update
`overviewData.test.ts` only if it asserts the tile. Verify with tsc and the tests.

**U4 — kind lists cannot drift.** Add a test that `ACTIONABLE_KINDS` in `notifyGate.ts` equals `ACTIONABLE`
in `inbox.mjs`, by reading both. That is cheaper than sharing a module across the node/vite boundary.

**U5 — every needs-you task gets an inbox item.** `server.mjs`: the snapshot's needs-you rule (`:1286`, and
the startup baseline `:1387`) uses the same `asker` predicate as the task state (`:1067`). Factor it into one
function that both call. Verify with `npm test` and a `parse.test.mjs` case: an agent with
`stall: 'waiting_on_user'` and `asks: false` yields a `question` item.

## Files
- `wt-dashboard/web/src/inbox.tsx`
- `wt-dashboard/web/src/notifyGate.ts`
- `wt-dashboard/web/src/notifyGate.test.ts`
- `wt-dashboard/web/src/overview.tsx`
- `wt-dashboard/server.mjs`
- `wt-dashboard/parse.test.mjs` (U5 case)

## Verification
- `cd wt-dashboard/web && npx tsc --noEmit -p . && npm test && npm run build`, then `cd wt-dashboard && npm test`.
- Live: `npm run service:restart` **once** (the server changed). Then with agent-browser
  (`--session <agent name>`), check that the sidebar badge, the Inbox "Needs you" header count and the Overview
  tile show the same N, and that
  `curl -s localhost:7777/api/notifications | jq .open` returns N. Take a screenshot via
  `node wt-shared/scripts/screenshot.mjs`.

## Definition of Done
- With default desktop prefs (no kinds muted; the web applies the per-kind prefs filter, the server does not),
  the badge, the Inbox "Needs you" count, the Overview tile and `/api/notifications .open` are equal on the
  live dashboard (screenshot posted in #wt-pack).
- The badge no longer counts done/server/memory items: the U1 fixture test passes.
- The U5 test passes: a stall-waiting agent produces an inbox item.
- The tray filter is removed: `grep "room-suggestion'" wt-dashboard/server.mjs` no longer matches in `trayOfInbox`.
- tsc, web tests and server tests are green. One commit per skill (all wt-dashboard).

## Risks and deferred
- The badge drops from ~99 to ~2. That is the intent, but unread FYIs lose their red signal. The Inbox rows
  still bold them.
- An item the user clears drops out of the count while its task may still be `needs_you` in the Tasks queue.
  That is accepted: clearing is the user's say-so.
- Stale actionable items (a question resolved in the pane but never auto-resolved) now stay on the badge until
  cleared. If that bites, the fix is in `toResolve`, not in the badge.
- Deferred: the duplicated agent-level `a.asks && a.status !== 'working'` (`App.tsx`, `switcherData.ts`,
  `agentSort.ts`) is a separate count of agents, not inbox items. It is out of scope here.
- Deferred: the Settings "Needs you" notification group lists only 3 of the 5 kinds (`settings.tsx:314`). That
  is the notification prefs UI, not a count.
