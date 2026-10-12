# WP-348 — Agents table + watcher, per-agent pause/resume

## Goal

Every local pane agent gets one durable row in `wt.db`, keyed by its stable name. A watcher reconciles each row
against herdr and `claude agents --json`, so the rows stay true. Handoff, Dispatch, routines, recovery, team
refill, keepwarm, the watchdog's Resume, AgentInfo and the UI then read the row instead of each rebuilding
identity from herdr.

Today a pane-id change (restart, respawn) or a crashed claude leaves these views disagreeing. With the table,
one row moves and nothing else has to. An agent that vanishes from herdr stays listed as `missing` instead of
disappearing. Pause and resume become per-agent, project pause becomes "pause every agent of the project",
and `project_pauses` is retired.

## Settled decisions (orchestrator, relaying the user, 2026-10-12)

- `settled:` **Pause despawns.** Pause snapshots the row, then `agents.sh rm`. Resume respawns with
  `claude --resume`. This is today's project-pause mechanics, applied per agent. Rejected: a soft pause that
  keeps the pane alive.
- `settled:` **DND stays separate.** It is the short-lived "don't hand me work" pane token. `paused` is a row
  state.
- `settled:` **Retire `data/watchdog.json` `lastSeen` and `data/agent-tags.json`.** Both fold into the agents
  table, and the watchdog's Resume moves onto rows. Rejected: keeping either as a second store.
- `settled:` **Local machine only.** Remote machines stay live herdr views.
- `settled:` **Scripts move onto `GET /api/agents/by-name/<n>`,** with a herdr fallback when the dashboard is
  down.
- `settled:` **Stored tokens are the mirrored set plus `ticket`.** Never `task`, `task_state` or `handoff_*`,
  and that includes the pause snapshot, which today stores every token.

## What research corrected

- **The ticket's "only headless runs are stored" is wrong.** Two more per-agent stores exist, and both are
  retired here:
  - `watchdog.mjs:210` keeps `lastSeen: { [pane]: { name, session, cwd, role, ticket, seenAt, goneAt? } }`,
    keyed by pane. It already tracks exited agents for the watchdog's Resume.
  - `roles.mjs:4` says "data/agent-tags.json is the source of truth": mirrored tags keyed by name, re-applied
    to panes by `syncTokens` (`server.mjs:515-534`).
- **`lastSeen` has a third reader nobody named.** It is the spawn-numbering guard: `agents.sh:324-326` runs
  `jq -r '.lastSeen // {} | .[] | select(.goneAt) | .name'` so a crash-gone agent's number isn't reused
  (WP-120). The web Resume button reads it too: `web/src/watchdog.tsx:63`
  `isDisabled={!lastSeen?.[…]?.session}`. Both move in U5.
- **Project pause stores every pane token today.** `pause.mjs:24` writes `tokens: t` into
  `project_pauses.json`, and `server.mjs:3575` replays everything except the spawn-owned keys. That includes
  `task` and `handoff_*`.
- **`pause.mjs:2` claims keepwarm skips a paused project. It doesn't:** `grep paus keepwarm.mjs` finds
  nothing. U3 adds the check.
- **herdr has two pane ids.** One is stable (`w4:pM`, which is `$HERDR_PANE_ID`). The other is a display id
  (`wM:p6`) that moves when workspaces are renumbered (`server.mjs:3058-3063`). A respawn changes both. The
  session survives only through `--resume` (`agents.sh:569`).
- **`project_pauses` and `projects` are lazy tables, not `store.mjs` migrations.** `pause.mjs:10` and
  `project-store.mjs:7` each run `CREATE TABLE IF NOT EXISTS` on `psettings.db`, which is the same cached
  `wt.db` handle.
- **`store.mjs`'s staged migrations can't carry this import.**
  - A stage's `import` runs only when its legacy *files* are present: `if (left.length) m.import(...)`
    (`store.mjs:281`).
  - Every legacy file is then moved into `pre-sqlite-*` (`:284`).
  - `watchdog.json` still holds live settings, findings and lastRun, so it can't be moved away.
  - `project_pauses` is a table, not a file.
  - `exportTo` opens the db `{ readOnly: true }` (`:294`), so an export cannot recreate a table.

  So the agents table is lazy too (U1), like its two neighbours.

