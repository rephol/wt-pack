# WP-52 — Board auto-dispatch + reconcile

Branch `wp-52-board-autodispatch`, base `origin/main` (7e1a884).

## Goal

A board can dispatch its own Ready tickets. With the new per-board **Dispatch** switch on (default **off**), the
dashboard server hands each unassigned Ready ticket, in priority order, to a free agent of that project. An
always-on **reconcile** pass keeps cards honest: it moves a card to Done once its merge lands, and it returns a
Building card to Ready when its agent no longer exists. The orchestrator is left with the exceptions. The
Board header shows what dispatch is doing, and Settings › Observability gains a Board history. None of this
appears in Routines.

## What research corrected

- **Merge commits do not reliably name WP-N.** Of the last 10 merges on main, only one names a ticket
  (`c53bf9e Merge branch 'wp-48-routines' — WP-48 Routines`). The rest look like `Merge branch 'wp-33-35'` or
  `Merge branch 'wp-39'`, and `git log --merges --grep='WP-'` returns 1 commit. Plain commits do name WP-N,
  but they land **before** the work is finished (`ae60529 … — WP-48 U1` comes before the WP-48 merge), so
  "a commit names WP-N → Done" would fire early. → Reconcile reads the **merge subject's branch id**, and
  only for cards already in building or review (U3).
- **"Idle > N min → back to Ready" would bounce live work.** A worker that has finished reports `done`, which
  means free: `wt-handoff/scripts/handoff.sh:9` "FREE (idle or done — a worker that finished a job reports
  'done', not 'idle')". It sits in that state while it waits to ship or merge. → Reconcile auto-reverts only
  when the assignee **no longer exists**. An idle or done assignee past the threshold gets a flag and a
  history note, not a move (settled below).
- **wt-handoff spawns without a cap.** When no agent is free it spawns one: `handoff.sh:266`
  `created=$(… agents.sh spawn "$role" …)`. Neither wt-agents nor wt-handoff enforces a count. → The
  dispatcher gates on the cap and on memory **before** calling handoff. Handoff's own spawn is the "spawn if
  under cap" path, and that is only safe because the gate ran first.
- **The server's handoff helper cannot dispatch a board ticket.** `handoffTask` requires
  `t.state === 'plan_ready'` and `t.plan && t.worktree` (`server.mjs:1154-1155`), and those are overview-task
  fields. → A new `dispatchTicket` calls `HANDOFF_SH` directly, following the same execFile/stdin pattern
  (`server.mjs:1166-1168`).
- **A server-run handoff cannot move its own card.** handoff.sh moves the card with wt-ticket (`handoff.sh:227`
  `"$T" move "$local_ticket" building … || true`), and wt-ticket authenticates as an agent through
  `x-herdr-pane: ${HERDR_PANE_ID:-}` (`wt-ticket:27`). The dashboard server has no pane, and `roomAuthor`
  (`server.mjs:1844-1850`) accepts only a session cookie or a pane. So the move fails silently. → The
  dispatcher moves and assigns the card itself, through `tickets.patch`, after handoff returns. A side effect:
  no `handoff_to` tokens get written on a sender, because `handoff.sh:219` tags the sender only when
  `from_pane` is set.
- **The Routines cap and the memory guard already exist and can be reused.** `Routines.fire` skips on
  `working.length + pending >= max` and on `pressure === 'critical'` (`routines.mjs:189-191`). `maxWorking`
  is one global value that defaults to 4 (`routines.mjs:87-88`). → Dispatch counts against the same
  `maxWorking` and calls the same `host()`. The shared check is factored into a function; no `routines` row
  is added. Seed rows are what populate the Routines list (`store.mjs:168`), so adding no row keeps dispatch
  out of it.

## Review corrections (binding — where they conflict with Approach or the units below, these win)

Plan review, verified against the tree:

