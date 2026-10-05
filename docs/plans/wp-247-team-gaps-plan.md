# WP-247 — Teams: close the remaining team-boundary gaps

## Goal

A team (WP-237/238) should keep its roster and its work inside its boundary. Today an idle team member can be
retired, team workers can fill the plain pool cap, a team that loses a member is never refilled, a spawn can
join a team as a persona the team doesn't have, a direct `--pane` handoff can give a team agent another
team's ticket, and a hand-started persona agent can't be added to a team. This ticket closes those gaps and
records how routines and room @mentions treat team agents.

## What research corrected

- **(2) is narrower than the ticket says.** The pool cap in `handoff.sh` already skips team handoffs:
  `skills/wt-handoff/scripts/handoff.sh:584` `if [ "$role" = worker ] && [ -z "$team" ]; then # a team is capped by its roster`.
  The leak is in the **count**: a plain handoff counts every agent in the worker workspace whose persona token
  equals `$persona` (`:592-593`, `select(($pt[.pane_id // ""] // "") == $persona)`). A team member spawned from
  a base role (`members: [worker x2]`) has no persona token, so it counts against the plain cap. The cap is
  only read here; the dashboard just stores the setting (`project-settings.mjs:34`).
- **(4) is already half done for handoff.** When `handoff.sh --team` spawns, it refuses a persona the team
  doesn't have and a full roster (`:604-616`, `team $team has no $want member` / `team full`). The gaps:
  `agents.sh spawn <persona> --team T` tags any persona with `team=T` with no check
  (`skills/wt-agents/scripts/agents.sh:304` `${team:+--token "team=$team"}`), and the bulk
  `agents.sh spawn --team T` (`:140-147`) spawns every member × count **whatever is already up**, so it
  overfills. The Teams page Spawn button calls this bulk form (`server.mjs:1021`).
- **(6) routines are already decided.** `skills/wt-dashboard/routines.mjs:231-233` skip a team member unless
  the routine names that agent (`!(x.paneTokens?.team && !t.agent)`). This plan keeps that.
- **(1)** is as stated: `retireIdle` (`server.mjs:1242-1247`) filters on role, model, task, dnd, pair and
  status, but not on team.

## Approach

Decisions (dispatch had no user to ask, so these are planner assumptions; challenge only on feasibility):

- (1) Never retire a team member: `retireIdle` adds `&& !a.tokens?.team`. Rejected: "keep each member's
  count", because the roster count already caps a team, so the most it could ever retire is extras that (4)
  now stops from being spawned.
- (2) The plain cap counts only teamless agents: add `select((.tokens.team // "") == "")` to the count.
- (3) Refill uses the same bulk spawn, which now means **fill missing seats** (see 4). A new
  `refillTeams(project)` runs next to `retireIdleWorkers(project)` (`server.mjs:2388`, the dispatch-settled
  hook). For each team that has an open card (`t.team === name && column !== 'done'`) and fewer live agents than its
  roster (`teamView(...).load.agents < load.of`, `teamview.mjs:34`), it runs `agents.sh spawn --team <name> <co>`.
  It runs at most once per team per 10 min (an in-memory timestamp), so a spawn that keeps failing can't loop.
  Rejected: refilling from the watchdog, which has no project/team model, while Dispatch already loads
  `teamsOf`.
- (4) `agents.sh`, single spawn with `--team T`: refuse (exit 2) unless `${persona:-$role}` is a member of
  T, and refuse (exit 3, `team full`) when T already has `count` live panes of it. These are the same checks
  and messages as `handoff.sh:604-616`. Move them into one `teams.mjs seats <team> <persona> [--cwd]` that
  prints the roster count, and have both scripts call it. The live count stays in jq on `herdr pane list`.
  Bulk spawn with `--team T` spawns only `count − live` per member and prints nothing when nothing is missing.
- (5) `handoff.sh --pane <id>` with a ticket (`$local_ticket`, `:412`): if the target's `team` token differs
  from the card's `team` field (read with `wt-ticket show --json`), refuse with exit 2 and
  `<name> is on team X; <ticket> is team Y's` (the wording of `server.mjs:2582`). This holds in both
  directions, including teamless versus team. A card with no team and a teamless agent pass. With no board
  (server down, Linear key) it skips the check, as `:259` does. Also flag it on the Teams page: in
  `teamView`, an agent whose ticket's card belongs to another team gets `offTeam: true`, shown as a warning
  badge. The flag needs `teamOf(id)` beside `columnOf` (the caller at `server.mjs:1040` passes both).
- (6) Room @mentions to a team agent stay allowed. A mention names one agent, so a human chose it. Room turns
  are conversation, not ticket work, so they don't cross the boundary that Dispatch guards. Routines keep
  their current rule.
