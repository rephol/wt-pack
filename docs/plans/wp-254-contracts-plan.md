# WP-254 — shared typed contracts for the dashboard API (tickets, rooms, inbox first)

## Problem (verified)
Enums and shapes are copied between server and web, and have already drifted:
- Ticket enums twice: `skills/wt-dashboard/tickets.mjs:6-8` (`COLUMNS`, `TYPES`, `SIZES`) and
  `web/src/boardData.ts:2-5` (same lists `as const`).
- Inbox kinds twice, **already different**: `inbox.mjs:8` `KINDS` lacks `'jev-auth'`, while `web/src/notifyGate.ts:3`
  has it and the server does emit it (`server.mjs:1922` `inbox.add({ kind: 'jev-auth', … })`). `ACTIONABLE`
  (`inbox.mjs:9`) is duplicated as `ACTIONABLE_KINDS` (`notifyGate.ts:27`).
- Shapes (`Ticket`, `InboxItem` `notifyGate.ts:5`, room/message types) exist only on the web side, hand-written.

## Decision: one dependency-free module + a hand-written declaration beside it
- `skills/wt-dashboard/contracts.mjs` — runtime: the enum arrays (frozen), `ACTIONABLE`, and tiny validators
  (`oneOf(list, v, field)` throwing the existing `{status:400}` error shape). Server modules import from it.
- `skills/wt-dashboard/contracts.d.mts` — types: `export declare const COLUMNS: readonly ['backlog', …]`, derived
  unions, and the `Ticket`, `InboxItem`, `Room`, `RoomMessage` response shapes. TypeScript resolves `.d.mts` for an
  `.mjs` import, so the web imports `../../contracts.mjs` and gets types with no `allowJs`.
- Why not a `.ts` source: the server runs plain `node` (≥22.13, `CLAUDE.md`), where `.ts` needs a flag. Why not
  JSON Schema: needs a validator lib or a hand-rolled one bigger than the module itself; the ticket allows either.
- Lockstep `.mjs` ↔ `.d.mts` is guarded by a test (below) — the CLAUDE.md "lockstep with no compile-time link" trap.

[unsourced] Vite importing a file outside `web/` (`../../contracts.mjs`): Vite builds files outside root by default;
the dev server's `fs.allow` defaults to the workspace root (nearest `package.json` with workspaces, else the repo
root search). **Unit 1 verifies with `npm run build` and `npm run dev` before anything else**; if dev refuses, add
`server.fs.allow: ['..']` to `web/vite.config.ts`.

## Units
1. **Spike/guard**: add `contracts.mjs` (enums only) + `.d.mts`; import `COLUMNS` in `web/src/boardData.ts`;
   confirm `npm run typecheck:web`, `npm --prefix web run build`, and `test:sidecar` (esbuild bundle) all pass.
2. **Tickets**: `tickets.mjs` imports `COLUMNS/TYPES/SIZES` from contracts (re-export them, so existing importers
   keep working — CLIs stay backward compatible); `boardData.ts` re-exports from contracts; `Ticket` type moves to
   `contracts.d.mts`, `boardData.ts` re-exports it (`board.tsx`, `ticketChip.tsx` imports unchanged).
3. **Inbox**: `KINDS` (with `'jev-auth'` — fixes the drift) and `ACTIONABLE` in contracts; `inbox.mjs` and
   `notifyGate.ts` import them; `InboxItem` moves to `.d.mts`, re-exported from `notifyGate.ts`.
4. **Rooms**: `Room` and `RoomMessage` response types into `.d.mts` from the web's current definitions
   (find them in `web/src/rooms*.ts*`); no runtime enum unless one is duplicated.
5. **Test** `contracts.test.mjs` (added to `npm test`'s list in `package.json`): parses `contracts.d.mts`'s
   `declare const X: readonly [...]` literals and asserts each equals the runtime array; asserts `ACTIONABLE ⊆ KINDS`;
   asserts `inbox.mjs`, `tickets.mjs`, `boardData.ts`, `notifyGate.ts` contain no local enum array literal
   (grep for `= ['backlog'` / `= ['needs-you'`/`['question'`) so a copy can't creep back.
6. **Docs**: one line in the wt-dashboard section of `CLAUDE.md`'s layout? No — `docs/features.md` is user-facing,
   this isn't; add a short header comment in `contracts.mjs` only.

One commit (wt-dashboard only).

## Definition of done
- `cd skills/wt-dashboard && npm test` green (includes typecheck:web, sidecar bundle, new `contracts.test.mjs`).
- `npm --prefix web run build` succeeds.
- `grep -rn "= \['backlog'\|= \['needs-you'\|= \['question'" skills/wt-dashboard --include=*.mjs --include=*.ts` hits only `contracts.mjs`.
- Worker: no e2e writing or running.

## QA brief
No visible change. At 412x700 and iPhone 13: Board loads with all seven columns; Inbox shows existing items with their
filters; a `jev-auth` item (if present) renders like any server item. Done when both screens look as before.

## Out of scope
Other API areas (agents, routines, settings) — follow-up tickets once this pattern holds.