1. **Failed tickets must be retried.** Step 1 selects `!dispatch || (dispatch.state === 'failed' && at older than 2 min)`. `dispatch.fails` counts failures, and the third one sets `held`. As written, a single failure would have skipped the ticket forever and `held` could never be reached.
2. **The gone rule applies only to dispatcher-assigned cards.** That means `dispatch.state === 'sent'` and a local assignee with a pane. A user claim assigns the profile name (`server.mjs:1845-1847` `return { kind: 'user', name: p.name …}`), which matches no agent and would otherwise be sent back to Ready.
3. **Skip the gone pass when `agents()` threw or returned an empty local list**, because herdr being down is not the same as every agent being gone.
4. **Close the claim window.** `claim()` returns 409 when `t.dispatch?.state === 'dispatching'` (unless `force`), since today it checks only `assignee` (`tickets.mjs:215`). Step 6 is one conditional `mutate` that requires `dispatch.state === 'dispatching' && !assignee`. It sets column, assignee, the history note and `dispatch = {state:'sent', agent}` together, and is a no-op with a log line otherwise.
5. **`HERDR_PANE_ID: ''` in the handoff env**, as the server already does for wt-memory (`server.mjs:787` `{ HERDR_PANE_ID: '' }`). Otherwise a service started from a pane leaks that pane into handoff.sh (`handoff.sh:174` `from_pane=…HERDR_PANE_ID`) and into wt-ticket.
6. **`dispatch` is cleared only on a move into Ready or Backlog**, not on every column change. wt-ship's move to review keeps `sent`, and rule 2 relies on it.
7. **Retry is `POST /api/tickets/:id/dispatch-retry`** (it clears `dispatch`). `PATCH {dispatch:null}` would be dropped by the `clean()` whitelist (`tickets.mjs:30-45`). The retry endpoint and a move to Backlog are the only ways to clear `held`, because a Ready → Ready move is a no-op.
8. **Ready notify:** `readyNotes` returns early when the board has `dispatch` on (`server.mjs:1709` sits next to the `auto` check). The `busy()` edit in Risks is dropped. The orchestrator is not told to schedule cards the dispatcher owns.
9. **The shared guard counts both sources of pending work**: open routine spawn runs (`routines.mjs:185-187`) and `dispatching` cards. Dispatch and Routines share one `maxWorking`.
10. **Stalled** uses the assignee's `lastActivity` (`server.mjs:449`) being older than `stallMin`. The "no commit on the card's branch" condition is removed, because tickets carry no branch.
11. **The agent name comes from handoff's second line** (`handoff.sh:232` `echo "target ${to_name:-?} $to…"`), with the pane id as the fallback when it is `?`, rather than from the 3 s-cached `agents()`.

Tests for items 1–4 and 6–8 join U1/U2/U3's verify lists. Item 5 gets a dispatch test asserting the env.

## Approach

**Where it lives.** The logic goes in a new `wt-dashboard/dispatch.mjs`, a class taking injected deps in the
same style as `Routines` (`server.mjs:2358` `new Routines({ agents, host, prompt, spawn, remove, … })`), so it
is unit-testable without herdr. `server.mjs` wires it and ticks it on the routines' 30 s timer
(`server.mjs:2465` `setInterval(rt, 30_000)`). The tick is guarded against re-entry the same way
(`routines.mjs:144` `if (this.ticking) return`).

**The switch.** Migration 6 adds `ALTER TABLE boards ADD COLUMN dispatch INTEGER NOT NULL DEFAULT 0`, following
`auto` and `min_priority` (`store.mjs:157,159`; stages set `user_version = n`, `store.mjs:143`). `MIGRATIONS.length` is 5 today (checked with node), so this is stage 6. Re-check before writing it, since a parallel branch may add one. The column is
exposed through the existing `settings()` / `setSettings()` and `PUT /api/tickets/board {dispatch?}`
(`server.mjs:1762-1764`). Dispatch is independent of Auto. Auto remains the only automated
Backlog → Ready mover (`tickets.mjs:192` `author: 'jev' … from: 'backlog', to: 'ready'`), and dispatch never
touches Backlog.

