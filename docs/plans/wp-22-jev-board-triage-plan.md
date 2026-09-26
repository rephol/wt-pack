# WP-22 — Jev on the board: triage + dedupe new tickets

## Goal

When a ticket is created (web board, `wt-ticket new`, the auditor — all go through `POST /api/tickets`), Jev
suggests type, size, priority and owner role (planner vs worker), and flags likely duplicates among open tickets.
A suggestion is applied only to a field the creator left empty; the card and detail show "Jev suggested" with a
one-click undo per field. Duplicates show as links, never merged. Fail-open: no key, a timeout or an error leaves
the ticket exactly as created today.

## What research established

- **One entry point.** Every create path hits `server.mjs:1707-1711`
  (`if (req.method === 'POST' && parts.length === 2) { … const t = await tickets.create(project, b, author)`);
  `wt-ticket` and the web both POST there (`wt-ticket/scripts/wt-ticket` uses `call … /api/tickets`,
  `web/src/board.tsx:300` `send<Ticket>('/api/tickets', 'POST', …)`). The auditor uses `wt-ticket`. One hook covers all.
- **"Left empty" must come from the request, not the ticket.** `tickets.mjs` `create()` fills defaults:
  `type: f.type ?? 'feature'`, `size: f.size ?? null`, `priority: f.priority ?? 0`. A stored `feature` cannot be
  told apart from a chosen one, so the server records which of `type/size/priority` were absent in `b` before
  calling `create`.
- **Shared client exists:** `wt-shared/scripts/typesafe.mjs:171` `judge(feature, state, questions, { timeoutMs = 2000, … pick })`
  — 2s timeout, returns `null` on no key/error (fail-open), logs every call to `jev-calls.jsonl`, which
  Settings › Observability already reads (`server.mjs:1914` "Jev call stats from jev-calls.jsonl"). The server wraps
  it as `jevAsk(feature, state, questions, pick)` (`server.mjs:1733`) with the key from `cfg`, and gates with
  `jevOn(feature)` (`:1732`). Reuse both; no new client.
- **Routing question to reuse:** `wt-handoff/scripts/jev-route.mjs:9-13` exports
  `route = { questions: () => ({ plan: { type: 'noul', instructions: 'Does this request need an implementation plan before any code is written?' … } }), decide: (a, min = 0.75) => … 'planner' : 'worker' }`.
  Import `route` and merge its question into the triage call; owner = `route.decide(answers, minFor('route'))`.
- **Switches are declared once** in `config.mjs:22-28` (`['INBOX_RANK', 'Inbox urgency', 'off']` …) and rendered
  in Settings from `web/src/integrations.tsx:185-194` (`JEV` list of `[key, description]`). Add one row to each.
- **Eval harness:** `wt-shared/scripts/jev-eval.mjs` maps `feature → 'module#export'` with
  `{questions(state), decide(answers)}` (`EVALUATORS`, lines 15-24) and fixtures at
  `wt-shared/jev-fixtures/<feature>.json` = `[{state, expect}]`.
- **Board today:** WP-1..WP-22 on `wt-pack` (`wt-ticket list`), each with an owner-set type and most with a size —
  usable as labelled fixtures for type and size. Priority is 0 (unset) on most [unsourced: not counted this
  session; the implementer counts before claiming a priority fixture], so priority is scored but not evaluated.

## Approach

- **Asynchronous, after create.** `POST /api/tickets` responds exactly as today; the server then fires
  `triageTicket(t, empty)` without awaiting. When Jev answers, it applies suggestions through a new
  `tickets.jevApply(id, …)` (a `mutate` like `claim`) only if each field **still** equals its created default
  (a user edit in the meantime wins). Rejected: awaiting Jev in the request (adds up to 2s to every
  `wt-ticket new`, and the ticket's own `feature` default would already be visible to the CLI's output).