## Approach

### Table

`agents-table.mjs` creates it lazily on `psettings.db`:

```
agents(name TEXT PRIMARY KEY, role TEXT, persona TEXT, project TEXT, cwd TEXT, session TEXT,
       pane TEXT, stable_pane TEXT, ticket TEXT, tags TEXT NOT NULL DEFAULT '{}',  -- mirrored keys only
       state TEXT NOT NULL, mid_turn INTEGER NOT NULL DEFAULT 0,
       seen_at INTEGER, gone_at INTEGER, paused_at INTEGER, created_at INTEGER NOT NULL)
```

- **`state`** is one of running, idle, paused, exited or missing:
  - herdr `working` and `blocked` map to running.
  - herdr `idle`, `done` and `unknown` map to idle.
  - herdr `exited`, which `listAgents` already sets (`server.mjs:607`), maps to exited.

  The live UI status keeps coming from herdr on the `agents()` row.
- **`tags`** holds only roles.mjs's mirrored keys, meaning every key not in `LIVE_KEYS` (`roles.mjs:30`).
- **No key column.** Pane keys stay files in `DATA_ROOT/pane-keys/<pane>` (`server.mjs:3257-3259`).

`ProjectStore` gets a lazy `paused_at` column through `ALTER TABLE … ADD COLUMN`, guarded by `PRAGMA
table_info`. It is the project flag that Dispatch, routines, refill, the hidden-projects override and
`/api/projects` `paused` keep checking (`dispatch.mjs:182`, `routines.mjs:229`, `server.mjs:1389,1416,1430`).
Without it, Dispatch would spawn new agents into a paused project.

### Watcher

`reconcile(rows, live, panes, now)` is a pure function that returns row updates. It runs inside `agents()`
on the local `listAgents()` result, which is already cached for 3 s (`server.mjs:676-681`). The 4 s `tick`
→ `overview()` → `agents()` path drives it whether or not a client calls.

For pane presence it uses the already-cached `paneMeta` pane list (`server.mjs:507`), and never the per-pane
`claudeExited` process-info, so it **adds no herdr calls**. That matters because herdr's socket is the
measured bottleneck: `server.mjs:599` says "Parallel reads every 3s flooded herdr's socket". The DB write
happens only for rows that changed.

**Skip the pass entirely** when the herdr call failed or returned a stale cache, or when both the agent list
and the pane list are empty while rows show running or idle. That is a herdr restart, not every agent dying.

Match order, per live herdr agent:

1. **Session id** (`a.agent_session.value`), but only when exactly one live agent carries it. Two panes on
   one session fall through to rule 2. This rule makes the row follow a pane-id change.
2. **Name**, when the row is exited or missing (a fresh-session respawn under the same name).
3. **Neither** matches: a new row, with tags inferred as `syncTokens` does today (`inferTags`,
   `server.mjs:523`).

**The watcher never changes a `paused` row.** Only `resumeAgent` takes a row out of paused, in-process, and it
binds the new pane itself (U4). A spawn that reuses a paused agent's name therefore can't hijack the row. The
numbering guard (U5) also stops that name from being reused.

Rows that no live agent matched:

- The pane is still in the pane list → `exited`. It is resumable when `session` is set.
- The pane is absent → `missing`, and `gone_at` is set.

The watcher never deletes a row. Rows are deleted by deliberate removal only (U5).

### No Claude API

Liveness comes only from the `claude agents --json` CLI, which `server.mjs:586-591` already uses.

### Security

- The table never stores `task`, `task_state`, `handoff_*` or a key.
- **`GET /api/agents/by-name/<n>`** is a GET like `GET /api/agents`, so it has the same exposure: GETs skip
  the session and pane checks (`needsSession`, `server.mjs:2484`), and only the loopback Host/Origin
  allowlist applies. It returns only `{name, pane, stable_pane, state, session, cwd, role, persona, project,
  ticket}`, never `tags` beyond those, and never a key. It is no wider than what `/api/agents` already
  returns.