**Double-dispatch lock: a claim on the card, not an in-memory Set.** `Tickets.mutate` runs inside a
transaction (`tickets.mjs:134` `tx(this.db, () => {`), so one conditional mutation serves as a
compare-and-set: `dispatchClaim(id)` sets `t.dispatch = { state: 'dispatching', at }` only when
`column === 'ready' && !assignee && !dispatch`, and otherwise returns null. This lock survives a restart,
unlike `boardRuns` (`server.mjs:1724` "`new Set()`"). It also excludes `wt-ticket claim` by a human
orchestrator, because a claim sets the assignee (`tickets.mjs:217`) and dispatch requires none, while the
dispatcher's own claim sets `dispatch`, which a later dispatch refuses. A dispatch on an orchestrator-claimed
card is therefore impossible, and the reverse ordering (dispatch first, then a claim) shows up in the card's
history and the orchestrator sees the badge. The claim is visible as the card badge "Dispatching…".

**One tick of dispatch, per board with `dispatch = 1`:**
1. Take the first Ready ticket with no assignee and no `dispatch`, ordered by priority (1 before 4; 0, meaning
   none, goes last) then by seq.
2. Guardrails, in this order, each producing a *waiting reason* that is stored on the board status rather than
   on the card: cap (`working + pending >= maxWorking`) → `waiting: cap 4/4`; memory `critical` →
   `waiting: memory pressure`. If a guard trips, the tick ends. Nothing is claimed.
3. `dispatchClaim`. If it returns null, someone else took the ticket, so skip it.
4. Choose the role. settled: an **L-sized ticket goes to a planner**, with the prompt `Use wt-plan <ID> …`;
   every other size goes to a **worker**, with a prompt telling it to create its `wp-N-*` worktree, then run
   wt-work, wt-ship (review), merge to main and push. Rejected alternative: a planner for every ticket (a
   second agent and a second context for S/M work that has no decisions). The prompt always passes
   `--role <role>` so Jev's routing cannot flip it (`wt-handoff/SKILL.md` "a caller that must get a worker …
   passes `--role worker`"). Jev's MCP picks still apply, since `--role` does not bypass them (`handoff.sh:253`
   `has_picks`).
5. Run `HANDOFF_SH --role <role> --task "<ID> <title>".slice(0,80) <main checkout>` with the prompt on stdin
   and a 120 s timeout. Auto mode reuses only a free agent sitting in the main checkout
   (`handoff.sh:103,118`), which is where both roles start for a new ticket.
6. On success, parse `reused <pane>` or `created <label> <pane>` (`handoff.sh:39`) and resolve the agent's name.
   Then `tickets.patch(id, { column: role === 'planner' ? 'planning' : 'building', note: 'dispatched to <name>' },
   {name:'dispatch'}, {name, pane})` and set `dispatch = { state: 'sent', at, agent }`. wt-plan moving the card
   to planning a second time is a no-op (`tickets.mjs:138` "no-op: no write").
7. On failure (non-zero exit, timeout, unparseable output), clear `dispatch` and record
   `dispatch = { state: 'failed', at, reason }` with a history comment. The ticket stays Ready and unassigned.
   Three consecutive failures on the same ticket park it with `dispatch.state = 'held'`, which is shown on the
   card and cleared by the user (card action "Retry dispatch") or by any manual move. This stops a broken
   ticket from being dispatched every 30 s.

At most **one dispatch per board per tick**, so each spawn is counted by the cap check on the next tick
(herdr's status lag is covered by counting `dispatch.state === 'dispatching'` cards as pending, the same idea
as `routines.mjs:185` counting open spawn runs).