- (7, the comment on the card) An **Add to team** action on the Teams page: `POST /api/teams/:project/:name/adopt
  {agent, persona}` (session only, like the other writes at `server.mjs:1003`). It checks that `persona` is a
  member and has a free seat (`teams.mjs seats`) and that the agent belongs to the project and is on no team.
  Then it runs `herdr pane report-metadata <pane> --source wt-dashboard --token team=<name> --token
  persona=<persona>`, the same call shape as the pair token at `server.mjs:2381`. The UI lists the project's
  teamless agents in a select on each member row that has a free seat. No auto-adopt, because a silent
  re-label of someone's agent is worse than one click [unsourced judgment].

## Implementation units

**U1 — shared seats + agents.sh spawn guard** (`skills/wt-shared/scripts/teams.mjs`, its test,
`skills/wt-agents/scripts/agents.sh`, `skills/wt-agents/scripts/spawn-env.test.mjs`). Add the `seats`
subcommand. Single spawn: refuse a non-member or a full seat. Bulk spawn: fill only missing seats. Verify:
the spawn-env tests use a PATH-shimmed `herdr` with 1 live `worker` member of a `worker x2` team: a single
spawn passes, the next is refused `team full`, `spawn reviewer --team T` with no reviewer member is refused,
and a bulk spawn spawns exactly 1. Commit `wt-shared: …` and `wt-agents: …` separately.

**U2 — handoff.sh: cap count + --pane team check + shared seats** (`skills/wt-handoff/scripts/handoff.sh`,
`handoff.test.mjs`). Verify: a plain handoff with 1 teamless + 2 team workers and `WT_WORKERS_MAX=2` is not
`pool full`. `--pane <team agent> --task WP-N` for a card of another team, or a teamless card, exits 2 with the
message. The same case for a card of the agent's own team passes (`--dry-run`).

**U3 — dashboard: retire, refill, off-team flag, adopt** (`skills/wt-dashboard/server.mjs`,
`teamview.mjs`, `teamview.test.mjs`, `web/src/teams.tsx`).
`retireIdle` skips team agents. `refillTeams` is pure in its decision, as `teamsNeedingRefill(teams, views,
openCards, lastAt, now)`, and tested. Add `offTeam` in `teamView`, plus the adopt route and its UI. Verify:
`npm test` in `skills/wt-dashboard`, and `npx tsc --noEmit -p tsconfig.app.json` in `web`. `retireIdle` test:
an idle team worker is never picked. Refill test: an open card and 1/2 up → refill; no open card → none;
within 10 min of the last refill → none.

**U4 — docs + live check** (`docs/features.md` Teams section). Document the six rules and Add to team. Live
check with a throwaway 2-member team (`members: [worker x2]`) in a temp repo, never the user's real agents:
spawn the team, `agents.sh rm` one member, add an open card with `team` set, and see refill bring it back
after the next dispatch settle. A third single spawn is refused. Add to team a hand-started agent from that
temp repo. Clean up the agents and the temp repo afterwards.

## Files

- `skills/wt-shared/scripts/teams.mjs`, `skills/wt-shared/scripts/teams.test.mjs`
- `skills/wt-agents/scripts/agents.sh`, `skills/wt-agents/scripts/spawn-env.test.mjs`
- `skills/wt-handoff/scripts/handoff.sh`, `skills/wt-handoff/scripts/handoff.test.mjs`
- `skills/wt-dashboard/server.mjs`, `skills/wt-dashboard/teamview.mjs` (+ its test), `skills/wt-dashboard/web/src/teams.tsx`
- `docs/features.md`

## Verification

Per unit as above. No e2e writing or running. One `npm run service:restart` at the end (not repeatedly), then
`npm run build` for the web.

## Definition of Done

- `retireIdle` never returns a pane with a `team` token (test).
- The plain pool cap in `handoff.sh` ignores team agents (test).
- A team with an open card and a missing seat is refilled by the dashboard at most once per 10 min (pure
  test plus the live check).
- `agents.sh spawn X --team T` refuses a non-member persona and a full seat. Bulk `--team` spawns only
  missing seats (tests).
- `handoff.sh --pane` refuses a cross-team ticket, and the Teams page flags an off-team agent (tests).
- Routines skip unnamed team agents (unchanged) and room @mentions to team agents are allowed, both stated
  in `docs/features.md`.
- Teams page Add to team tags `team`/`persona` on a teamless project agent into a free seat.
- The live check was done with a throwaway team and cleaned up.

## QA brief

Teams page at 412x700 and iPhone 13. A team with a free seat shows **Add to team** on that member row. Pick a
teamless agent and it appears under the member. A seat that is full shows no action. An agent working on
another team's ticket shows a warning badge. Done when these render and work at both sizes without overflow.

## Risks and deferred

- Refill spawns cost money. The 10-minute throttle and the "open card" condition are the guard, with no
  per-project switch [deferred; add a `WT_TEAMS_REFILL` project setting if it misfires].
- `--pane` refusal can block an intentional cross-team manual handoff. The workaround is moving the card's
  team first. No `--force` flag yet.
- Auto-adopt (from the card comment) is deliberately not done.
