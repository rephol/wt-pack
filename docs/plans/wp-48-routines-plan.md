# WP-48 — Routines: dashboard-native scheduler for recurring agent work

Branch `wp-48-routines`, base `origin/main` (d61a37d).

## Goal

The user can set up recurring agent work from wt-dashboard instead of doing it by hand or using cloud cron.
A routine has a schedule, a target and guardrails. It runs inside the dashboard server, which is always up
under launchd. Each run is recorded, so the user can see what fired, what was skipped and why. The five seed
routines ship **disabled**.

## What research corrected

- **No "builder cap" exists.** A grep for `builder cap|max.?builders|WT_*_(CAP|MAX)` over the tree matched
  nothing. Roles have no count limit: `wt-dashboard/roles.mjs:13`
  `spawn: { start: 'worktree', workspace: '<repo>-workers', projects: [] }`. `wt-agents/scripts/agents.sh` has
  no pool cap either. → This plan **introduces** the cap as a Routines setting: `maxWorking`, the most agents
  allowed to be `working` at once, default 4.
- **No room digest exists.** `digest` in `wt-dashboard/*.mjs` only matches hashes (`server.mjs:172`
  `createHash('sha1')…digest('hex')`), and `wt-room` has no digest or summary. The dashboard may not call the
  Claude API (CLAUDE.md: "No Claude API in the dashboard"), so it cannot write a digest itself. → The digest is
  **not a local action**. The "morning room digest" seed prompts the orchestrator agent to write it.
- **Jev "Run now" is not a function.** It is inline in the route handler at `server.mjs:1747-1753`:
  `if (boardRuns.has(b.project)) return send(res, 409, …)` …
  `for (const t of backlog) await triage(b.project, t, ['type','size','priority'])`. → It has to be pulled out
  into `runBoard(project)` before a routine can call it.
- **Agent removal is also inline.** It lives in the DELETE handler (`server.mjs:2284-2285`,
  `if (a.status === 'working' && b.force !== true) return send(res, 409 …)`,
  `run(AGENTS_SH, ['rm', pane, …])`). → It gets pulled out the same way.
- **Nothing handles sleep or wake.** No wake or clock-jump code exists (grep for `wake|resume|drift` in
  server.mjs found only SSE resume). launchd only restarts on crash: `scripts/service.mjs:41`
  `<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>`. Nothing stops the Mac from sleeping.
  → Catch-up is computed from stored `last_run` on every tick (see Approach). A run due during sleep fires
  once after wake. It does not fire N times, and it does not fire *during* sleep.
- **wt-finish and wt-babysit are interactive.** They allow `AskUserQuestion`
  (`wt-finish/SKILL.md:8`, `wt-babysit/SKILL.md:11`). babysit needs a PR ("No PR → say so and stop",
  `wt-babysit/SKILL.md:41`). → Those seeds **prompt the orchestrator**, which has the context to answer.
  They do not spawn a fresh agent into an interactive skill.

## Approach

**Engine: one `routines.mjs` module (pure logic + store), driven by one server timer.**
- `server.listen` gets `setInterval(routinesTick, 30_000)`. **Re-entrancy guard** (review): `setInterval` does
  not wait for an async tick, and `spawnAgent` can block ~3 min (120s `agents.sh` timeout at `server.mjs:923` +
  60s idle wait at `:931`). So `routinesTick` returns at once if a tick is in flight. Inside it, the
  `running` row is inserted and `next_run` advanced **synchronously before the first `await`**. The target work
  is started without awaiting it in the tick; completion updates the row later, next to the existing timers at
  `server.mjs:2386-2391` (`setInterval(tick, 4000)`, `setInterval(hkRun, 3_600_000)`). Timers only start when
  serving (`server.mjs:2380` `if (envOf('SERVE') === '1' || …)`), so tests can import it safely.
- **Schedule.** Two forms. One is `every <N>m|h|d`. The other is a 5-field cron (`m h dom mon dow`, each field
  `*`, a number, a list `a,b`, a range `a-b` or a step `*/n`), in local time. Both are hand-written, because the
  package has no dependencies (`wt-dashboard/package.json` has no `dependencies` key) and the sidecar has to
  bundle (`test:sidecar` runs esbuild). `nextRun(schedule, after: Date) → Date`. For cron it scans minute by
  minute, capped at 366 days. `ponytail:` minute scan, fine at 30s ticks with ≤ tens of routines.