**Reconcile, always on, on the same tick for every board.** The switch does not gate it, but it only
touches what it can prove:
- **Done.** Read `git log --merges --first-parent origin/main --since=<last scan> --format=%H%x09%s` in the
  board's repo, after a `git fetch` that is throttled to once every 5 min. Extract ids from
  `Merge branch 'wp-<n>[-…]'` (first number only, because `wp-33-35` is ambiguous between one id and two)
  and from explicit `WP-<n>` in the subject. A card in `building` or `review` that matches moves to `done`
  with the note `merged in <sha7>`. Any other column (ready, planning, blocked, done) is left alone. For
  wt-pack, wt-ship already moves the card to done itself (`wt-ship/SKILL.md:25` "moves it straight to `done`
  on the merge to main"), so this is a backstop for handoffs like WP-50's that bypassed it.
- **Gone assignee → Ready.** A `building` or `planning` card whose assignee name matches no agent in
  `agents()` for two consecutive ticks (so a herdr blip does not bounce it) moves to `ready` with
  `assignee = null`, because Ready does not clear it on its own (`tickets.mjs:153` clears only for backlog),
  and the note `returned: <name> is gone`. This is the only automated move **into** Ready, and it returns a
  card to where it already was. It is not a Backlog → Ready promotion, so the user's rule stands.
  settled: no automatic revert for an idle agent. Rejected alternative: revert on idle > N min (see the
  research correction above).
- **Stalled flag.** An assignee that exists but has been `idle`/`done` for more than `stallMin` (a board
  setting, default 45) on a `building` card, with no new commit on the card's branch in that window, gets
  `dispatch.stalled = '<name> idle 52m'`. That appears as a badge plus one history note, written once per
  stall. No move.
- A reconcile move bumps `updated` and goes through `patch`, so `onReady` fires on the gone → Ready revert.
  That is intended: with dispatch on, the card is re-dispatched on the next tick. With dispatch off, the
  orchestrator's Ready notify (WP-43) tells a human.

**Restart mid-dispatch.** On startup, `dispatch.recover()` finds cards with `dispatch.state === 'dispatching'`.
Those were claimed, but the handoff outcome is unknown. For each one, if an agent carries `tagTicket(a) === id`
(`server.mjs:1061` reads the `ticket`/`task` token that handoff.sh writes on the target, `handoff.sh:215`),
the dispatch landed, so finish step 6 with that agent. Otherwise clear the claim and leave the card in Ready.
The worst case is a handoff that landed after the token read, which gets re-dispatched to a second agent. The
first agent then carries the same ticket token, and the gone/stalled pass and the "held by" badge show it.
`[unsourced]`: this was judged rare enough (a restart inside a ≤120 s window) not to need a two-phase protocol.

**Agent busy or crashed mid-handoff.** handoff.sh exits non-zero, without prompting, when claude never comes
up (`handoff.sh:39-40`), which is step 7's failure path. A crash after the prompt lands looks like a gone
assignee, which reconcile returns to Ready. A reused pane that turned busy between the list and the send is
handoff's own race and is out of scope. `--pane` is never used, so handoff's free-agent selection applies.

**Merge conflicts.** The dispatcher never merges. The worker prompt tells the worker to rebase on main and
resolve conflicts, or to `wt-work`-block the card (`wt-work/SKILL.md:87` `move <ID> blocked --note`) when it
cannot. A blocked card is outside every reconcile rule, and dispatch never picks a blocked card.

**Status and history.** `dispatch.status(project)` returns
`{ on, last: {at, text}, waiting: reason|null, inflight: n }`. The board GET merges it in, the way it merges
settings (`tickets.mjs:106` `{ key, ...(await this.settings(project)), tickets }`). Board history is a new
table, `board_events (id INTEGER PRIMARY KEY, project, at, kind, ticket, text)`, with kinds dispatch, fail,
done, returned and stalled. It lives in the same migration, is pruned at 30 days as in `routines.mjs:148`,
and is read by `GET /api/board/events?limit=50`.

**Docs and rules that assume manual dispatch** are updated in the same change (U5): CLAUDE.md:10
"**Schedule only Ready tickets** … `claim` one before planning it", `wt-ticket/SKILL.md:34-36` "Do not move
cards into Ready yourself" (add the reconcile exception, and say orchestrators skip cards that show a dispatch
badge), and the dashboard README.

## Implementation units

**U1 — store + switch (S).** Migration: `boards.dispatch`, `boards.stall_min` (default 45), the
`board_events` table. `settings()`/`setSettings()` gain `dispatch` and `stallMin`, and
`PUT /api/tickets/board` accepts them. `Tickets.dispatchClaim(id)` and `Tickets.setDispatch(id, obj|null)` are
built on `mutate`. Any manual `patch` that changes the column clears `t.dispatch`.
Files: `wt-dashboard/store.mjs`, `wt-dashboard/tickets.mjs`, `wt-dashboard/server.mjs` (route only),
`wt-dashboard/store.test.mjs`, `wt-dashboard/tickets.test.mjs`.
Verify: tests for the migration upgrading from the previous version, and a `dispatchClaim` race where two
calls produce exactly one non-null result. A claim is refused on an assigned card, a non-Ready card, or an
already-claimed card.

