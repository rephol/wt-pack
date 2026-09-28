# WP-147: Agent DND toggle + ticket pairing (worker + buddy)

Base: `origin/main` @ c17b602. Branch `wp-147-dnd-pairing`. Two features, shipped as two parts. DND goes
first because pairing uses it.

## Where agents get picked (evidence)
Everything that hands work out runs through **one** function: `candidates()` in
`skills/wt-handoff/scripts/handoff.sh:207-227`. It keeps agents that are `idle` or `done`, in the pool
workspace and the main checkout, and it already reads pane tokens (`$panes[$a.pane_id]` → `model`, `effort`).
- Board Dispatch calls handoff.sh (`wt-dashboard/dispatch.mjs:8` `HANDOFF = …/wt-handoff/scripts/handoff.sh`).
- wt-watch-prs dispatch calls handoff.sh (`watch-prs.sh:189`). Its re-dispatch prefers "the reviewer that held
  this PR … else handoff reuses a free pool reviewer" (`:179`).
- Routines: `routines.mjs` never mentions handoff. How a routine picks its agent is **[unsourced]**. The worker
  must find it (grep for `agent prompt` / `pane` in `routines.mjs` and `server.mjs`) and apply the same filter.
- WP-143 retire: `retireIdle()` in `wt-dashboard/server.mjs:1012-1017` is a pure function over agents' `tokens`,
  and it already skips agents that carry `task`.
- Reconcile: `dispatch.mjs:193` `reconcile()` sends a card back to Ready when its assignee is gone.
- Pane tokens are set with `herdr pane report-metadata --token k=v` (`server.mjs:406`). `roles.mjs:30-31`
  sorts keys into `MIRRORED_KEYS` and `LIVE_KEYS`. Per CLAUDE.md traps, tokens are limited to ≤32 keys with
  values ≤80 chars, and unknown keys are dropped from the mirror.

**The design follows from this:** filter once in `candidates()` and in `retireIdle()`. Every caller that routes
through them inherits the filter. Don't add a guard in each caller.

## Settled decisions (headless run: these are assumptions; the ticket says the user approved the feature)
- **Who picks the buddy:** the planner, at handoff. The default buddy is the planner itself (it wrote the plan).
  A ticket Dispatch hands out with no plan gets a free **reviewer** from the pool as its buddy, picked by the
  same `candidates()` with `--role reviewer`.
- **Model routing:** the worker keeps its routed tier (WP-128/143). A reviewer buddy is spawned or reused at the
  reviewer role's default tier, and routing never escalates it. A planner buddy keeps the tier it already has.
- **Escalation:** if a pair member is gone, reconcile picks a replacement of the same role and adds a ticket
  comment: `pair: <old> → <new> (gone)`. If no replacement can be had, reconcile posts an Inbox item to the
  orchestrator and leaves the card in its column.
- **DND auto-off:** a project setting, `dndAutoOffHours` (0 means never). Default 0. `[unsourced]`: the
  project-setting helper to reuse is `wt-shared/scripts/project-setting.mjs` (seen used at `watch-prs.sh:44`).

## Part A: DND

### A1: the token and the CLI
- `dnd` pane token: value `1` or an ISO time at which it switches off (for auto-off), cleared when off. Add
  `dnd` to `LIVE_KEYS` (`roles.mjs:31`): it is live state and must never be mirrored.
- `agents.sh dnd <name|pane> on|off`: resolves the pane the way `rm` does and calls
  `herdr pane report-metadata --token dnd=…` / `--clear-token dnd`.