- **Due and catch-up.** A routine is due when `enabled && now >= next_run`. After it runs or is skipped,
  `next_run = nextRun(schedule, now)` is computed from **now**, not from the missed slot. That makes a
  sleep-spanning miss run exactly once on wake, which is the ticket's rule. A server restart after a crash
  catches up the same way, because `next_run` is persisted.
- **Targets** (`target.kind`):
  - `prompt`: `{agent: name}` or `{role, project}`. Agents have no `role` field. They match on
    `pool === role && project === project`, the same way the Ready notifier finds the orchestrator:
    `server.mjs:1706` `ags.find((x) => x.pool === 'orchestrator' && x.project === project)`. **Only an idle
    agent is prompted.** A match that is `working` → `skipped: agent busy` (review: text typed into a
    mid-turn real agent is the failure). The call is `herdrOn(m, 'agent', 'prompt', pane, text)`, as at `server.mjs:1801`. No live match →
    run recorded `skipped: no agent`.
  - `spawn`: `{role, project, prompt}` → existing `spawnAgent({kind: role, project, prompt})` (`server.mjs:908`,
    returns `{name, pane, machine, …}`, and it already `agent wait --until idle` before prompting,
    `server.mjs:931`). While the run is open the engine polls `agents()`. When the agent goes idle after
    working, or on timeout, it removes the agent with the extracted `removeAgent(pane, {force: true})`. The pane is
    stored in `routine_runs.agent` at spawn, so **after a restart** the startup pass removes the agent of every
    orphaned `running` spawn run, then marks it `failed: server restarted`. Without this, an orphan counts
    against the cap forever. The target is validated on save through `spawnAgent`'s own role/project checks.
    It never takes a `cwd`, and it runs `agents.sh` without a shell.
    The force is needed because `rm` refuses a working agent (`server.mjs:2284`).
  - `action`: `jev-run` `{project}` → extracted `runBoard(project)`. `housekeeping` → existing
    `runHousekeeping()` (`server.mjs:2329`).
    `runBoard` keeps the route's behaviour: `jevOn('TICKET_TRIAGE')` off or `boardRuns.has(project)` → it returns
    `{skipped: reason}` rather than throwing, and the routine records `skipped`. The route still replies 200
    before the loop starts.
- **Guardrails**, checked in order. Each failure writes a `skipped` run with a reason and advances `next_run`:
  1. **no overlap**: the routine already has a `running` run → skip.
  2. **cap**: for `prompt`/`spawn` only, (`agents()` with `status === 'working'`) **+ open spawn runs whose
     agent is not yet listed as working** ≥ `maxWorking` → skip. The open runs are counted so that concurrent
     spawns can't all pass.
     `machineSummaries` counts the same way (`mine.filter((a) => a.status === 'working')`).
  3. **memory**: `(await host()).pressure === 'critical'` → skip. `host()` exists at `server.mjs:1239-1245`
     (`pressure: free < 10 ? 'critical' : free < 25 ? 'warn' : 'normal'`). `warn` still runs. `null` (unreadable)
     runs.
  4. **timeout**: per routine, default 60 min. For `spawn`, hitting it force-removes the agent and marks the
     run `timeout`. For `prompt`, the run closes once the prompt is delivered, so there is no timeout. For
     actions, the run is awaited and gets the timeout via `Promise.race`.
- **Storage.** Migration 5 is appended to `MIGRATIONS` in `store.mjs:145` (pattern at `:158`,
  `{ sql: …, legacy: () => [], import: () => {}, export: () => {} }`):
  `routines(id TEXT PK, name, schedule, target JSON, timeout_min, enabled INT DEFAULT 0, next_run INT,
  created INT)`, `routine_runs(id INTEGER PK, routine_id, started INT, ended INT, status TEXT
  /* running|ok|skipped|failed|timeout */, reason TEXT, agent TEXT)`, and
  `routine_settings(k PK, v)` for `maxWorking`. Seeds are inserted by the migration SQL itself (`INSERT`, all
  `enabled=0`), so they appear exactly once and a user delete sticks. On startup, any `running` rows left
  over from a crash are marked `failed: server restarted`. Runs older than 30 days are pruned in the same
  tick. `ponytail:` fixed 30d, fold into housekeeping retention if asked.