**U2 — dispatch engine (M).** `wt-dashboard/dispatch.mjs`: `tick()` (steps 1–7), `recover()`, `status()`,
the role choice, the prompt text and the failure counter. The shared guard (cap + memory) is extracted from
`Routines.fire` into an exported `guard({agents, host, maxWorking, pending})` in `routines.mjs`, and Routines
calls it so its behaviour does not change. Server wiring: construct with deps (`agents`, `host`, `tickets`,
`handoff: (args, prompt) => execFile(HANDOFF_SH…)`, `repoOf(project)`), `recover()` at startup, and a tick
inside the existing 30 s interval.
Files: `wt-dashboard/dispatch.mjs` (new), `wt-dashboard/dispatch.test.mjs` (new), `wt-dashboard/routines.mjs`,
`wt-dashboard/routines.test.mjs` (only if the extraction changes a signature), `wt-dashboard/server.mjs`.
Verify, all with fake deps: cap reached → no claim and waiting = cap; memory critical → same; priority order;
L → planner and M → worker with `--role`; handoff exit 1 → card Ready and unassigned, `failed` recorded, held
after 3; success → building + assignee; a second concurrent `tick()` is a no-op; `recover()` with and without
a tagged agent. The existing `routines.test.mjs` still passes.

**U3 — reconcile (M).** Inside `dispatch.mjs`: `reconcile(project)` covering merge → done, gone for 2 ticks →
ready with the assignee cleared, and the stalled flag. It uses a fetch throttle and a per-board `lastScan`
kept in `routine_settings`-style kv (`board_kv`, or reuse `routine_settings` keys `reconcile:<project>`), so a
restart does not rescan all history. The first scan is bounded to `--since=7.days`.
Files: `wt-dashboard/dispatch.mjs`, `wt-dashboard/dispatch.test.mjs`, `wt-dashboard/server.mjs` (`repoOf`
wiring, only if U2 did not add it).
Verify: a merge-subject parser table test (`Merge branch 'wp-48-routines' — WP-48 Routines` → 48,
`Merge branch 'wp-33-35'` → 33, `Merge branch 'wp-39'` → 39, a non-ticket merge → none); a card in review →
done; a card in ready with a matching merge → untouched; gone once → untouched, gone twice → ready with
assignee null; idle past stallMin → flag without a move, noted once.

**U4 — UI (M).** Board header: a `Dispatch` switch next to Auto (`web/src/board.tsx:205`), plus a status line
(`Dispatching WP-12…` / `waiting: cap 4/4` / `last: WP-9 → wt-pack-worker-02 3m ago`). Cards: badges for
Dispatching…, failed, held (with a "Retry dispatch" action through `PATCH {dispatch:null}`) and stalled.
Settings › Observability: a `BoardHistorySection` after `RoutinesHistorySection` (`web/src/settings.tsx:173`)
using the framed 320 px scroll box from WP-34. Stall minutes are a number field that appears only while
Dispatch is on, like the Auto-only selector at `board.tsx:207`. No native dialogs (`noNativeDialogs.test.ts`).
Files: `web/src/board.tsx`, `web/src/boardData.ts`, `web/src/settings.tsx`, `web/src/routines.tsx` (only if
the section lives beside RoutinesHistorySection), `wt-dashboard/server.mjs` (`/api/board/events`).
Verify: `cd web && npx tsc --noEmit -p . && npm test`; `npm run build`; agent-browser at 1440 and 390 with
`--session <agent name>` against a throwaway board (not a live umkmall board). Toggle Dispatch, check the
status line, and screenshot a card badge and the history section.

**U5 — docs + rules (S).** CLAUDE.md "Working here", `wt-ticket/SKILL.md` orchestrator rule,
`wt-dashboard/README.md` (the feature, the default off, the rollback: `UPDATE boards SET dispatch = 0`).
This is one commit per skill touched, per CLAUDE.md.
Verify: a grep shows no remaining "only the orchestrator schedules Ready" claim without the dispatch caveat.

Order: U1 → U2 → U3 → U4 → U5. U3 extends U2's module, and U4 depends on the status shape from U2.

## Files