- Test: extend `wt-agents` tests to cover setting and clearing the token with a PATH-shimmed fake `herdr`, the
  same pattern `respawn.test.mjs` uses **[unsourced]** (the worker confirms that file's shim pattern).

### A2: skip DND agents in every pick
- `handoff.sh` `candidates()`: add `select(($t.dnd // "") == "")` to the jq filter. The jq expression binds
  `$t` inside `.result.agents[]` **after** the select, so the filter goes after `($panes… ) as $t`.
- `handoff.sh --pane <id>`: when the target has `dnd`, print `warning: <name> is DND` to stderr and still send.
- `retireIdle()` (`server.mjs:1012`): exclude `a.tokens?.dnd` and `a.tokens?.pair`.
- Routines: the same exclusion, wherever the grep above leads.
- Tests: `handoff.test.mjs` gets a DND agent that is not listed by `--list`. `retireIdle`'s unit test gets a DND
  agent and a paired agent, and neither is retired.

### A3: dashboard
- Server: `POST /api/agents/<key>/dnd {on:boolean}` sets or clears the token through the existing
  `report-metadata` path (`server.mjs:406`), behind the existing session and Origin checks.
- Web: a toggle on the agent page and in the room member list, and a moon badge wherever the agent's state
  badge renders. No native dialogs (`noNativeDialogs.test.ts`).
- Auto-off: the 4 s server tick (`server.mjs:2929`) clears `dnd` values whose time is past.

## Part B: pairing

### B1: the data
- Ticket field `pair: { worker: {name,pane}, buddy: {name,pane,role} } | null`. It is validated at the boundary
  in `tickets.mjs` (`:29`, "unknown fields dropped", so the field must be added there) and written into history
  as `{kind:'pair', …}` just like `assign` (`tickets.mjs:191-193`).
- Pane token `pair=WP-N` on both agents, added to `LIVE_KEYS`. A paired agent is unavailable to everyone else
  because A2's filter also drops `pair` agents from `candidates()`. The exception is a hand-off **for that
  ticket**: `handoff.sh --task WP-N` accepts an agent whose `pair` equals `WP-N`.

### B2: setting the pair
- `handoff.sh --buddy <pane|self>`: at the moment the worker is chosen, write `pair=<ticket>` on the worker and
  the buddy, and `PATCH` the ticket's `pair`. `self` means the sending pane (`HERDR_PANE_ID`, resolved with
  `canonicalPane()` per the CLAUDE.md trap).
- wt-plan's handoff reference (`skills/wt-plan/references/handoff.md`) passes `--buddy self`. The prompt stays
  three lines, and only the command line changes.
- Dispatch (`dispatch.mjs`): for a worker-role ticket with no pair, pick a free reviewer as the buddy.

### B3: routing follow-ups to the pair
- Anything aimed at a paired ticket goes to its pair members by pane: review rounds, questions and send-backs
  addressed with `--task WP-N`. Implement in `handoff.sh`: when `--task WP-N` names a ticket with a `pair` and no
  `--pane` was given, use the pair's worker, or its buddy when `--role reviewer`.
- wt-watch-prs `dispatch N`: when the PR's branch maps to a paired ticket (`wp-N-…`), hand the review to the
  buddy (pass `--pane`).

### B4: release and repair
- On Done (`server.mjs:1934` onDone): clear `pair` on both panes and `pair` on the ticket. Then WP-143 retire
  runs as it does today, which works because A2 skips only agents that still carry the token.
- Reconcile (`dispatch.mjs:193`): a pair member is gone → apply the escalation rule above.

### B5: dashboard
- A pair chip on the board card (worker + buddy names), and a "paired · WP-N" indicator beside the moon badge.

## Definition of done
Each item is checkable from a transcript of commands and their output:
- `node --test skills/wt-handoff/scripts/*.test.mjs` passes, including new cases: a DND agent is not listed,
  a paired agent is listed only for its own ticket, and `--pane` to a DND agent warns.
- `cd skills/wt-dashboard && npm test` passes, including new cases: retireIdle skips `dnd`/`pair`, the ticket
  `pair` field round-trips and is cleared on Done, and reconcile replaces a gone member and comments.
- `npx tsc --noEmit -p tsconfig.app.json` is clean.
- A live check with a **throwaway pool** (never the user's agents): spawn two workers, `agents.sh dnd <one> on`,
  and `handoff.sh --list` shows only the other. Then clean up.
- `docs/features.md` documents DND and pairing, and the dashboard shows the moon badge and the pair chip
  (agent-browser screenshot).
- After merge: update the orchestrator role memory ("DND or paired agents are unavailable") with
  `wt-memory remember … --scope role`.

## Order
A1 → A2 → A3 → B1 → B2 → B3 → B4 → B5. Each part is independently shippable. Commit per skill touched
(CLAUDE.md).

## Risks
- The `pair` filter makes a paired worker invisible to its own later hand-offs unless `--task` matches.
  Test that exception explicitly.
- Token budget: `dnd` and `pair` add 2 keys. There are ≤32 allowed, and the current count is **[unsourced]**.