- **One Jev call per ticket.** Questions: `type` (choice over `TYPES`), `size` (choice S/M/L), `priority` (score
  1-4 mapped to Linear's scale; 0 kept when confidence is low), `plan` (the route question, verbatim), and
  `dup_<ID>` nouls for at most 5 candidates. Candidates are open tickets (column ≠ `done`) on the same board with
  the highest title+body word overlap, computed locally. `ponytail:` word-overlap prefilter, embeddings only if
  recall is visibly bad.
- **Stored on the ticket, server-owned:** `t.jev = { at, applied: { <field>: { from, to } }, owner: 'planner'|'worker'|null, dupes: [id] }`
  plus one history entry `{ kind: 'edit', author: 'jev', text: 'jev: type, size' }` when anything applied.
  `clean()` never accepts `jev` from clients.
- **Undo:** `POST /api/tickets/:id/jev-undo { field }` sets the field back to `applied[field].from`, removes
  `applied[field]`, history `edit` by the caller. Any later manual edit of that field also drops its
  `applied` entry (so the badge does not claim a value the user chose).
- **Owner is advisory.** Shown as "Jev: needs a plan" / "Jev: worker-ready"; it never sets `assignee` (assignee is
  an agent name; routing a real agent stays the orchestrator's job).
- **Switch:** `WT_JEV_TICKET_TRIAGE`, default `on` (event-driven, one call per created ticket — the
  config's own rule: "ON where calls are rare and event-driven", `config.mjs:20`).
- **Feature module:** new `wt-dashboard/ticketJev.mjs` exporting `ticketTriage = { questions(state), decide(answers) }`
  and `candidates(ticket, open)`. A separate file rather than `tickets.mjs` because WP-21 rewrites `tickets.mjs`
  in parallel; this keeps the two branches from conflicting beyond the `jevApply`/`jevUndo` methods.
- Deferred: "Suggest next" ordering of Ready (ticket marks it optional).

## Review corrections (binding — override unit text below where they differ)

1. **Web always sends priority:** `web/src/board.tsx:301` posts `priority: Number(draft.priority)` (0 default), so
   `priority` counts as empty when `b.priority === undefined || b.priority === 0`.
2. **Eval compares by JSON equality** (`jev-eval.mjs:49` `JSON.stringify(got) === JSON.stringify(c.expect)`):
   register a separate export `ticketType = { questions, decide: (a) => decide(a).type }` as evaluator
   `ticket_triage`; fixture `expect` is the type string. The U1 hedge is resolved.
3. **Thresholds pass through:** follow `server.mjs:1738-1740`: compute `min` once, call
   `jevAsk(..., (x) => ticketTriage.decide(x, min))` and `decide(a, min)`; the route question uses
   `route.decide(a, minFor('route'))`, never its 0.75 default.
4. **Mixed question types in one call are unproven** (every caller today uses one type). U1 starts with one live
   probe (`judge` with a choice + score + noul); if it fails, split into two calls. Pass `timeoutMs: 5000` —
   the call is off the request path (extend `jevAsk` with an optional opts arg).
5. **Priority mapping:** score over 4 levels (urgent, high, medium, low); `priority = round(score) + 1`, applied
   only when `confidence ≥ 0.6`, else left at 0.
6. **Cross-skill import is accepted:** `ticketJev.mjs` imports `route` from `../wt-handoff/scripts/jev-route.mjs`
   (the server already imports `../wt-shared`; both ship in the same pack).
7. The Settings row key is exactly `TICKET_TRIAGE` in both `config.mjs` and `integrations.tsx`.
8. **Default check tightened:** `jevApply` skips any field that has an `edit` history entry after `create`, not
   only fields whose value moved off the default (covers `size` cleared back to null).
9. **Fail-open harness:** the hook is an exported `triageTicket(t, empty, { ask, tickets, min })` in
   `ticketJev.mjs`; `ticketJev.test.mjs` runs it with a stub `ask` returning `null` (ticket unchanged) and a
   canned answer (only empty fields filled). DoD 4 is this test.

## Implementation units

### U1 — triage module + fixture
Files: `wt-dashboard/ticketJev.mjs` (new), `wt-dashboard/ticketJev.test.mjs` (new), `wt-dashboard/package.json`
(test list), `wt-shared/scripts/jev-eval.mjs` (`ticket_triage` line), `wt-shared/jev-fixtures/ticket-triage.json` (new).
- `questions(state)` where `state = { title, body, candidates: [{id,title}] }`; `decide(a)` →
  `{ type, size, priority, owner, dupes }` (null per field when unanswered or below its threshold:
  choice confidence < `minFor('ticket_triage', 0.6)`, dup noul ≥ 0.8).
- Fixture from WP-1..WP-21: `{ state: {title, body, candidates: []}, expect: {type, size} }`; jev-eval compares
  `decide(...).type` [the implementer checks how `jev-eval.mjs` compares an object `expect`, and uses
  `expect: type` only if it compares strings].
- Verify: `ticketJev.test.mjs` — decide maps canned answers; candidates() picks the overlapping ticket and skips
  `done`; `node wt-shared/scripts/jev-eval.mjs ticket_triage` prints accuracy (exit 3 without a key is acceptable).

### U2 — server + store
Files: `wt-dashboard/tickets.mjs` (`jevApply`, `jevUndo`, drop `applied[field]` on manual edit in `patch`),
`wt-dashboard/tickets.test.mjs`, `wt-dashboard/server.mjs` (create hook, undo route), `wt-dashboard/config.mjs`.
- Create hook: `const empty = ['type','size','priority'].filter((k) => b[k] === undefined)`; after `send`, if
  `jevOn('TICKET_TRIAGE')` → `jevAsk('TICKET_TRIAGE', state, ticketTriage.questions(state))` →
  `tickets.jevApply(t.id, decide(a), empty)`; errors logged, never thrown.
- Verify: `tickets.test.mjs` — `jevApply` fills only empty fields still at default; a field edited before the
  answer is left alone; undo restores `from`; manual patch clears `applied[field]`; `jev` in a PATCH body is ignored.

### U3 — web
Files: `wt-dashboard/web/src/boardData.ts` (`jev?` on `Ticket`), `wt-dashboard/web/src/board.tsx`
(card chip, detail section), `wt-dashboard/web/src/integrations.tsx` (switch row), `wt-dashboard/web/src/boardData.test.ts`.
- Card: small "Jev" chip when `jev.applied` non-empty or `dupes.length`. Detail: per applied field
  "Jev suggested <to> · Undo" (button → jev-undo), owner line, "Possible duplicate of WP-n" links opening that ticket.
  No native dialogs (`noNativeDialogs.test.ts`).
- Verify: `npx tsc --noEmit -p .`, `npm test`, `npm run build`; agent-browser (`--session <agent name>`): create a
  ticket with a throwaway title on a **temp project** board, see the chip within ~5s (key present) and undo one field.

### U4 — docs
Files: `wt-dashboard/README.md` (Jev features list), `wt-ticket/SKILL.md` (one line: new tickets may get Jev
suggestions; fields you set are never changed).

## Files

- new: `wt-dashboard/ticketJev.mjs`, `wt-dashboard/ticketJev.test.mjs`, `wt-shared/jev-fixtures/ticket-triage.json`
- modified: `wt-dashboard/tickets.mjs`, `wt-dashboard/tickets.test.mjs`, `wt-dashboard/server.mjs`,
  `wt-dashboard/config.mjs`, `wt-dashboard/package.json`, `wt-dashboard/web/src/boardData.ts`,
  `wt-dashboard/web/src/boardData.test.ts`, `wt-dashboard/web/src/board.tsx`, `wt-dashboard/web/src/integrations.tsx`,
  `wt-dashboard/README.md`, `wt-shared/scripts/jev-eval.mjs`, `wt-ticket/SKILL.md`

Commits: one per skill (wt-dashboard, wt-shared, wt-ticket).

## Definition of Done

1. `cd wt-dashboard && npm test` passes, including the new `ticketJev.test.mjs` and `tickets.test.mjs` cases listed in U1/U2.
2. `npx tsc --noEmit -p web` clean and `npm run build` succeeds.
3. `node wt-shared/scripts/jev-eval.mjs ticket_triage` runs (accuracy printed, or exit 3 with no key) — output quoted in the report.
4. With `WT_JEV_TICKET_TRIAGE=off` or no key, `POST /api/tickets` returns and stores the same ticket as before (test).
5. Settings lists "Ticket triage"; Observability shows `ticket_triage` calls after one real create (screenshot in the report).

## Risks and deferred

- WP-21 (SQLite store) rewrites `tickets.mjs` internals; `jevApply`/`jevUndo` are written on top of `mutate()`,
  which WP-21 keeps by name. Whichever lands second rebases; conflict is limited to those methods.
- A create followed by an immediate manual edit: the "still at default" check prevents an overwrite, but a user
  who deliberately sets `feature` after create looks identical to the default — Jev may then change it. Accepted;
  undo covers it.
- Deferred: "Suggest next" for Ready; cross-board duplicate search; learning thresholds from undo rate.
