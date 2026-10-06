# WP-272 — handoff without /goal by default, server nudge, finish check in the delivery mod

Settled decisions (orchestrator, 2026-10-06): **Q1 A** — queue-first when the target's delivery mod is live, else the
short typed line + pane-submit confirm; a queued message not pulled within N s falls back to the short line once, same
request id. **Q2 A** — nudge any card assigned to a handed-off agent with an acknowledged, unanswered wt_messages row,
every column except done/blocked/review; wording per role; this repo's agents only.

## What exists (evidence)
- `skills/wt-handoff/scripts/handoff.sh:75` `goal=1`; `:112` `--no-goal) goal=0`. With goal=1, `hand_to` saves the
  message to a mode-600 file (`save_message`) and types `"$goal_line $msgfile; reporting what it asks for is the goal"`
  (`:366`), `goal_line="/goal ${ticket:+$ticket: }do the task in"` (`:486`). With goal=0 it falls to
  `herdr agent prompt "$1" "$send"` (`:373`) — **the full wt-message pasted**, the WP-267 pasted-not-submitted path —
  then `pane-submit.mjs confirm` (`:375`).
- Every Dispatch handoff goes through handoff.sh without `--no-goal` (`skills/wt-dashboard/dispatch.mjs:237,385`),
  so it inherits the default. Routines do not add /goal (`server.mjs:3459` `routineText` only wraps).
  `wt-agents spawn` has no /goal (grep: none in `agents.sh`). `promptOn.mjs:33-37` only shortens a `/goal <wt-message`
  someone else built — it keeps working for `--goal`.
- Already `--no-goal`: `wt-watch-prs/scripts/watch-prs.sh:228,412,464`. MCP: `wt-shared/mcp/wt-server.mjs:116` `no_goal`.
- `--cancel` (`handoff.sh:176-201`) escapes, then `/goal clear`, then `/clear` fallback.
- Goal-specific machinery that stays (still valid under `--goal`): watchdog `goal-loop` (`watchdog.mjs:19,114-136`),
  resend strips leading slash commands (`server.mjs:2511`).
- Safety nets that replace the goal's "keep going": WP-257 ack/resend sweep and WP-261 `unreported` (`server.mjs:2500-2523`,
  `messages.mjs:134`; Inbox key `message-unreported|<id>`, kind `server`). Own-project scope rule:
  `ags.some((a) => a.id === row.target && a.project === REPO_PROJECT)` + `WT_MESSAGE_RESEND=off` (`server.mjs:2507-2508`).
- Delivery mod: `skills/wt-room/mod/hooks/register.ts` — `deliverHooks` registers `session.start`/`turn.start`/
  `turn.complete`, chained in `hooks/register.ts` via `runShared` (`mods = [commandsHooks(), deliverHooks(skills), routingHooks(...)]`).
  It calls the CLI `skills/wt-room/mod/scripts/wt-deliver` (`hello|next|ack`, identity `$HERDR_PANE_ID`, curl to the
  dashboard), never Node/env itself.

