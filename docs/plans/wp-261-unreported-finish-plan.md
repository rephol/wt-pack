# WP-261 — flag a handed-off agent that finished without reporting

## Problem (verified)
WP-259 measured that `notify_when_idle` reaches the sender only after the sender's own turn ends
(`docs/plans/wp-259-pull-delivery-spike.md`, row 5: "useless as a signal for a sender mid-task"). The only
mid-task signal is the worker's `handoff.sh --reply`; a worker that goes idle, exits or crashes without one sends
nothing, and nothing in the dashboard notices: the WP-257 sweep only looks at `state IN ('queued','delivered')`
(`skills/wt-dashboard/messages.mjs:106`), so once a message is **acknowledged** it is never looked at again.

## Decision: option (b), in the existing sweep
Smallest change that closes the gap: extend the WP-257 expiry pass (`messageSweep`, `server.mjs:~2468`, runs every
30 s) with a second check over **acknowledged** handoff/dispatch rows. Rejected: (a) a new Dispatch watcher —
duplicates the agent/card lookups the sweep already has; (c) docs only — leaves the crash case silent. The ticket
asked for "the smallest that closes the gap"; no user question needed. Docs still say notify_when_idle is a hint.

## Rule
An `acknowledged` row with `kind ∈ ACK_KINDS` and a `ticket` is **unreported** when, for at least `quietMs`
(default 10 min) since its `updated`:
- the card has not moved on — `movedOn(card, row)` is false (`messages.mjs:35`: done/blocked, or anyone but
  dispatch moved it after delivery; a worker moving building → review counts as reporting), **and**
- the target is not working on it: absent from `agents()` (exited/crashed), or status not `working`/`blocked`.

Then: `move(id, 'expired', { error: 'agent finished without reporting' })` (`acknowledged → expired` is already
legal, `messages.mjs:14`) and `flag(row)`. Moving to `expired` is the dedupe: the row leaves `acknowledged`, so it
is flagged once, and the board badge already counts `expired` as open (`byTicket`, `messages.mjs:89`). No schema change.
Ticketless acknowledged rows are skipped (no card to judge "reported" by) — `ponytail:` note says so.

Quiet window: idle for one sweep is normal between a worker's turns (its `/goal` re-prompts). The window is measured
from the row's `updated` (= ack time); an agent seen `working` doesn't reset it — accepted ceiling: a worker that acks,
works 10 min, then idles briefly between turns could be flagged early. Mitigation in the rule: require the
not-working condition on **two consecutive sweeps** is extra state; skip it. `ponytail:` comment names the ceiling.

## Units
1. **`messages.mjs`** — new `async unreported({ moved, busy, flag }, { quietMs = 10 * 60_000 } = {})` beside `sweep`:
   selects `state = 'acknowledged' AND ticket IS NOT NULL AND updated < cut`, filters `ACK_KINDS`, skips when
   `moved(row)` or `busy(row)` is true, else moves to expired + flags; returns `[{id, did:'unreported'}]`.
   Errors in deps → treat as "don't flag" (`.catch(() => true)`), same fail-safe style as `sweep`.
   Tests in `messages.test.mjs` (fake clock, as existing sweep tests do): not due yet → []; due + idle + card not
   moved → flagged once, then [] on the next pass; card moved on → not flagged; target working → not flagged;
   target absent → flagged; ticketless → not flagged.
2. **`server.mjs` `messageSweep`** — after `messages.sweep(...)`, call `messages.unreported({ moved: (row) =>
   tickets.get(row.ticket).then((c) => movedOn(c, row), () => true), busy: (row) => ags.some((a) => a.id ===
   row.target && ['working','blocked'].includes(a.status)), flag })` with an Inbox item key
   `message-unreported|<id>`, title `<ticket>: <target> finished without reporting`, body naming the kind and that
   the pane is idle/gone, target `{ ticket }`.
3. **Docs** — `docs/features.md` messages section: one bullet for the new flag, and that `notify_when_idle` is a
   hint only (reaches the sender after its turn). `skills/wt-handoff/SKILL.md`: one line saying the same.

One commit for wt-dashboard (+features.md), one for wt-handoff.

## Definition of done
- `cd skills/wt-dashboard && npm test` green, including the six new `unreported` cases.
- No server restart required for review; after merge, one `npm run service:restart`.
- Worker: no e2e writing or running (done check is the unit tests).

## QA brief
Not a screen change beyond an Inbox card. At 412x700 and iPhone 13: Inbox shows a card
"WP-x: <agent> finished without reporting" that opens the ticket. Reproduce with a throwaway agent and a temp
ticket (never a real agent): hand off, `--ack`, let it go idle >10 min without moving the card. Done when the card
appears once and the board badge shows the message as open.

## Risks
- False positives from long idle gaps between a worker's own turns (see ceiling above).
- `agents()` failing returns early already (`server.mjs`: `if (!ags) return`) — no flag on a dashboard hiccup.
