# Overview rework — health at a glance

Branch `overview-rework` (base `origin/main` @ d6c6a7c). Request: "rework overview page" (#wt-pack).

## Settled decisions (user, #wt-pack 08:13)
- Overview = at-a-glance health, **no lists**. Every tile links to the page that owns the detail.
- **Task board removed from Overview** entirely; the Needs-you list goes too (Tasks' "Needs you" section owns it).
- Claude usage on Overview = just the 5-hour and weekly bars. The Agent/Project/Model token breakdown moves to a new **Settings › Usage** section.

## Today (evidence)
`web/src/App.tsx:570` `OverviewPage` renders, in order: `MachinesStrip`, `UsagePanel` (`web/src/usage.tsx:49`: bars + breakdown card),
five `Kpi` tiles from `counts` (`needsYou, stalled, building, inReview, idleAgents`), a "Needs you" card list
(`data.tasks.filter(t => t.state === 'needs_you')`), and `TaskBoard` (`App.tsx:731`). The last two duplicate
Tasks (`web/src/tasks.tsx` `TaskQueue`, sections Needs you / Plan ready / In review / Stalled / Up next / Shipped).
At 390px the page is machines + usage cards stacked; the KPIs start below the fold.

## Target layout
```
[ Needs you 2 → ] [ Stalled 1 → ] [ In review 3 → ]      tiles → #tasks
Agents   myapp  ●3 working ○5 idle ✕0 blocked          → #agents (project-scoped)
         wt-pack  ●2 working ○1 idle
Today    PRs 4 opened · 2 merged · 3 tasks shipped
Machine  RAM 71% (normal) · workers 2/2 · per-machine online/stale dots (was MachinesStrip)
Health   Linear ✓ GitHub ✓ herdr ✓ Jev ⚠ 3 errors/24h      → Settings › Observability
Rooms    #wt-pack 2m ago — last line · #myapp 14m ago   → #rooms/<slug>
Usage    5h 22% · weekly 7%                              → Settings › Usage
```
One column at 390px, in that order; two-column grid ≥ 900px.

## Data sources
| Tile | Source | New server work |
|---|---|---|
| Needs you / Stalled / In review | `counts` in `/api/overview` (`server.mjs:1136`) | none |
| Agents by state per project | `data.agents` (`status`, `project`) — client-side group | none |
| Throughput today | `prs()` (`server.mjs:886`) fetches `mergedAt` but **not `createdAt`**; tasks `shipped` via `pr.shipped` | add `createdAt` to the `gh pr list --json` field list; add `counts.today = { prsOpened, prsMerged, shipped }` in `overview()` (local-midnight cutoff). ponytail: last 50 PRs only (`--limit 50`) — fine for one day. |
| RAM / pressure | nothing today | add `host: { memUsedPct, pressure }` to `overview()`: `os.totalmem/freemem` + `memory_pressure -Q` (macOS, cached 30s, null on failure) |
| Worker cap | not in code — orchestrator rule "max 2 workers" `[unsourced]` | show `working workers / 2`; cap is a constant `WORKER_CAP = 2` in the client, ponytail: make it a setting if it ever changes |
| Machines | `data.machines` | none (fold `MachinesStrip` into the Machine tile) |
| Integration health | `/api/health` `sources` (`server.mjs:1098`: herdr/git/gh/linear/machines, `ok/lastError`) + `/api/observability` `stats['24h']` (branch `jev-integrations`, `observability.tsx:18`) | none — client reads both queries (`['health']` already exists in `status.tsx:67`) |
| Room activity | `/api/rooms` (`rooms.tsx:73`, query `['rooms']`) — index has `slug,title,createdAt,...`, **no last-message fields** | add `lastAt`, `lastFrom`, `lastText` (≤120 chars) per room in the rooms list response (`rooms.mjs`); top 3 by `lastAt` |

## Units
**Sequencing:** U1/U2 touch `server.mjs` and `rooms.mjs`, which `jev-integrations` (worker-02) also edits (+117 / +30 lines).
Start U1 after `jev-integrations` merges to main. Housekeeping (worker-03) already merged (5cc2cd9) — no overlap left.
U3's Jev health row needs `/api/observability` from that branch too. One worker, U1→U4 in order.

- **U1 server: overview counts + host.** `server.mjs`: `createdAt` in PR fields; `counts.today`; `host` block. Test in `parse.test.mjs`: a pure `todayCounts(prs, tasks, now)` returns correct numbers across midnight.
- **U2 rooms last activity.** `rooms.mjs` list adds `lastAt/lastFrom/lastText` from each room's newest message (read on load, updated on post — no full-log scan per request). Test: post then list returns the new last line.
- **U3 web: new Overview.** New `web/src/overview.tsx` with the tiles above; `App.tsx` `OverviewPage`, `Kpi`, and the Needs-you list deleted, `Overview` interface gains `today`/`host`. `MachinesStrip` stays in `App.tsx` — AgentsPage also renders it (`App.tsx:1144 <MachinesStrip machines={data.machines} />`); Overview's Machine tile uses a compact inline summary instead. `TaskBoard` (`App.tsx:731`) is rendered only by Overview (`App.tsx:614` is its sole `<TaskBoard` call) → delete it and any helper left unused (`tsc --noEmit` with `noUnusedLocals` flags them). Update `OverviewSkeleton` to the tile shape. Unit test for the per-project agent grouping.
- **U4 web: Settings › Usage.** `usage.tsx` splits into `UsageBars` (Overview) and `UsageBreakdown`; add a `usage` section to `settings.tsx` rendering the breakdown.

## Definition of done
Each item has a command whose output the worker pastes into its report:
- `grep -n "TaskBoard\|OverviewPage" web/src/App.tsx` → no `TaskBoard`; `OverviewPage` only imported from `./overview`.
- `curl -s -b <session> localhost:7777/api/overview | jq '.counts.today, .host'` → both objects present; old keys unchanged.
- `curl … /api/rooms | jq '.rooms[0] | {lastAt,lastText}'` → non-null for a room with messages.
- agent-browser: click each tile, `get url` shows `#tasks` / `#agents` / `#rooms/<slug>` / Settings section.
- `cd web && npx tsc --noEmit -p . && npm test` pass; `node --test` for server tests passes.
- agent-browser screenshots at 1440×1000 and 390×844: all tiles visible, no horizontal scroll, Needs-you tile above the fold on phone.
- Settings › Usage shows the Agent/Project/Model breakdown.
- `/api/overview` stays backward compatible (only additive fields); CLI untouched.
- No native dialogs; no Claude API calls.