- **API** (`routinesApi`, registered like `housekeepingApi` at `server.mjs:2183`; session and Origin rules
  apply unchanged via `needsSession`, `server.mjs:1694-1698`. A session can already prompt agents, so a saved
  prompt grants nothing new): `GET /api/routines` (list, next_run, last run),
  `POST /api/routines` (create), `PUT /api/routines/:id` (edit, enable/pause), `DELETE /api/routines/:id`,
  `POST /api/routines/:id/run` (Run now: guardrails apply except the schedule, and `next_run` is left alone),
  `GET /api/routines/runs?limit=` (history), `PUT /api/routines/settings`. The schedule is validated with
  `nextRun` on write → 400 on a bad expression. Enabling a routine (paused → enabled) resets `next_run = nextRun(schedule, now)`,
  so a seed enabled weeks later does not fire at once on its stale slot.
- **UI.**
  - A new **Routines** page: extend `type Page` (`web/src/App.tsx:248`), add a `NAV_PATHS` icon (`:298`) and
    add a render line next to `:527`. The page has a list with name, schedule, target, next run, last result,
    an enable/pause switch, Run now, edit and delete, plus a create/edit form. Delete confirms with an Astryx
    dialog, because native `confirm` fails `noNativeDialogs.test.ts:13`.
  - **History in Observability**: a new `RoutinesHistorySection` in Settings › Observability, added in
    `web/src/settings.tsx:172` (`<ObservabilitySection /><HousekeepingSection />`), reading `/api/routines/runs`. `/api/observability` is **not** reshaped,
    because Overview also reads it (`web/src/overview.tsx:59`).

`settled:` (no synchronous user; recorded as assumptions)
- Cap = a new `maxWorking` setting, not "builders only". The alternative was a count by role, but no role
  means "builder" today.
- Digest = an orchestrator prompt, not a local action. A local one would need the Claude API, which is
  banned.
- babysit and wt-finish seeds = orchestrator prompts, not spawns. The alternative was spawning into
  interactive skills that stall on questions.
- One `routinesTick` in server.mjs, not a launchd `StartCalendarInterval` job. launchd would add a second
  process and store, and the ticket asks for a dashboard-native scheduler.

**Seeds** (all disabled):

| name | schedule | target |
|---|---|---|
| Nightly audit (wt-pack) | `0 2 * * *` | spawn `auditor` in project `wt-pack`, prompt `/wt-audit` |
| Morning room digest | `0 8 * * *` | prompt role `orchestrator` in `wt-pack`: "post a digest of the last 24h in #wt-pack" |
| Babysit open PRs | `every 30m` | prompt role `orchestrator` in `wt-pack`: "run wt-babysit on open PRs, if any" |
| Jev Auto Run now | `every 1h` | action `jev-run` project `wt-pack` |
| Weekly worktree cleanup | `0 9 * * 1` | prompt role `orchestrator` in `wt-pack`: "run wt-finish on merged worktrees" |

The ticket says "per project". A seed can't list projects at migration time, so it ships for `wt-pack` only and
the user duplicates it per project from the UI. Boards are keyed by project and the live DB has board
`wt-pack|WP` (review), so `wt-pack` is the right id.

## Implementation units