- **`POST /api/agents/by-name/<n>/forget`** goes on the `needsSession` pane whitelist. It needs a valid
  `x-herdr-pane` + `x-wt-pane-key` (or the cookie). A pane may forget a row that is exited, missing, or its
  own. It may never forget a `paused` row: only the dashboard cookie can, so one agent cannot destroy
  another's pause snapshot.
- A pane-key file stays keyed by pane id. Respawn mints a fresh key (`agents.sh:402-418`), so a row moving to a
  new pane needs no key migration.

## Implementation units

### U1 — Agents table, store module, one-time import

**Store module.** New `skills/wt-dashboard/agents-table.mjs`: `AgentTable(getDb)` with `get(name)`, `list()`,
`upsert(row)`, `setState(name, state, extra)`, `remove(name)`, and `byPane(pane)`. `byPane` matches either
`pane` or `stable_pane`.

**One-time import.** On first open, when the table is newly created, one transaction imports:

- `agent-tags.json`: name → row tags, filtered to the mirrored keys.
- `watchdog.json` `.lastSeen`: one row per entry, keyed by `name`, with session, cwd, role, ticket, seen_at and
  gone_at. The state is `exited` if `goneAt` is set, otherwise `idle`; the watcher corrects it on the first
  tick.
- `project_pauses`, only if `sqlite_master` has it: each saved agent becomes a `paused` row, with tokens
  filtered to the mirrored keys plus `ticket` and `midTurn` kept, and the project gets `projects.paused_at`.
  `ProjectStore` ensures its own table and column first.

**Legacy data is left in place**, not renamed or dropped, so a rollback finds it. New code never reads or
writes it again. `watchdog.json` loses `lastSeen` on the server's next save, because `wd` no longer carries
it.

**ProjectStore.** `project-store.mjs` gets the lazy `paused_at` column and `setPaused(project, at|null)`.

**Files:** `skills/wt-dashboard/agents-table.mjs`, `skills/wt-dashboard/agents-table.test.mjs`,
`skills/wt-dashboard/project-store.mjs`, `skills/wt-dashboard/README.md` (rollback).

**Verify:** `agents-table.test.mjs` against a temp data dir.

- (a) All three sources present, including a `project_pauses` snapshot whose tokens carry `task` and
  `handoff_from`. Assert the rows, the paused state, `projects.paused_at`, and that no `task`, `task_state` or
  `handoff_*` key is in any row.
- (b) Only `project_pauses` is present, with no legacy files. The import still runs.
- (c) A second open imports nothing.
- (d) `watchdog.json` settings, open and lastRun are untouched by the import.

### U2 — Watcher (`reconcile`) inside `agents()`

`reconcile()` from the Approach goes into `agents-table.mjs`, wired in `server.mjs` after
`listAgents(local)`.

**Files:** `skills/wt-dashboard/agents-table.mjs`, `skills/wt-dashboard/agents-table.test.mjs`,
`skills/wt-dashboard/server.mjs`.

**Verify:** `reconcile` fixtures in `agents-table.test.mjs`:

1. A new pane gives a new row.
2. The same session on a new pane id: the row follows it (worker-07 p38→p39).
3. A fresh-session respawn under the name of an exited row: the row is rebound.
4. herdr status `exited` gives `exited`.
5. A pane gone from the pane list gives `missing`, and the row is kept.
6. A paused row is left untouched, even when a live agent has its name or session.
7. Two live panes on one session: no flapping, and a second run produces zero updates.
8. Empty agent and pane lists, or a failed fetch, with running rows: zero updates.
9. Unchanged input gives zero updates.

### U3 — Server consumers read the table

**`agents()` local rows.** Name, role, persona, project, ticket and `state` come from the row, and each row
gains `state` and `paused`. `key` is unchanged (`tasks.tsx:25` posts to `/api/agents/:machine/:id`).

**Paused, exited and missing rows** with no live pane are appended with no pane, their `state`, and
`key: local/<name>`.

