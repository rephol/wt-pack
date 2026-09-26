# Tasks page → action queue (wt-dashboard)

Branch `tasks-action-queue` (no ticket; user-approved in #wt-pack, msgs 88–90). Base: local `main` at 37c0954
(repo has no remote).

## Goal

Replace the read-only Tasks table with a queue of six sections. Each row has one primary action (some also
have a secondary one). Every action runs only when the user clicks it, and goes through a server endpoint
behind the existing session cookie and Origin guard.

## What the code says today (evidence)

- `wt-dashboard/server.mjs:939` `deriveTasks({ agents, worktrees, prs, issues })` already sets these states:
  `needs_you` (idle/blocked agent with `asks`), `stalled` (`idle && now - a.statusSince > STALL_MS` and no
  PR), `in_review` (`pr?.state === 'OPEN'`), `plan_ready` (`wt?.plan && !worker`), `shipped`/`merged` and
  `queued`. `STALL_MS = 20 * 60_000` (`server.mjs:40`), so N = 20 min.
- **Ad-hoc rows.** For any agent not linked to a ticket, `server.mjs:~990` pushes `id: 'agent:<key>'` with
  `adHoc: true`, in the states needs_you, building or done. `rooms.mjs:503` `needsTasks()` also emits
  `adHoc: true` rows for room needs-you.
- **Linear.** `LINEAR_Q` (`server.mjs:~913`) returns `identifier title priority url updatedAt state { name }`
  for `assignee isMe OR team UMK`. It does not return the assignee or the state type, so "Up next" can't
  tell which issues are the user's or which are Todo/In Progress.
- **PRs.** `prs()` asks gh for `number,title,headRefName,state,isDraft,…,reviewDecision,statusCheckRollup`
  and no freshness field. `gh pr list --json` supports `mergeStateStatus` (checked in `gh pr list --help`).
  gh has no unresolved-thread count, so that needs `gh api graphql` `reviewThreads { isResolved }`.
- **Endpoints to reuse (unchanged):**
  - `POST /api/agents/:machine/:pane {text}` → `herdr agent prompt` (`server.mjs:~1950`). Used by Answer,
    Nudge, Babysit and Finish.
  - `POST /api/agents/spawn {kind, project, cwd?, prompt?}` → `spawnAgent` (`server.mjs:~806`). It waits
    for idle and then prompts, `if (typeof b.prompt === 'string' && b.prompt.trim())`. Used by Plan it.
  - `needsSession` (`server.mjs:1472`) puts every non-GET `/api/` route behind the cookie, so a new POST
    route is covered automatically.
- **Handoff** is a CLI, not an endpoint: `wt-handoff/scripts/handoff.sh [--pane <id>|--new] [--task …] <cwd>`
  reads the prompt from stdin. With no `--mcp` and no `--pane`, Jev picks MCP servers
  (`wt-handoff/SKILL.md`). Output line 1 is `reused <pane>` or `created <name> <pane>`.
- wt-babysit and wt-finish have no scripts (only `SKILL.md`). They run by prompting an agent with the slash
  command.
- **UI.** The Tasks page is `App.tsx:511`, which renders `<TaskBoard …>`. `TaskBoard` is also used by
  `OverviewPage` (`App.tsx:604`), so it stays. **worker-01 has uncommitted edits to `App.tsx` on `main`**
  (the Summary tab), so this work touches `App.tsx` as little as possible.

## Decisions (settled; the orchestrator relayed the scope and no synchronous user was available)

1. **Stop emitting ad-hoc agent rows in states building/done.** Ad-hoc `needs_you` rows (agent questions
   and room needs) stay, because they are exactly what the "Needs you" section is for. Agents with no
   ticket are still visible in Agents.
2. **Only one new server endpoint:** `POST /api/tasks/:id/handoff {mode: 'worker' | 'reassign'}`. The server
   re-derives the task from `overview()` and never takes a path from the client. It then runs `handoff.sh`
   with the three-line wt-plan prompt, using the task's plan, worktree and branch:
   `Use wt-work to implement <plan> to its Definition of Done.\n\nWork in <worktree> on <branch>. Do not cd to the main checkout.\n\nThen wt-ship.`
   - `--task "<id> <title>"`.
   - `reassign` adds `--new`.
   - No `--mcp`, so Jev picks.
   - Returns 409 unless the state is `plan_ready` (worker) or `stalled` (reassign).
   - Returns 400 if the task has no plan or worktree.

   Everything else reuses the existing endpoints.
3. **Up next** = issues where `assignee.isMe` and `state.type ∈ {unstarted, started}`, with no worktree, no
   PR and no agent. deriveTasks gives them the new state `up_next`. Other UMK-team issues with nothing
   attached stay `queued` and don't appear in the queue.
4. **Plan it** calls the existing spawn endpoint with
   `{ kind: 'planner', project, prompt: '/wt-plan <ID>' }`.
5. **Babysit / Finish / Nudge** prompt the task's `responder` (worker, else planner). If there's no live
   agent, the button is disabled with a reason. The prompts are:
   - Babysit: `/wt-babysit <pr.url>`
   - Finish: `/wt-finish`
   - Nudge: `You've been idle 20+ min on <id>. Continue <plan or task>; if blocked, say what you need.`
6. **Recently shipped** = `shipped` or `merged` with `updatedAt` in the last 7 days, in a collapsed
   `<details>`-style section.

## Units (in order; each one ships green)

### U1 — server data (`wt-dashboard/server.mjs`, `parse.test.mjs`)

- Extend `LINEAR_Q` with `assignee { isMe }` and `state { name type }`. Map each issue to
  `mine: Boolean(i.assignee?.isMe)` and `stateType: i.state?.type`, keeping `state: i.state?.name`.
- Add `mergeStateStatus` to the `prs()` json fields and expose it as `pr.behind`
  (`mergeStateStatus === 'BEHIND'`).
- For OPEN PRs only, add one batched `gh api graphql` query for `reviewThreads(first:100){nodes{isResolved}}`.
  Cache it for 60s and expose it as `pr.unresolved`. If it fails, set `unresolved: null` and don't throw.
- In `deriveTasks`:
  - Add state `up_next`: `issue?.mine && ['unstarted','started'].includes(issue.stateType) && !wt && !pr && !ag.length`.
    It goes before `'queued'`.
  - Stop emitting ad-hoc agent rows unless they need you (Decision 1).
- **Test:** extend `parse.test.mjs` with
  - an assigned Todo issue → `up_next`;
  - a non-mine issue → `queued`;
  - an ad-hoc working agent → no row;
  - an ad-hoc asking agent → a `needs_you` row.

### U2 — handoff endpoint (`wt-dashboard/server.mjs`)

- Add the `POST /api/tasks/:id/handoff` route next to `/api/agents/spawn`, with the same
  `content-type: application/json` 415 check.
- Pipe the prompt to `handoff.sh` with `execFile` directly, writing it to `child.stdin`: `run` (`server.mjs:46`) is `execFile(cmd, args, { cwd, maxBuffer, timeout, env })` and takes no stdin.
- 120s timeout. Parse line 1 and return `{ target, pane }`.
- `store.delete('overview')`.
- **Test:** export a pure `handoffArgs(task, mode)` that returns `{ args, prompt }` or throws with a
  status. Unit-test that:
  - `reassign` adds `--new`;
  - there's never an `--mcp`;
  - a task that is not plan_ready gets 409.

### U3 — web queue (`wt-dashboard/web/src/tasks.tsx` new; `App.tsx` one line)

- New file `tasks.tsx` exporting `TaskQueue({ tasks, onOpen, showProject })`. In `App.tsx`:
  - line 511: render `TaskQueue` instead of `TaskBoard`;
  - add the `up_next` entry to `STATE`/`TaskState`;
  - add `mine`/`behind`/`unresolved` to the `Task`/`PR` types.

  That's all in `App.tsx`. Merge with worker-01's Summary-tab edits (coordinate before touching `App.tsx`).
- The six sections are, in order: Needs you, Plan ready, In review, Stalled, Up next, Recently shipped
  (collapsed). An empty section is hidden. If the whole queue is empty, show one EmptyState.
- Row actions:
  - **Needs you:** inline `TextInput` + Send. If `t.agent.id`, POST `{text}` to
    `/api/agents/:m/:pane`. If it's a room need (`roomNeed`), show an "Open room" link. Also show an Open
    button that goes to the agent.
  - **Plan ready:** "Hand to worker" → U2 (`worker`). The plan path shows as text, with a link to open the
    agent's worktree if one exists.
  - **In review:** badges for CI, `n unresolved` and `behind base`. "Babysit" is the primary action and
    "Open PR" is a link.
  - **Stalled:** "Nudge" is the primary action. "Reassign" → U2 (`reassign`) needs a second, inline
    confirm click: the button changes to "Confirm reassign" for 5s. **No native dialogs.**
  - **Up next:** "Plan it" → the spawn endpoint. The button shows a busy state until it answers.
  - **Shipped:** "Finish" (wt-finish).
- Every mutation is a TanStack `useMutation` that invalidates the overview query. Errors show inline under
  the row.
- **Layout:** each row is a stacked `Card` (title line, meta line, action row that wraps), with no
  `Table`, so it works at 390px without horizontal scroll.
- **Test:** `taskQueue.test.ts` for a pure `sections(tasks)` grouping function, covering order, the 7-day
  window for shipped and hiding empty sections. `noNativeDialogs.test.ts` must still pass.

## Definition of done (each item visible in the transcript)

- `curl -s -X POST localhost:<port>/api/tasks/X/handoff -H 'content-type: application/json' -d '{}'` without the cookie → 403 (guard), pasted output.
- `node -e` print of `deriveTasks` on the U1 fixtures shows no `adHoc` row with state `building`.

- `cd wt-dashboard && npm test` and `cd web && npx tsc --noEmit -p . && npm test && npm run build` are green.
- The service has been restarted **once** (`npm run service:restart`), because server.mjs changed.
- Checks on the live dashboard, with evidence posted in #wt-pack (a screenshot at 390px and one at desktop
  width):
  - the Tasks page shows the sections;
  - no ad-hoc building rows;
  - a Plan ready or Up next row, if one exists, shows its button.
- **Actions are not exercised against the user's real umkmall agents** (CLAUDE.md). U2 is verified with its
  unit test, plus `handoff.sh --dry-run` if you wire one in for testing.
- Commits: one per skill touched. Here that's only `wt-dashboard`, as one or more commits.

## Out of scope

The Overview page's TaskBoard; Linear writes (e.g. moving the issue to In Progress); auto-actions of any
kind; remote-machine agents for Finish or Babysit (disabled when `!t.agent` is local).
