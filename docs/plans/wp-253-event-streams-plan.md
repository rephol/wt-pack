# WP-253 — Sequence-numbered change stream for rooms, inbox and board

## Goal
A client that drops its connection (phone, sleeping laptop) catches up on exactly what it missed, and the board,
inbox and rooms list stop depending on fast polling to look live.

## What research changed about the ticket
- **Room message streams already resume.** `server.mjs:2908-2918`: `/api/rooms/:slug/stream` takes
  `?since=<message count>` or `Last-Event-ID`, sends the tail, and `web/src/streamStore.ts` reconnects with its
  cursor. Out of scope — do not touch them.
- **No new transport is needed.** Plain SSE already runs here (`text/event-stream` at `server.mjs:874,934,1977,2908,3163`).
  No WebSocket.
- **What actually polls**: board `refetchInterval: 4000` (`web/src/board.tsx:80`), inbox `5000`
  (`web/src/inbox.tsx:32`), rooms list `10_000` (`web/src/rooms.tsx:78`). These are the "missed updates" surface.
- **`/api/events` has no ids** (`server.mjs:1844`: `broadcastEvent = (event, data) => { for (const res of subs) res.write(\`event: ${event}\ndata: …\`) }`)
  and only the Tauri app opens it (`web/src/desktop.tsx:34`). Leave its semantics alone (tray/notification/build).
- **Every write goes through the server.** `wt-ticket` is `curl` against `/api/tickets` (`skills/wt-ticket/scripts/wt-ticket:29`),
  so an in-process log sees every change; no DB trigger needed.

## Design (settled by the planner — dispatched, no user question was shape-changing)
Change notifications, not payloads: an event says *what* changed; the client refetches it through the existing
GET routes. The "snapshot when the gap is too large" is just invalidating everything.

### Server — `skills/wt-dashboard/changes.mjs` (new, ~40 lines)
- `class Changes { constructor(keep = 1000) }`, `epoch = Date.now().toString(36)` at construction, `seq = 0`, ring array.
- `add(topic, data)` — `topic ∈ 'tickets' | 'inbox' | 'rooms'`, `data` e.g. `{ project }` / `{ slug }`; `seq++`,
  push `{ seq, topic, data }`, trim to `keep`, write to every subscriber as `id: <epoch>:<seq>\nevent: change\ndata: {topic,…}`.
- `stream(req, res, lastId)` — parse `lastId` (`Last-Event-ID` header or `?since=`). Same epoch and `seq - n < ring.length`
  covered → replay entries with `seq > n`. Otherwise (no id, other epoch = server restarted, or gap past the ring) →
  `event: reset` with id `<epoch>:<seq>`. Heartbeat `: hb` every 15 s like the others. Remove on `close`.
- Unit test `changes.test.mjs` (node:test): replay after id, reset on epoch mismatch, reset on gap > keep, ring trim.

### Server — wiring in `server.mjs`
- `GET /api/changes` → `changes.stream(...)`, routed next to `/api/events` (`server.mjs:3205`), behind the same auth/host guards.
- Hook points (call `changes.add`):
  - tickets: after the write in `Tickets.create` (`tickets.mjs:158`) and `Tickets.mutate` (`tickets.mjs:174`, only when
    not the no-op branch) and `setSettings` (`tickets.mjs:101`). Add an `onChange(project)` callback beside the existing
    `onReady/onDone/onReopen` hooks (`tickets.mjs:184-186` pattern) rather than importing `changes` into tickets.mjs.
  - inbox: `Inbox.add/patch/compact/clear` (`inbox.mjs`; `resolve` at `inbox.mjs:145` routes through `patch`) — add an `onChange` callback likewise; `subs` stays as is
    (it feeds native notifications).
  - rooms: `Rooms.emit` (`rooms.mjs:387`, covers message/delivered) and `Rooms.saveIndex` (`rooms.mjs:282`, the one
    write behind every room create/update/remove — `DELETE FROM rooms` + re-insert) plus `setSettings` (`rooms.mjs:289`).
  - Coalescing: none. [unsourced] write volume is low (human/agent-paced); add a 100 ms debounce only if measured noisy.

### Web — `web/src/changes.ts` (new) + hook in `App.tsx`
- `useChangeStream(qc)`: one `EventSource('/api/changes')` per window (browser reconnect sends `Last-Event-ID` itself).
  `change` → `qc.invalidateQueries` for `['tickets']` (prefix; board key is `['tickets', project]`, `board.tsx:451`),
  `['inbox']`, `['rooms']` by topic. `reset` → invalidate all three. Mount once at the app root.
- Slow the three polls to a fallback: board/inbox/rooms `refetchInterval` → `60_000`. Keep `refetchIntervalInBackground`
  off for inbox (drop the `true`, `inbox.tsx:32`) since the stream covers foreground and reconnect covers wake.
- Page Visibility: when the tab becomes visible and the EventSource is `CLOSED`, recreate it (iOS Safari kills it in background
  without retry) [unsourced — verify on a phone].

### Docs
- `docs/features.md`: one paragraph under the dashboard's live updates — "board, inbox and rooms update via `/api/changes`;
  a reconnecting client receives only missed changes, or a full refresh after a server restart / long gap".

## Units (in order, each stands alone)
1. `changes.mjs` + `changes.test.mjs`. Done: `node --test skills/wt-dashboard/changes.test.mjs` green.
2. Server wiring (`/api/changes` + onChange hooks in tickets/inbox/rooms). Done: `npm test` green in `skills/wt-dashboard`;
   manual: `curl -N` the stream with the session cookie, `wt-ticket comment` a test ticket, see `event: change` with
   `topic: tickets`; reconnect with `-H 'Last-Event-ID: <epoch>:<n-1>'` → exactly the one missed event; bogus epoch → `reset`.
3. Web client + polling fallback. Done: `npx tsc --noEmit -p tsconfig.app.json` clean, `npm run build`; in agent-browser
   (`--session <agent name>`) open the board, move a ticket from the CLI, card moves in < 2 s with no 4 s poll in the
   network log.
4. `docs/features.md`.

Server restart for unit 2 verification: `npm run service:restart` once, at the end — not repeatedly (CLAUDE.md).

## Definition of done
`/api/changes` exists with `<epoch>:<seq>` ids and replay/reset; tickets, inbox and rooms writes each emit; the web app
invalidates on change and polls at 60 s; tests + typecheck green; features.md updated; merged to main and pushed.

## Out of scope
Room message streams (already resume), `/api/events` semantics, overview/agent polling (`App.tsx:214,344`), payload-carrying
events, persistence of the ring across restarts (epoch reset → full refetch is the snapshot).

## Residual risk
- Missing a write path means a stale view until the 60 s poll — not lost data. Grep `INSERT|UPDATE |DELETE FROM` in
  tickets/inbox/rooms after wiring; every hit must sit in a function that calls `onChange`.