**`syncTokens` and the role store.** Tags come from the row. `roleStore.tags` and its file go. The
`setTags` callers write the row (`server.mjs:1173,1472`). `roles.mjs` keeps the roles list and `LIVE_KEYS`.

**Paused agents are never picked** by Dispatch (`dispatch.mjs:165`), routines (`routines.mjs:220,234`) or
recovery (`recovery.mjs:9`). They have no pane, and those filters additionally skip `state !== 'running' &&
state !== 'idle'`.

**Team refill counts paused members.** Today's count is live panes only (`agents.sh:301`, `handoff.sh:759`,
`server.mjs:1392`), which would spawn a replacement for every paused agent. `server.mjs:1392` counts the
team's rows whose state is not missing. The two script counts move to `GET /api/agents` rows the same way,
with a herdr fallback.

**Keepwarm.** `data/keepwarm.json` is re-keyed from pane to name on load, through `byPane`
(`server.mjs:3947,3979,652`). Keepwarm also gets the paused-project check that `pause.mjs:2` claimed.

**Headless names.** `headless.mjs:52` `taken` adds every row name.

**AgentInfo.** `agentinfo.mjs` adds `state` and `stableKey: name`, and `key` stays. `contracts.d.mts:70`
`AgentState` adds `'paused' | 'missing'`.

**Files:** `skills/wt-dashboard/server.mjs`, `skills/wt-dashboard/roles.mjs`,
`skills/wt-dashboard/dispatch.mjs`, `skills/wt-dashboard/dispatch.test.mjs`,
`skills/wt-dashboard/routines.mjs`, `skills/wt-dashboard/routines.test.mjs`,
`skills/wt-dashboard/recovery.mjs`, `skills/wt-dashboard/headless.mjs`, `skills/wt-dashboard/agentinfo.mjs`,
`skills/wt-dashboard/agentinfo.test.mjs`, `skills/wt-dashboard/contracts.d.mts`,
`skills/wt-agents/scripts/agents.sh` (the refill count), `skills/wt-handoff/scripts/handoff.sh` (the refill
count).

**Verify:** `npm test` in `skills/wt-dashboard`, plus one new case each: a paused row is never a Dispatch,
routine or recovery candidate, and refill does not replace a paused member.

### U4 — Per-agent pause/resume; project pause on top

**`pause.mjs`.**

- **`pauseAgent(name)`.**
  1. Write the snapshot to the row: `state=paused`, `paused_at`, `mid_turn`, and tags filtered to the mirrored
     keys plus `ticket`. The row is saved first, as `pause.mjs:30` does.
  2. Run `agents.sh rm <pane> --force --keep-row`. A headless run is stopped as today.
  3. Drop the `agents:local` cache (`server.mjs:3558`).
- **`resumeAgent(name)`.** The spawn path from `server.mjs:3573`, cwd fallback included (WP-347). It replays
  only the stored tags. It then sets the row to `idle` with the new pane id printed by `spawn`. This is the
  only path out of `paused`.
- **`pauseProject` / `resumeProject`** loop over the project's rows and set or clear `projects.paused_at`.
- The `Pauses` class and its `project_pauses` reads and writes are deleted.

**Routes.**

- New `POST /api/agents/by-name/:n/pause` and `…/resume`, dashboard user only, with the same guard as
  `server.mjs:3535-3542` (`roomAuthor kind 'user'`).
- The `GET/POST /api/projects/:p/pause` and `…/resume` shapes are kept. `projects-settings.tsx:132`
  `PauseState` consumes them, and their `agents` list is now built from the rows.

**Files:** `skills/wt-dashboard/pause.mjs`, `skills/wt-dashboard/pause.test.mjs`,
`skills/wt-dashboard/server.mjs`.

**Verify:** rewrite `pause.test.mjs` against `AgentTable`, with stub `rm`/`spawn`:

- Pause leaves the row paused, and `rm` was called once with `--keep-row`.
- The row still exists after `rm`.
- Resume runs `spawn --label <name> --resume <sess>`, and the row ends up idle on the new pane.
- Project pause pauses every row and sets `projects.paused_at`.
- A partial resume failure keeps only the failed agents paused (`pause.mjs:54` behaviour).

