# WP-220 — Watchdog: detect a /goal agent looping on an infra failure, clear the goal, raise an Inbox card

## Problem

worker-04 burned ~160M tokens retrying `git push` under `/goal` while GitHub auth was broken. `/goal`
re-prompts after every turn until its condition holds, so an infra failure outside the ticket loops forever.

## What the code already has (research)

- **Watchdog** (`skills/wt-dashboard/watchdog.mjs`, run every 60 s by `runWatchdogOnce()` in `server.mjs`
  ~L3389): pure `evaluate(snap, settings)` → findings; `diffFindings` keeps one open finding per key;
  `inboxOps` turns an opened finding into an Inbox item `kind: 'watchdog'` and resolves it when the finding
  clears. Checks are a `CHECKS` table with `{ id, label, unit, threshold, severe }`, settable in Settings ›
  Observability › Watchdog (`cleanWatchdogSettings`). This is where the detector goes — the ticket's
  "Dispatch (or the watchdog)" resolves to the watchdog: it already owns per-agent health findings
  (`exited`, `stale-hooks`) and their Inbox lifecycle.
- **Goal state is in the transcript.** Setting a goal writes a JSONL line
  `{"type":"attachment","attachment":{"type":"goal_status","met":false,"condition":"<wt-message …>"}}`
  (seen in `~/.claude/projects/*wt-pack*/*.jsonl`), and meeting it writes the same attachment with `"met":true` (one WP-116 transcript: line 15 `met:false` at set, line 479 `met:true`; nothing per turn). So *active* = the latest `goal_status` in the tail has `met:false` and no later user prompt is `/goal clear` (a `<command-name>/goal</command-name>` with args `clear`). Research corrected the first draft here: it assumed a per-turn `goal_status` line. A 512 KB tail can miss a goal set long ago; then the check stays silent (fails safe). Errors are user lines with
  `content:[{"type":"tool_result","is_error":true,"content":"Exit code 1\n…"}]`.
  `findTranscript(sessionId)` (`server.mjs:638`) maps a session id to its file; pool agents carry
  `a.session` (`rememberAgents`, `watchdog.mjs`).
- **Clearing a goal** is already solved in `handoff.sh --cancel` (`skills/wt-handoff/scripts/handoff.sh:163-170`):
  `herdr agent send-keys <pane> esc`, then `herdr agent prompt <pane> "/goal clear" --wait --until idle --until done --timeout 8000`.
  **Do not call `--cancel` itself**: it also clears the `task`/`ticket` tokens and moves the ticket back to
  Ready unassigned (L172-185), so Dispatch would hand the same blocked ticket to the next agent, which hits the
  same broken auth. Reuse only the two herdr calls.
- **The existing STALL Jev judge** (`stallJudge`, `server.mjs:234`, decision `looping`) only fires after 20 min
  of no status change and only marks the task `stalled`. A goal-driven agent keeps changing status every
  turn, so it never trips; and it is a Jev judgment (gated, probabilistic). The new check is deterministic.
- **Rooms**: `rooms.system(slug, text)` (`rooms.mjs:450`) posts a system message; `rooms.list()` rows carry
  `project`.

## Decisions

1. Detector is a new watchdog check `goal-loop` — deterministic, no Jev. Settled: no Claude API in the
   dashboard (CLAUDE.md), and the ticket wants it reliable.
2. **Only infra errors count.** A signature counts when its text matches `INFRA_RE` (auth/network class:
   `authentication failed|permission denied \(publickey\)|could not read username|bad credentials|401|403|
   could not resolve host|network is unreachable|connection (refused|reset|timed out)|operation timed out|
   ETIMEDOUT|ECONNREFUSED|ECONNRESET|ENOTFOUND|rate limit|gh auth login|Authorization header is badly formatted`).
   A repeated failing *test* is the agent's own work, not infra — never auto-cleared. [unsourced: the exact
   list is a judgement; it is one exported regex so it can grow.]
3. **Loop rule** (pure function, see Unit 1): goal active (latest `goal_status` in the tail has `met:false`
   and no later `/goal clear` user prompt), and the last `threshold` (default **5**) error tool results since
   that goal started all share one normalised signature that matches `INFRA_RE`, the first and last of them are
   ≥ 10 min apart, and the last is within 15 min of now. A goal with varied progress has differing or
   non-infra errors and never trips.
4. **Action on open** (server, once per opened finding — `diffFindings` already guarantees once): esc +
   `/goal clear` on the pane (as above), a system post in the agent's project room, and the Inbox card. The
   check is `severe: true` so the card pops natively. The ticket is **not** moved or unassigned — the user or
   orchestrator decides once the infra is fixed.