**U1 — engine + store** (`routines.mjs`, `store.mjs`, `routines.test.mjs`, `package.json`)
Migration 5 with seeds. `parseSchedule`/`nextRun`. A `Routines` class (list/get/create/update/delete/runs,
settings). `tickOnce(now, deps)` takes injected `{agents, host, prompt, spawn, remove, actions}`, so it is
testable with no herdr.
Verify: `routines.test.mjs` is added to the `test` list in `package.json` (a new file does not run otherwise).
It covers: `every 30m` and cron `0 2 * * *`/`*/15 * * * *`/`0 9 * * 1` next-run math; a bad expression throws;
catch-up (next_run 5h in the past → exactly one run, and next_run > now); overlap skip; **two concurrent
`tickOnce` calls → one run**; cap skip, including an open spawn not yet `working`; busy agent → skip; critical
memory skip; spawn timeout → remove called with force; action timeout; startup cleanup removes an orphaned
spawn's agent and marks it failed; Run now leaves `next_run` alone; enabling resets `next_run`; 30-day prune;
seeds present and disabled after migration. Cron tests run with `process.env.TZ` pinned (`Asia/Jakarta` and
`America/New_York`). One case crosses a DST spring-forward and one lands exactly on a slot (strictly after
→ next slot). Rule: when both dom and dow are restricted, either matching counts (Vixie cron).

**U2 — server wiring** (`server.mjs`)
Extract `runBoard(project)` from `:1747-1753` and `removeAgent(pane, {force})` from `:2284-2285`. Both routes
keep their behaviour and responses. Add `routinesApi` + the route line, `routinesTick` in `server.listen`,
and crash cleanup of `running` rows on start.
Verify: `npm test` (the existing parse and route tests are still green, `test:sidecar` bundles);
`curl` with the session cookie: create an `every 1m` routine targeting `housekeeping`, see a run `ok` within
~90s, pause it, Run now → run recorded.

**U3 — web** (`web/src/App.tsx`, `web/src/routines.tsx`, `web/src/settings.tsx`)
Routines page + Observability › Routines history.
Verify: `cd web && npx tsc --noEmit -p . && npm run build`; `npm test` (noNativeDialogs). Check in the
browser with `agent-browser --session <agent>` at 1280 and 390 width: create, pause, Run now and delete (Astryx
dialog), and the history row appears.

## Files

- `wt-dashboard/routines.mjs` (new)
- `wt-dashboard/routines.test.mjs` (new)
- `wt-dashboard/store.mjs`
- `wt-dashboard/package.json`
- `wt-dashboard/server.mjs`
- `wt-dashboard/web/src/App.tsx`
- `wt-dashboard/web/src/routines.tsx` (new)
- `wt-dashboard/web/src/settings.tsx`
- `wt-dashboard/README.md` (a Routines paragraph: schedule syntax, sleep semantics, rollback note for
  migration 5: routines and run history are not exported to legacy, so a rollback loses them)

## Definition of Done

1. `cd wt-dashboard && npm test` passes and includes `routines.test.mjs` with the cases listed in U1.
2. `cd wt-dashboard/web && npx tsc --noEmit -p .` is clean and `npm run build` succeeds.
3. (After U2+U3 are merged, and after the single service restart.) After that restart, `GET /api/routines` returns the 5 seeds, all `enabled: false`.
4. A test routine (`every 1m`, action `housekeeping`) produces an `ok` row in `/api/routines/runs` without
   manual action. Paused, it produces none. Run now produces one. The test routine is deleted afterwards.
5. The Routines page and Observability › Routines history render at 390px and 1280px, with a screenshot of
   each.
6. `/api/observability` response shape is unchanged.
7. No real myapp agent is prompted or spawned during verification. Spawn and prompt targets are tested only
   with injected deps (U1) or throwaway agents that get cleaned up.
8. The completion report quotes the output tail of 1–2, the `curl` JSON for 3–4, and the screenshot paths for 5,
   so the result can be judged from the report alone.

## Risks and deferred

- **Sleep**: routines don't fire while the Mac sleeps. That is by design (catch up once on wake), and nothing
  keeps the Mac awake. Deferred: `caffeinate` or power assertions.
- **"Idle after working" detection** for spawn completion depends on herdr status polling. A spawned agent
  that finishes before the first poll sees `working` counts as done at the next idle poll after
  `spawnAgent` returns. `[unsourced]` that herdr always reports `working` during a prompt's turn. Worst case,
  the timeout reaps it.
- **Remote machines**: `prompt` targets may resolve to agents on remote machines (`agents()` merges them).
  That is allowed, and the cap counts them too.
- **Service restart** is needed once to ship. CLAUDE.md says "Don't restart repeatedly", so batch the restart
  after U2 and U3 are both merged.
- Deferred: per-project fan-out of a single routine, run log output capture, notifications on failure.
