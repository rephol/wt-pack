# WP-75 — Dispatch: configurable report target

Branch `wp-75-dispatch-report-target`, base `origin/main` (95df791).

## Goal

A board with Dispatch on gets a **Report to** setting in its Automation sheet. The options are the project
room, any other room, the project's orchestrator, both a room and the orchestrator, or nothing. The prompt a
dispatched worker or planner receives tells it where to post its one-line result. The default is the project
room plus the orchestrator.

## What research corrected

- **A dispatched agent has no sender to reply to.** The WP-74 prompt ends "…and still reply to the sender"
  (`dispatch.mjs` `dispatchPrompt`: `` `When done, post a one-line result in #${room} … and still reply to the sender.` ``).
  But the dispatcher runs handoff with the pane cleared: `dispatch.mjs:226`
  `env: { ...process.env, HERDR_PANE_ID: '' }`. handoff.sh adds its sender footer
  (`handoff.sh:178` `Handed off by ${from_name:-$from_pane} (pane $from_pane). To reach it: herdr agent prompt $from_pane`)
  only when there is a sender. So for dispatched work, "the sender" resolves to nobody. → The **orchestrator**
  option cannot mean "reply to the sender". It must name the orchestrator agent and give its pane explicitly.
  The server resolves that at dispatch time, the same way the Ready notify does
  (`server.mjs:1723` `ags.find((x) => x.pool === 'orchestrator' && x.project === project)`).
- **The Routines "delivery-target picker" is not a component, and it has no orchestrator option.** It is inline
  in `web/src/routines.tsx:185-186`: `seg('Deliver result to', 'deliver', [['self', 'Inbox'], ['room', 'Room'], ['none', 'None']])`,
  plus a room `<Selector … options={roomOpts} hasSearch />`, where `roomOpts` is built at `routines.tsx:148`.
  → What gets reused is the pattern (the same Selector with room options from the rooms query), not an import.
  Extracting a shared component to serve two callers with different option sets is not worth it.
- **The next migration is stage 7.** `MIGRATIONS.length` is 6 today, checked with node, and stage 6 is WP-52's
  `ALTER TABLE boards ADD COLUMN dispatch …`.

## Review corrections (binding — these win over Approach and the units where they conflict)

1. **The orchestrator must be local.** `agents()` merges remote machines (`server.mjs:491`), and `id` is a bare
   pane id (`server.mjs:437` `id: a.pane_id`) that means something only on its own machine. `reportOf` uses
   `ags.find((x) => x.local && x.pool === 'orchestrator' && x.project === project)`. A test covers the case
   where only a remote orchestrator exists: no orchestrator clause.
2. **`store.test.mjs` is required, not optional.** It pins `assert.equal(version(db), 6)` (`store.test.mjs:101`).
   Change that to 7, and extend its boards SELECT to assert `report_room` is null and `report_orch` is 1.
3. **Migration 7 copies the no-op hooks** `legacy: () => [], import: () => {}, export: () => {}`, as WP-52's
   stage does (`store.mjs:174-178`, "Not exported"). The JSON rollback loses Report to, just as it already
   loses auto, dispatch and stall_min.
4. **"No room" is stored as `''`, not `'none'`,** so that a room slugged `none` stays selectable. So NULL means
   the project room, `''` means none, and anything else is a slug. Validation:
   `reportRoom === null || (typeof reportRoom === 'string' && reportRoom.length <= 64)`.
5. **The Selector keeps a saved room that has since been archived** by copying `keep(...)` from
   `routines.tsx:143-148`, labelled `#slug (archived)`. Rooms come from `useRoomsList` (`rooms.tsx:75`), which
   `board.tsx:32` already imports from.
6. **The PUT route passes `reportRoom` through untouched** (`'reportRoom' in b ? b.reportRoom : undefined`),
   so that null can be saved, and wraps `reportOrch` in `bool()` (`server.mjs:1777`). A test checks that
   writing a slug and then null leaves null.
7. **The WP-74 tests and deps comment are updated.** Replace `roomOf` with `reportOf` in the fixture
   (`dispatch.test.mjs:22`), rewrite the prompt case (`:252-256`) as the four-shape test, and update the deps
   comment (`dispatch.mjs:36-37`). The report line still ends with `\n`, and "neither" yields `''`.
   Flattening and the 4000-character cap are unaffected (`handoff.sh:199-201`).

## Approach

**Storage.** Migration 7 adds two columns to `boards`, alongside `dispatch` and `stall_min` (`store.mjs:175-176`):
`report_room TEXT` (NULL means the project room, `'none'` means no room, anything else is a room slug) and
`report_orch INTEGER NOT NULL DEFAULT 1`. With NULL and 1 as defaults, every existing board keeps today's
behaviour and also gains the orchestrator line, which is the default the ticket asks for.
settled: two columns, not a JSON blob. They follow the existing per-setting column style of
`settings()`/`setSettings()` (`tickets.mjs:71-85`).

**API.** `settings()` returns `reportRoom: string|null` and `reportOrch: boolean`. `setSettings` accepts them
and validates `reportRoom`: it must be null, `'none'`, or a slug of 64 characters or fewer, the same limit as
`cleanDeliver`'s `str(d.room, 64)` (`routines.mjs:58`). `PUT /api/tickets/board` passes them through, next to
`dispatch`.

