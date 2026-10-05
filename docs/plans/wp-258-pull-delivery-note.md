# WP-258 — pull delivery: what was left to build

Point-in-time note (2026-10-05), written while implementing the ticket after the WP-259 spike.

## The ticket's premise is already in the tree

WP-258 asks for agents to fetch their next queued message from the dashboard when idle, with typed text only a wake-up.
The WP-210 delivery mod already does the pull half, in the one plugin's `hooks/register.ts` chain
(`skills/wt-room/mod/hooks/register.ts`): it says hello every 20 s, pulls `GET /api/deliveries/next` every 3 s and again
right after each `turn.complete`, submits the item as a plugin-origin prompt only while no turn runs, and acks it. A
queued row therefore wakes an idle agent within ~3 s and waits behind a busy one (WP-259: a Stop hook measured ~2 s per
hop; the mod's turn.complete pull is the same trigger, and the engine refuses a second Stop hook on the event, so none was
added). The WP-257 table already records the state (`queued → delivered`) and the dashboard pastes a row when the mod goes
quiet. Building the ticket's Stop hook, courier session or `task waiting, id X` wake-up would duplicate this.

## What was actually wrong

`messageSweep` (WP-257 expiry) looked only at the message row. A `handoff`/`dispatch`/`routine` queued behind a turn longer
than 5 min stayed `queued`, so the sweep re-sent it (a second queued delivery row of the same envelope, executed after the
first), twice more, then flagged **No ack** in the Inbox, although nothing had been lost.

## Done

- `Deliveries.queuedFor(pane, envelopeId)`: is that envelope still waiting in the pane's queue.
- `Messages.sweep({ pending })`: a pending row is skipped (no resend, no attempt counted, no flag); when the queue no
  longer holds it (the mod went quiet and the dashboard pasted it, or the row was acked) the normal expiry applies.
- Tests in `messages.test.mjs` and `deliveries.test.mjs`; `docs/features.md` Queued delivery.

## Not done, and why

- Slash-command traffic (`/goal …`) is still typed, not queued: a plugin-origin prompt does not run slash commands (WP-240/243).
- A pane without the mod (session started before install) still gets keystrokes; there is nothing to pull with.
- No MCP fetch tool: a tool call needs a running turn, so it cannot wake an idle agent (WP-259), and the mod already fetches.
