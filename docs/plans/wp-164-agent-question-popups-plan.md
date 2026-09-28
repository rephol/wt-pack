# WP-164: Agent questions as room/Inbox popups (wt-ask cards A + mirrored native picker B)

Base: `origin/main` @ ed3deb5, which includes WP-165's multi-line tab-bar parser. Branch `wp-164-agent-question-popups`.

## What research found (evidence)
- **Most of B already exists; the ticket underestimates this.** The server parses the pending AskUserQuestion
  picker off the pane: `parsePicker(text, raw)` at `server.mjs:283`, whose shape comment is at `:250-262`,
  and WP-165 makes the tab bar parse when it wraps across lines (`:263-272`). It drives the picker with verified
  key plans: `answerPlan()` and `chatPlan()` (`server.mjs:1792-1836`). The comment there records the reliability
  research the ticket asks for: "single-select: digit k selects option k AND advances", "multiSelect: digit k
  toggles … Tab is NOT safe", "Preview layout: digit only moves focus, Enter selects+advances, no 'Type
  something'", and "Review step: digit 1 submits, 2 cancels". `answerQuestion()` (`:1837-1874`) refuses stale
  answers with `409 'that question is no longer on screen'`. The web side has a complete card:
  `PickerCard` (`web/src/App.tsx:772`) plus `useHeldPicker` (`:748`, which polls `?visible=1` and drops a
  picker only after two misses). It is mounted **only on the agent page** (`App.tsx:1601`). B's real work is
  therefore **surfacing the existing card** in rooms and the Inbox. The keystroke work is not new.
- Inbox: `inbox.mjs:8-9` lists `KINDS` and `ACTIONABLE`. `question` already exists; it comes from a
  `needs_you` transition with `target: { agent }` (`:14-20`). `toResolve()` closes it when the agent no longer
  needs you (`:34`). That covers a mirrored picker's lifecycle for free.
- Messages to agents are wrapped with `wrap()` from `wt-shared/scripts/wt-message.mjs`, which `server.mjs:11`
  imports. `handoff.sh --reply <pane> "text"` sends a `kind=reply` message.
- The room composer is Astryx `ChatComposer` in `web/src/rooms.tsx:466-485`. Chips go directly above it.
- Rooms CLI: `skills/wt-room/scripts/room` (POSIX sh + curl). Identity comes from `$HERDR_PANE_ID`, and the
  server rejects unknown panes. `wt-ask` copies this pattern.
- No native dialogs (`noNativeDialogs.test.ts`): the popup is an in-page Astryx dialog or sheet.

## Settled decisions (headless: stated assumptions)
1. **Storage:** a new `asks` table in `data/wt.db`, created through `store.mjs` the way `notifications` is.
   Columns: `id, pane, agent, project, room, ticket, questions JSON, status (open|answered|resolved|
   undeliverable), answer JSON, created, closed`. The Inbox gets one new kind, `ask` (added to `KINDS` and
   `ACTIONABLE`), with `target: { ask: id, room, agent }`. It resolves when the ask closes. A mirrored picker
   (B) keeps the existing `question` kind and is **not** stored in `asks`: the screen is its source of truth.
2. **Question shape:** the same as AskUserQuestion, so one popup renders both. That is 1–4 questions, each
   `{question, header, options[{label, description}], multiSelect, recommended?}`, plus free text always
   allowed. Validated at the boundary; question text is untrusted data.
3. **Answer delivery:** the server sends the answer as a `<wt-message kind=reply from="user">` through
   `handoff.sh --reply <pane>`. If the pane is gone, the ask becomes `undeliverable`, the answer is kept, and
   the Inbox gets a `server` note. If the agent is busy, the reply is queued the way `--reply` already
   handles a busy pane **[unsourced: confirm how `--reply` behaves on a working pane before relying on it]**.
4. **Which tool:** the user's own session uses the native tool (B mirrors it). Room, handoff and dispatch work
   uses `wt-ask`. Record this in the wt-ask SKILL.md and in wt-plan's question step (WP-163 alignment).