**Prompt.** The signature becomes `dispatchPrompt(t, role, report)`, where
`report = { room: slug|null, orch: {name, pane}|null }`, and the report line is built from the two parts:
- room only: `` When done, post a one-line result in #<room> with `room post <room> "…"`. ``
- orchestrator only: `` When done, send a one-line result to <name> with `herdr agent prompt <pane> "…"`. ``
- both: the two clauses joined with " and ".
- neither: no line.

"still reply to the sender" is dropped: see the correction above.

**Resolution at dispatch.** This replaces the WP-74 call in `tick()`
(`dispatchPrompt(next, role, (await this.deps.roomOf?.(project)) ?? null)`). There is a new dep,
`reportOf(project) → {room, orch}`, wired in server.mjs:
- `reportRoom === null` → `roomOf(project)` (the existing WP-74 lookup, which skips archived rooms);
  `'none'` → null; a slug → that slug, if the room exists and is not archived, else null.
- If `reportOrch` is on → the project's orchestrator from `agents()`
  (`pool === 'orchestrator' && project === project`) as `{name, pane: a.id}`, or null when none is running.

A missing target degrades to no clause rather than failing the dispatch.

**UI.** In `AutomationButton` (`web/src/board.tsx:249`), shown only while Dispatch is on (like `StallMinutes`
at `board.tsx:272`), add:
- a Selector labelled **Report to room**, with options *Project room* (null), *None* (`'none'`), and every
  room as `#slug`, built from the rooms query the same way `routines.tsx:148` builds `roomOpts`;
- a Switch labelled **Also tell the orchestrator** (`reportOrch`).

`BoardSettings` and the `setBoard` mutation type gain both fields. No native dialogs.

## Implementation units

**U1 — store, API, prompt, dispatcher (S).** Migration 7; `settings`/`setSettings`, plus validation; the
route; `dispatchPrompt(t, role, report)`; the `reportOf` dep in `Dispatch` and server.mjs, replacing
`roomOf` in `tick()` (the `roomOf` server helper stays, because `reportOf` uses it).
Files: `skills/wt-dashboard/store.mjs`, `skills/wt-dashboard/tickets.mjs`, `skills/wt-dashboard/dispatch.mjs`,
`skills/wt-dashboard/server.mjs`, `skills/wt-dashboard/dispatch.test.mjs`, `skills/wt-dashboard/tickets.test.mjs`,
and `skills/wt-dashboard/store.test.mjs`.
Verify: `cd skills/wt-dashboard && npm test`, with new cases for:
- the prompt in its four shapes (room, orch, both, none) for both roles, and no "reply to the sender" anywhere;
- `settings()` of a fresh board returns `{reportRoom: null, reportOrch: true}`;
- `setSettings` rejects a 65-character slug with a 400;
- `tick()` with `reportOf` returning `{room:'wt-pack', orch:{name:'o', pane:'w1:p2'}}` produces a prompt that
  contains both `room post wt-pack` and `herdr agent prompt w1:p2`.

The existing WP-74 tests are updated to the new signature.

**U2 — UI + docs (S).** The Automation sheet controls; `docs/features.md` at the Dispatch section
(around `features.md:80-86`) gains a line for "Report to".
Files: `skills/wt-dashboard/web/src/board.tsx`, and `docs/features.md`.
Verify: `cd skills/wt-dashboard/web && npx tsc --noEmit -p . && npm test && npm run build`. Then use
agent-browser (`--session <agent name>`, `caffeinate -u -t 60 &` first) at 1440 and 390 on a board with
Dispatch on: open Automation, set the room to None, toggle the orchestrator switch, reload, and check that
both values persist.

Order: U1 → U2. A service restart is needed once, for the migration and the server code.

## Files

- `skills/wt-dashboard/store.mjs`, `skills/wt-dashboard/tickets.mjs`, `skills/wt-dashboard/dispatch.mjs`, `skills/wt-dashboard/server.mjs`
- `skills/wt-dashboard/dispatch.test.mjs`, `skills/wt-dashboard/tickets.test.mjs`, `skills/wt-dashboard/store.test.mjs`
- `skills/wt-dashboard/web/src/board.tsx`
- `docs/features.md`

## Definition of Done

Each item is shown by output in the transcript:
- `npm test` in `skills/wt-dashboard` passes, including the named U1 cases.
- `npx tsc --noEmit -p .`, `npm test` and `npm run build` in `web` pass.
- After one `npm run service:restart`: `sqlite3 ~/.local/share/wt-dashboard/data/wt.db "PRAGMA user_version; SELECT project, report_room, report_orch FROM boards"`
  prints 7 and shows NULL and 1 on every board.
- Screenshots at 1440 and 390 show the two controls in the Automation sheet, and a reload keeps the changed
  values.
- `grep -n "Report to" docs/features.md` returns a line.

## Risks and deferred

- **The orchestrator's pane can change** between dispatch and when the agent reports, if the orchestrator is
  restarted. The agent's `herdr agent prompt` then fails, and the room post still lands if one is configured.
  Resolving by name at report time would need a `wt-agents` lookup inside the prompt. Deferred.
- **Planner → worker chains.** A planner hands off to a worker through wt-handoff with itself as the sender,
  so the worker replies to the planner, not to this target. That is unchanged; only the dispatched agent gets
  the report line.