### U5 — Deliberate removal, numbering guard, watchdog Resume on rows

**Row ownership on `rm`.** One rule: `agents.sh rm` forgets the row unless it is given `--keep-row`.

- **Pause and `respawn` keep the row.** `respawn_one`'s `"$self" rm "$old" --force` (`agents.sh:568`) becomes
  `--keep-row`.
- **Every other `rm` forgets the row.** That covers the user CLI, idle retirement (`server.mjs:1379`),
  routines (`:3999`) and the UI remove.
- **How the forget happens.**
  - The server's own callers already hold the table, so they pass `--keep-row` and call `table.remove(name)`
    in-process after a successful `rm`. A child process carries no pane key, so a `curl` back would get a 403.
  - The CLI posts `POST /api/agents/by-name/<n>/forget` with its pane headers.
  - If that fails (dashboard down), the row is left alone. The watcher marks it missing, and the user can
    Forget it in the UI.
- This replaces the jq edit of `watchdog.json` (`agents.sh:530-535`).

**Numbering guard** (`agents.sh:321-326`). `used` reads the names of every row from `GET /api/agents`, with
any state, including paused, exited and missing. Its fallback when the dashboard is down is
`herdr agent list` alone. The `watchdog.json` jq line goes.

**Watchdog.**

- Drop `rememberAgents`, `mergeLastSeen` and `wd.lastSeen` (`server.mjs:4197,4211-4216,4248`;
  `watchdog.mjs:210-233`).
- `exitedAgents` becomes `table.list()`, filtered to exited rows plus missing rows that have a `session`.
- The Resume route (`server.mjs:4289`) looks the row up by name.
- The watchdog API returns `rows: { [name]: { session } }` in place of `lastSeen`, and `watchdog.tsx:20,63`
  reads it.

**Files:** `skills/wt-dashboard/watchdog.mjs`, `skills/wt-dashboard/watchdog.test.mjs`,
`skills/wt-dashboard/server.mjs`, `skills/wt-dashboard/web/src/watchdog.tsx`,
`skills/wt-agents/scripts/agents.sh`, `skills/wt-agents/scripts/spawn-env.test.mjs` (its `lastSeen` fixtures at
`:63-100` move to a stub `GET /api/agents` through a fake `curl` on PATH).

**Verify:**

- Watchdog tests pass with the `lastSeen` fixtures replaced by rows.
- An exited row gives a Resume finding.
- In `spawn-env.test.mjs`, a paused or missing row's number is not reused (WP-120), and `rm` without
  `--keep-row` posts forget while `rm --keep-row` does not.
- In `server.mjs` route tests, forget is refused for another pane's paused row and allowed for an exited one.

### U6 — `by-name` endpoint + scripts

**Endpoint.** `GET /api/agents/by-name/<n>` as in the Approach. An unknown name returns 404.

**Shared helper.** `pane_by_name` in a new `skills/wt-shared/scripts/agent-pane.sh`:

- It runs `curl -fsS --max-time 2` to `${HERDR_DASH_URL:-http://127.0.0.1:7777}` with the `x-herdr-pane` +
  `x-wt-pane-key` headers (as `wt-keepwarm:13` sends them).
- It prints the pane only when `state` is running or idle.
- If the dashboard is unreachable, it falls back to `herdr agent list | jq select(.name == $n)`, which is
  `handoff.sh:186`'s lookup.

**Callers.**