## Part 1 — default goal=0
- `handoff.sh`: `goal=0`; add `--goal` (sets 1); keep `--no-goal` (no-op, accepted). Usage line updated.
- With goal=0 (Q1 A): "mod is live" = `deliveries.live(pane)`, i.e. a `wt-deliver hello` from that pane within the
  freshness window (hello every 20 s, `skills/wt-room/mod/hooks/register.ts` `HELLO_MS`). If live, `POST /api/deliveries`
  queues the full message (the path `deliver()` already uses, `server.mjs:2482-2486`); handoff.sh then polls the row
  up to `WT_PULL_WAIT_S` (default 30 s); not pulled by then → cancel the queued row and fall back ONCE to the short
  line under the same `--request-id`/envelope id (`messages.record` dedupes on id, so no second row). Not live → save the file and type
  ONE short line `${ticket:+$ticket: }Do the task in <file>, then report with handoff.sh --reply` (no `/goal`) with the
  same send-text → 0.4 s → Enter → `pane-submit confirm` sequence as the goal line. Fallback when the file can't be
  written: paste (today's behaviour) with the WP-267 warning.
- `--goal`: exactly today's path (short `/goal` line, `/goal <flat>` fallback, 4000-char check).
- `--cancel`: keep; when no goal is set `/goal clear` is a harmless no-op → it still escapes and verifies idle. Reword
  its comment/usage from "stop a /goal-driven agent" to "stop an agent".
- `wt-server.mjs`: add `goal` boolean (→ `--goal`), keep `no_goal`.
- Tests (`handoff.test.mjs`, existing fake-herdr harness): default → typed short line has no `/goal`, names the file;
  `--goal` → `/goal … do the task in`; `--no-goal` accepted, same as default; file-write failure → paste + warning.

## Part 2 — server-side nudge (`server.mjs` messageSweep + `messages.mjs`)
- Scope (Q2 A): an `acknowledged`, not `answered`, `ACK_KINDS` row with a ticket whose card is not
  done/blocked/review, target in `REPO_PROJECT`, target status not working/blocked, `updated` older than 4 min →
  ONE line via `deliver()`, worded by the target's `role` token: worker `WP-N: your card is not in review. Continue,
  or report what blocks you with handoff.sh --reply`; planner `WP-N: the plan is not handed back. Finish it, or report
  what blocks you with handoff.sh --reply`; other roles `WP-N: not reported yet. Continue, or report with handoff.sh --reply`.
- Once-only, restart-safe: new column `nudged_at TEXT` on `wt_messages` (migration entry in `store.mjs`, pattern of
  `:192`); `messages.nudge(id)` sets it with `WHERE nudged_at IS NULL` and returns whether it changed → sends only then.
- After the nudge: `unreported` already flags after 10 min idle (`messages.mjs:134`); change its window to count from
  `nudged_at` when set (nudge at 4 min, flag ~4 min after), reusing the `message-unreported` Inbox item — no new kind,
  so `contracts.mjs` (WP-254) is untouched.
- Off switch `WT_NUDGE=off` (cfg key in `config.mjs` `KEYS`, like `WT_MESSAGE_RESEND`).
- Tests (`messages.test.mjs`, fake clock): not due → none; due → nudged once, second pass none; after re-creating
  `Messages` on the same db (restart) → none; card in review → none; other project → none; `WT_NUDGE=off` → none.

## Part 3 — finish check in the delivery mod
- CLI: `handoff.sh --check-finish` → `GET /api/messages/check-finish` with `x-herdr-pane`. Server: newest
  acknowledged-not-answered `ACK_KINDS` row for this pane with a card not done/blocked/review and no `reminded_at` →
  set `reminded_at` (column, same migration) and queue ONE `kind=system` wt-message (`deliveries.enqueue`) reminding it
  to move the card or reply. Returns `{queued:bool}`. Exit 0 always (fail open).
- Mod: in `deliverHooks`' `onComplete`, after `next(e)`, `run(['check-finish'])` — add `check-finish` to `wt-deliver`
  (it's that CLI's job; handoff.sh's flag delegates to the same endpoint for humans). Throttle in the mod: at most one
  call per turn (flag reset on `turn.start`). The queued reminder is then delivered by the existing pull.
- Caveat in docs: plugin hooks load at session start — needs the plugin cache to have it AND a session restart (WP-120).
- Tests: `skills/wt-room/mod/hooks/register.test.ts` (existing fake `process.run`): turn.complete calls `check-finish`
  once per turn; server test for the endpoint: queues once, second call none, answered row → none.

## Rules and docs
- `docs/features.md` handoff section: default no goal, `--goal` opt-in, nudge, finish check, `WT_NUDGE`.
- `skills/wt-handoff/SKILL.md` (description says "as a /goal"), `skills/wt-plan/references/handoff.md` + `SKILL.md`
  ("goes out as a one-line /goal"), `skills/wt-work/SKILL.md`, `inject.mjs:70` ("possibly after `/goal`" → keep, still true for --goal).
- wt-memory (via `wt-memory forget/remember`, not file edits): umkmall project `--no-goal` rule → redundant, remove;
  "Never message an agent still working on its /goal" → "…a working agent"; orchestrator "clear its goal" → keep, scoped to `--goal`.

## Live checks (throwaway agents, temp repo only — never real panes)
`mktemp -d` repo with a board key; `wt-agents spawn worker <tmp>`. (1) default handoff → pane shows the short line,
no goal set, agent reports. (2) leave it idle on a building card → nudge typed once at ~4 min; restart the dashboard
service once → no second nudge. (3) a fresh session (plugin reloaded) ending a turn without reporting → one system
reminder arrives. Remove agents and the temp repo after.

## Definition of done
`npm test` in `skills/wt-dashboard`, `node --test skills/wt-handoff/scripts/handoff.test.mjs`,
`skills/wt-mods/scripts/test` green; the three live checks pass. Commits: wt-handoff, wt-dashboard, wt-room, docs per skill.
Worker: no e2e writing or running.

## QA brief
Inbox at 412x700 + iPhone 13: a stalled handoff shows one "finished without reporting" item, after one nudge.