- `wt-dashboard/store.mjs`, `wt-dashboard/store.test.mjs`
- `wt-dashboard/tickets.mjs`, `wt-dashboard/tickets.test.mjs`
- `wt-dashboard/dispatch.mjs` (new), `wt-dashboard/dispatch.test.mjs` (new)
- `wt-dashboard/routines.mjs`, `wt-dashboard/routines.test.mjs`
- `wt-dashboard/server.mjs`
- `wt-dashboard/web/src/board.tsx`, `wt-dashboard/web/src/boardData.ts`, `wt-dashboard/web/src/settings.tsx`,
  `wt-dashboard/web/src/routines.tsx` (optional)
- `wt-dashboard/README.md`, `CLAUDE.md`, `wt-ticket/SKILL.md`

## Verification

- `cd wt-dashboard && npm test` must be green, including the new `dispatch.test.mjs` and the unchanged
  routines tests.
- `cd wt-dashboard/web && npx tsc --noEmit -p . && npm run build`.
- Live check after one service restart (`npm run service:restart`, once), with a DB backup first as WP-48 did.
  Create a temp board or use a throwaway project with Dispatch on and one S ticket in Ready. Confirm the card
  goes to Building with a worker assignee within about 60 s, and that a spawned throwaway worker gets the
  prompt. Then `wt-agents rm` that worker and confirm the card returns to Ready after two ticks, with the
  history note. Never test against real umkmall-* agents (CLAUDE.md Traps).
- Default-off check: after the migration, `SELECT dispatch FROM boards` is 0 for every board, and no card
  moves because of dispatch.

## Definition of Done

Each item has to be shown by a command whose output appears in the transcript:

- `cd wt-dashboard && npm test` passes. `dispatch.test.mjs` contains named passing cases for each of the
  following, and they are the unit-level proof:
  a claim race where only one wins; cap reached, so nothing is claimed; memory critical, so nothing is
  claimed; priority order; L goes to a planner and M goes to a worker with `--role`; a failed handoff leaves
  the card Ready and unassigned and holds it after 3; `recover()` both with and without a tagged agent; the
  merge-subject parser table; review goes to done; ready is untouched by a merge; gone twice goes to ready
  with the assignee null; stalled sets a flag without moving the card.
- `routines.test.mjs` still passes, unchanged or with only a signature update.
- `cd wt-dashboard/web && npx tsc --noEmit -p . && npm run build` succeeds.
- After the restart: `sqlite3 ~/.local/share/wt-dashboard/data/wt.db "PRAGMA user_version; SELECT project, dispatch FROM boards"`
  prints 6 and every board with 0.
- Live throwaway run, with its output pasted: `wt-ticket show <ID>` shows the history lines
  `ready → building` plus `dispatched to <name>`, and after `wt-agents rm <name>`, `building → ready` plus
  `returned: <name> is gone`.
- `sqlite3 … "SELECT count(*) FROM routines WHERE name LIKE '%ispatch%'"` prints 0, and screenshots at 1440 and 390 show the Dispatch switch, the status line and Board history.
- `grep -n "dispatch" CLAUDE.md wt-ticket/SKILL.md` shows the new rule lines.

## Risks and deferred

- **Re-dispatch after a restart inside the handoff window** can give one ticket to two agents (see Restart).
  Accepted as rare. Deferred: a two-phase record with a pre-send token.
- **Fast-forward merges** produce no merge commit, so reconcile misses them. wt-ship's own move to done covers
  that path. Deferred: branch-tip ancestry tracking, which needs the card to record its branch sha.
- **`wp-33-35`-style branches** map only to the first id. The second ticket relies on wt-ship's move.
- **The cap is global**, not per board (`routines.mjs:87-88`), so one busy board can starve another.
  Deferred: a per-board cap if that happens.
- **The orchestrator Ready notify** (`server.mjs:1709`) still fires on Auto boards. With Dispatch on, it is
  suppressed for tickets that dispatch claims in the same minute (`readyToNotify` gets a `busy` that includes
  `t.dispatch`). Making the notify fully optional is deferred as a separate switch `[unsourced: whether the
  user wants it off entirely]`.
- **Remote machines**: dispatch targets only local agents (`tagTicket` returns null when not `a.local`), so
  boards whose agents run remotely are not dispatched. Deferred.