- `handoff.sh:186` `pane_of_name`.
- `watch-prs.sh:200-204`: the previous reviewer must be running or idle, and is skipped when paused.
- `agents.sh:481,511,548` (dnd, rm, respawn). Respawn reads name, role, cwd and session from the row first, so
  a missing agent becomes respawnable, which fixes `agents.sh:548-555` ("needs a name, a role token and a
  cwd").

**Handoff to a dead target.** When the named target's row is paused, exited or missing, handoff exits
non-zero with `<name> is <state>: resume it first` and does not send. Today an explicit `--pane` runs no
liveness check (`handoff.sh:706-710`).

**Files:** `skills/wt-dashboard/server.mjs`, `skills/wt-shared/scripts/agent-pane.sh`,
`skills/wt-handoff/scripts/handoff.sh`, `skills/wt-handoff/scripts/handoff.test.mjs`,
`skills/wt-watch-prs/scripts/watch-prs.sh`, `skills/wt-agents/scripts/agents.sh`.

**Verify:** `handoff.test.mjs`.

- First, pin every existing test's env to `HERDR_DASH_URL=http://127.0.0.1:9` (a closed port), as the
  `--cancel` test already does (`:84`). Otherwise the suite would query the user's live dashboard.
- Then add a fake `curl` on PATH, matching the suite's existing `execFileSync` + PATH-shim style
  (`:187-200`), so no in-process stub server is needed and the WP-164 trap doesn't apply. It returns
  `{state:'paused'}`, and handoff by name exits non-zero with that message.
- Closed port: the herdr path is used.

Also run `node --test skills/wt-agents/scripts/*.test.mjs`.

### U7 — UI

- The Agents list gains `paused`, `exited` and `missing` badges and a per-agent **Pause/Resume** action, using
  the in-app confirm (`noNativeDialogs.test.ts`). Missing agents are greyed, with Resume (respawn) and
  Forget.
- Settings › Projects pause keeps its current shape.
- The board pairing picker (`board.tsx:460`) also excludes rows that are not running or idle.

**Files:** `skills/wt-dashboard/web/src/agentInfo.ts`, `skills/wt-dashboard/web/src/board.tsx`, and the Agents
list component that renders `AgentState` (find it with `grep -rln "'exited'" skills/wt-dashboard/web/src`).

**Verify:** `npx tsc --noEmit -p tsconfig.app.json` plus the web unit tests. The QA brief below covers the
screens.

### U8 — Docs

- `docs/features.md`:
  - "Project pause" (:45) becomes per-agent pause plus project pause.
  - "Agents, roles and spawn" (:248) covers the agents table, its states, by-name and forget, and the retired
    `agent-tags.json`.
  - "Dispatch" (:116), "Routines" (:639) and "Teams" (:1028): paused agents are skipped, and counted by
    refill.
  - The watchdog section: Resume reads rows.
- `skills/wt-handoff/SKILL.md:92` (its `agent-tags.json` line), and the CLAUDE.md Traps line about "tokens
  never mirrored to `agent-tags.json`": both now refer to the agents table.

**Files:** `docs/features.md`, `skills/wt-handoff/SKILL.md`, `CLAUDE.md`.

### Order

U1 → U2 → U3 → U4 → U5 → U6 → U7 → U8, with `npm test` green after each unit. U4 is unsafe without U5's
`--keep-row`, so **U4 and U5 land together, or U5's `rm` change goes first.**

## Files

- `skills/wt-dashboard/`: `agents-table.mjs`, `agents-table.test.mjs`, `project-store.mjs`, `README.md`,
  `server.mjs`, `roles.mjs`, `dispatch.mjs`, `dispatch.test.mjs`, `routines.mjs`, `routines.test.mjs`,
  `recovery.mjs`, `headless.mjs`, `agentinfo.mjs`, `agentinfo.test.mjs`, `contracts.d.mts`, `pause.mjs`,
  `pause.test.mjs`, `watchdog.mjs`, `watchdog.test.mjs`
- `skills/wt-dashboard/web/src/`: `agentInfo.ts`, `board.tsx`, `watchdog.tsx`, and the Agents list component
- `skills/wt-shared/scripts/agent-pane.sh`
- `skills/wt-handoff/scripts/handoff.sh`, `skills/wt-handoff/scripts/handoff.test.mjs`,
  `skills/wt-handoff/SKILL.md`
- `skills/wt-watch-prs/scripts/watch-prs.sh`
- `skills/wt-agents/scripts/agents.sh`, `skills/wt-agents/scripts/spawn-env.test.mjs`
- `docs/features.md`, `CLAUDE.md`

## Verification

- Run `npm test` in `skills/wt-dashboard`, and `npm test` at the repo root (serial, slow).
- Run `./setup doctor`. Its pane-key count (`setup:266-267`) is unchanged, because keys are still per pane.
- **Live check.** Do it once, after a single service restart (`npm run service:restart`; don't repeat it),
  with a throwaway agent only:
  1. `wt-agents spawn worker <temp repo>`. `sqlite3 …/wt.db "select name,state,pane from agents"` shows it
     idle.
  2. `agents.sh respawn <name>`. Same row, new pane id.
  3. Pause from the UI. The row is paused and the pane is gone.
  4. Resume. The row is idle on a new pane, with the same session.
  5. `agents.sh rm <name>`. The row is gone.

## Definition of Done

- Opening `wt.db` creates `agents`. A temp data dir with `agent-tags.json`, `watchdog.json` `lastSeen` and a
  `project_pauses` table yields rows, as do the only-`project_pauses` case and the second-open case
  (`agents-table.test.mjs` U1 a–d).
- No row in `wt.db` `agents` contains a `task`, `task_state` or `handoff_*` key (asserted).
- The U2 reconcile fixtures 1–9 pass.
- The paused row survives `rm --keep-row`, and resume binds the new pane (`pause.test.mjs`).
- This grep matches only the `agents-table.mjs` import code and tests:

  ```
  grep -rnE "agent-tags\.json|project_pauses|\.lastSeen|lastSeen\b" skills/wt-dashboard/*.mjs \
    skills/wt-dashboard/web/src/watchdog.tsx skills/wt-agents/scripts/agents.sh
  ```

- Handoff by name to a paused, exited or missing agent refuses. Dispatch, routines, recovery and refill
  never pick or replace a paused agent (tests).
- `docs/features.md` describes per-agent pause and the agents table.
- Every suite named in Verification passes.

## QA brief

Screens: the Agents list and Settings › Projects, at 412x700 and on iPhone 13.

1. On a throwaway agent's row, tap **Pause**. The badge reads *paused*, and the row stays listed with no pane.
2. Tap **Resume**. The badge is back to idle within about 5 s, and the conversation continues in the same
   session.
3. Settings › Projects › **Pause** on a project with two throwaway agents. Both rows show *paused*.
4. Resume the project. Both come back.
5. `/exit` a throwaway agent's claude. Its row shows *exited*, with Resume.

Done check: the row never leaves the list, and its badge always matches the pane.

## Risks and deferred

- **Hand-started agents** get `<cwd>-<pane>` names (`server.mjs:548-550`). Their rows won't follow a pane
  change and will pile up as missing rows. Accepted: the user can Forget them in the UI. Auto-pruning old
  missing rows without a session is deferred.
- **Display-id renumbering.** Both `pane` and `stable_pane` are stored, and `byPane` checks both. A consumer
  that compares only one of them can still miss.
- **`task-state.sh` and `wt-finish` write tokens straight to herdr.** That is fine, because `task` and
  `task_state` aren't columns. `ticket` is synced from the pane every tick.
- **wt-memory scope inference** (`wt-memory:59`, `herdr pane get`) stays on pane tokens. `syncTokens` still
  re-applies them from the row, so the two agree. Moving it is deferred (not asked).
- **Grace mode.** Until `WT_PANE_KEY_STRICT=1`, a keyless pane can call forget. It still can't forget a paused
  row.
- **Rollback.**
  - Stop the service, check out the pre-WP-348 commit, and start the service. `wt.db` stays in place: the old
    code ignores the `agents` table and still finds `agent-tags.json` and `project_pauses`, both left in
    place by U1.
  - What is lost: pauses made after WP-348, because they live only in rows. **Resume every paused agent
    before rolling back.** Also lost: `watchdog.json` `lastSeen`, which only costs Resume findings for agents
    that are already gone.
  - Tag edits made after WP-348 aren't in `agent-tags.json`.
- **Dashboard-down outage.** The numbering guard falls back to herdr, which no longer lists crash-gone
  agents, so a number could be reused during the outage. This is the same as before WP-120.