5. **Self-report rule**: one paragraph in `skills/wt-work/SKILL.md` — an infra error outside the ticket
   (auth, network, a down service): report it once through the reply channel and stop; do not retry under
   `/goal`. Role rules otherwise live in wt-memory (`~/.config`, not in the repo), so the skill is the in-repo
   place a worker reads.

## Units

### Unit 1 — `goalLoop` (pure) + the check, `skills/wt-dashboard/watchdog.mjs`
- `export const INFRA_RE = /…/i` (decision 2).
- `export function goalLoop(jsonl, { n = 5, now = Date.now() } = {})` → `null | { signature, count, first, last, condition }`.
  Parses lines (skip unparseable — the tail starts mid-line), tracks the goal start (last `goal_status` whose
  condition differs from the previous one or follows a clear), collects error tool results after it with
  `timestamp`, signature = first non-empty line after an `Exit code N` line (else the first line), with digits,
  hex ≥ 7 and `/tmp/…`/`/var/folders/…` paths replaced, trimmed to 160 chars.
- `CHECKS` gets `{ id: 'goal-loop', label: 'Goal-driven agent repeating the same infra error', unit: 'errors', threshold: 5, severe: true }`.
- `evaluate`: `for (const g of snap.goalLoops ?? [])` → `add('goal-loop', g.pane, \`${g.name} is looping on a goal blocked by infra\`, \`${g.count}× since ${time}: ${g.signature}${g.ticket ? \` (${g.ticket})\` : ''}. Goal cleared; fix the cause, then re-dispatch.\`)`.
  The threshold passed to `goalLoop` is the setting, so the snapshot is built with `wd.settings['goal-loop'].threshold`.

### Unit 2 — snapshot + action, `skills/wt-dashboard/server.mjs`
- `watchdogSnapshot()`: `goalLoops` = for each local agent with `pool && pool !== 'other' && session`
  and status not `exited`: read the transcript's last 512 KB (`open` + `read` at `size - 512K`, not
  `readFile` of a multi-MB file), `goalLoop(text, { n: threshold })`, keep hits as
  `{ pane, name, ticket: a.tags?.task ?? null, project, ...hit }`. Skipped entirely when the check is off.
- `runWatchdogOnce()`: after `inboxOps`, for each `d.opened` with `check === 'goal-loop'`: `herdr agent send-keys <pane> esc`,
  then `herdr agent prompt <pane> "/goal clear" --wait --until idle --until done --timeout 8000` (failure → append
  "goal clear unverified" to the room post, never throw); room = a non-archived `rooms.list()` row whose
  `project` equals the agent's project (prefer `slug === project`); none → no post. Text:
  `<name> was looping on an infra error under /goal (<count>× <signature>); goal cleared, see the Inbox.`
- Once cleared, the `/goal clear` prompt lands in the transcript, `goalLoop` returns null, and the finding and
  its card resolve through the existing `resolveKeys` path. The room post stays as the record. To keep the card
  until the user acts, `inboxOps` must not resolve `goal-loop` items: filter `check === 'goal-loop'` out of
  `resolveKeys` (the user dismisses it).

### Unit 3 — tests, `skills/wt-dashboard/watchdog.test.mjs`
- Fixture JSONL built in-test: a `goal_status met:false` line, then 6 `tool_result is_error` lines
  `Exit code 128\nremote: Invalid username or token. … fatal: Authentication failed for 'https://github.com/…'`
  spaced 3 min apart → `goalLoop` returns `count ≥ 5`; `evaluate` with it in `snap.goalLoops` yields one
  `goal-loop|<pane>` finding, severity `severe`.
- Negative: same goal with varied errors (a failing test, a lint error, a missing file) interleaved → `null`.
- Negative: 6 auth errors with no `goal_status` → `null`; 6 auth errors spanning 4 min → `null`;
  `goal_status` followed by a `/goal clear` user prompt → `null`.
- Server action is not unit-tested (herdr side effects); its pieces are the existing herdr calls.

### Unit 4 — docs + rule
- `docs/features.md` watchdog section (~L477): one sentence for the `goal-loop` check and what it does.
- `skills/wt-work/SKILL.md`: the self-report paragraph (decision 5).

## Definition of Done
- `cd skills/wt-dashboard && npm test` passes, including the new `goalLoop`/`evaluate` tests (positive + the
  four negatives).
- `node -e "import('./skills/wt-dashboard/watchdog.mjs').then(m=>console.log(m.CHECKS.some(c=>c.id==='goal-loop')))"` prints `true`.
- `docs/features.md` and `skills/wt-work/SKILL.md` carry the new text.
- One commit per skill touched (wt-dashboard, wt-work, docs with whichever it belongs to).
- Not verified live: no real goal-driven agent is made to loop on broken auth (CLAUDE.md: never prompt real
  agents for tests). Say so at ship.

## Out of scope
- Dispatch changes; moving/unassigning the ticket; remote machines (transcripts are local only).