5. **Chip data** (orchestrator comments, 14:32–14:33): one chip per open item, which is either an `ask` in
   this room or a B picker from an agent that is a member of this room **[unsourced: the room membership
   field; the worker reads `rooms.mjs`]**. The label is `? <agent> · <header or ticket>`. Chips are ordered
   oldest first in a sideways-scrolling row. On a phone (the existing `phone` breakpoint), more than 3 chips
   collapse into one `N questions` chip that opens a list. The pulse stops under `prefers-reduced-motion`
   and after the chip is first viewed (per viewer, `localStorage`, try/catch). A multi-question ask is one
   chip, and its popup shows the questions as steps.

## Units
### U1: `asks` store + API (server)
`asks.mjs` (store functions, pure validators) and routes:
- `POST /api/asks` (agent, pane-authenticated like `room post`)
- `GET /api/asks?room=&open=1`
- `POST /api/asks/:id/answer` (user, session cookie + Origin)
- `POST /api/asks/:id/resolve` (the asking pane)

Answering → deliver (decision 3) → `status=answered` → Inbox item resolved → `broadcastEvent('asks', …)`.
Tests (`asks.test.mjs`): validation rejects bad shapes; answer on a closed ask → 409; resolve by a
different pane → 403; a gone pane → `undeliverable`.

### U2: `wt-ask` CLI (new skill `skills/wt-ask`)
`wt-ask "<question>" --option A --option B [--recommend A] [--multi] [--header H] [--ticket WP-N]
[--room slug]`, or `--json <file>` for 1–4 questions. `--room` defaults to the room this turn came from if
known, else the project room **[unsourced: how an agent knows its originating room; the worker checks
wt-room's SKILL.md]**. It prints the ask id. `wt-ask --resolve <id>` closes it. Includes a SKILL.md with the
decision-4 rule and `setup` linking. Test: a stubbed server exercising post, resolve and bad args.

### U3: popup (web)
`QuestionPopup` renders either an `ask` (steps, recommended option first and marked, free text) or a B
picker by **reusing `PickerCard`** (move it out of `App.tsx` into its own module, e.g. `pickerCard.tsx`;
it is a distinct name, so no case-insensitivity trap) together with `useHeldPicker`. It is an Astryx sheet
on a phone and a dialog on desktop.

### U4: room chips (web)
A chip row above `ChatComposer` in `rooms.tsx`, using the data from decision 5. It follows the pulse, collapse
and ordering rules. Clicking a chip opens U3, and the chip disappears when the item closes.

### U5: Inbox
The `ask` and `question` items open U3 in place instead of navigating away.

### U6: docs
`docs/features.md` (wt-ask, chips, popup), the CLAUDE.md skill map row for `wt-ask`, and the decision-4
line in `skills/wt-plan/SKILL.md` step 4.

## Definition of done
Every item can be checked from a transcript of commands and their output:
- `cd skills/wt-dashboard && npm test` passes, including `asks.test.mjs`.
- `node --test skills/wt-ask/scripts/*.test.mjs` passes.
- `npx tsc --noEmit -p tsconfig.app.json` is clean, and `noNativeDialogs.test.ts` still passes.
- A live check with a **throwaway agent** in a temp room: `wt-ask` posts, and a chip appears (agent-browser
  screenshot at 1440 and 390 px). Answering in the popup delivers a `kind=reply` wt-message to that pane
  (visible in `herdr pane read`). `--resolve` removes the chip. Clean up afterwards.
- A B check: a throwaway agent's AskUserQuestion shows as a chip in its room and is answered from the
  popup. This covers the single-select, multiSelect and preview layouts that `answerPlan` supports.
- `./setup doctor` is clean with the new skill linked.

## Order and commits
U1 → U2 → U3 → U4 → U5 → U6. Make one commit per skill touched (`wt-dashboard`, `wt-ask`, `wt-plan`,
docs).

## Risks
- Duplicate cards: an agent that runs `wt-ask` and also opens the native picker. Decision 4 says to use one
  or the other. Don't dedupe in code.
- An answer can race a terminal answer. For B, the existing 409 stale check covers this. For A, answer
  and resolve are both conditional on `status='open'`, done in one SQL `UPDATE … WHERE status='open'`.
