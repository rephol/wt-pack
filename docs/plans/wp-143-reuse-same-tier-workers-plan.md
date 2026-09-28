# WP-143 — Live routing: reuse same-tier workers, retire idle ones, cap the pool

## Problem (verified)

`skills/wt-handoff/scripts/handoff.sh:300-301`: "A reused agent cannot change model without an interactive
picker, so an applied tier always spawns a fresh agent with --model." The reuse branch is gated on it —
`handoff.sh:387` `if [ "$mode" = auto ] && [ -z "$route_tier" ]; then reuse=…` — so under
`WT_MODEL_ROUTING=live` every hand-off falls through to `agents.sh spawn` (`handoff.sh:400`). Nothing ever
retires a worker: the WP-134 `onDone` hook (`skills/wt-dashboard/server.mjs:1910`) only clears the
`task`/`ticket` tokens. Result: the pool grows by one per hand-off (7 idle workers removed by hand today).

Research also found a sibling bug the ticket did not name: `agents.sh respawn` (`skills/wt-agents/scripts/agents.sh:285`)
re-spawns with `spawn "$r" "$dir" --label "$name" ${sess:+--resume …}` — no `--model`/`--effort` — so a
respawned routed worker comes back on the role floor tier (`agents.sh:226-231`), while its old tokens are
copied across (`agents.sh:289`). Once tier becomes a token, that copy would make it *lie*. Fixed in Unit 1.

## Settled decisions (no synchronous user — recorded assumptions)

- Tokens are named `model` and `effort` (≤80 chars, well under the 32-key cap). They are written by
  `agents.sh spawn` with the other pre-start tokens (`agents.sh:213`), from the **final** `$model`/`$effort`
  after the floor fallback (`agents.sh:230-234`) — so every spawn records what it actually runs, routed or not.
  Empty → token not written.
- Match rule in handoff: a free candidate is reusable for a routed hand-off iff `tokens.model == route_tier`
  and (`route_effort` empty or `tokens.effort == route_effort`). A worker with no `model` token (pre-WP-143)
  never matches a routed tier. Unrouted hand-offs keep today's behaviour (any free worker).
- "Queue instead of spawning" = handoff.sh exits **3** with `pool full: <n>/<cap> workers in <repo>` and
  sends nothing; the card is not moved, so it stays in Ready and dispatch retries on its next pass. No new
  queue store. [unsourced: that dispatch retries a card whose hand-off failed — Unit 3 verifies it by reading
  the dispatch caller; if it moves the card first, the exit path must move it back to `ready`.]
- Settings, both `scope: 'project'` in `skills/wt-dashboard/project-settings.mjs` (beside `WT_MODEL_ROUTING`,
  line 29), read from shell via `node skills/wt-shared/scripts/project-setting.mjs get <KEY> --cwd <main>`
  (the same path `mcp-mode.sh` uses):
  - `WT_WORKERS_IDLE_PER_TIER` — integer ≥ 0, default **1**.
  - `WT_WORKERS_MAX` — integer ≥ 1, default **unset = no cap** (keeps today's behaviour; backward compatible).
  Env vars of the same name override (test hook and ad-hoc use), as `WT_AGENTS_MCP` does.
- Retirement only touches workers that carry a `model` token (i.e. spawned by WP-143-aware code) — never a
  hand-made or pre-existing agent.

## Units

Order matters: Units 2 and 4 read the `model`/`effort` tokens Unit 1 writes; Unit 3 is independent; Unit 4's
settings registration is needed by Unit 3's cap read only through `project-setting.mjs` (env override works
without it, so Unit 3 is testable first).

### Unit 1 — record tier/effort at spawn; respawn keeps them (`skills/wt-agents/scripts/agents.sh`)
- In `spawn`, after the floor block (line 234), `herdr pane report-metadata "$pane" --source wt-dashboard
  ${model:+--token "model=$model"} ${effort:+--token "effort=$effort"}` (best effort, `|| true`).
- In `respawn_one`, read `tokens.model`/`tokens.effort` from `$row` and pass `${m:+--model "$m"} ${e:+--effort "$e"}`
  to spawn; add `model`, `effort` to the `del(...)` list on line 289 so spawn's fresh values win.
- Update the header comment (line 4-11) to mention the tokens.

### Unit 2 — same-tier reuse (`skills/wt-handoff/scripts/handoff.sh`)
- `candidates()` (line 202): extend the jq line to also emit the pane's `model`/`effort` tokens (join
  `herdr pane list` tokens the way `agents.sh:78` does) as fields 4-5.
- Replace the `[ -z "$route_tier" ]` gate at line 387 with a per-candidate check: skip a candidate whose
  model/effort do not match (rule above) when `route_tier` is set; keep `has_picks`.
- Rewrite the comment at 300-301: reuse is fine when the free worker already runs that tier.
- `--dry-run` says `would reuse … (model <tier>)`.

### Unit 3 — pool cap (`handoff.sh`)
- Before the spawn at line 397/400, when `role=worker` and a cap is set: count agents in the worker
  workspace (`worker_ws`); if `>= cap` → exit 3 with the message above (dry-run prints it too).
- Read the dispatch caller in `skills/wt-dashboard` (grep `handoff.sh`) and confirm a non-zero exit leaves
  the card in Ready; fix it there if not. Record what you found in the commit message.

### Unit 4 — retire idle routed workers on Done (`skills/wt-dashboard/server.mjs` onDone, `project-settings.mjs`)
- Register the two settings in `project-settings.mjs` with integer checks.
- In `onDone` (line 1910), after the token clear: list agents (`herdr agent list` + pane tokens, as
  `agents.sh list --json` shows), take the ones in `<project>-workers` with `role=worker`, status idle/done,
  no `task` token, and a `model` token. Group by `model`; in each group keep the `N` = `WT_WORKERS_IDLE_PER_TIER`
  most recently used (pane `handoff_at` token desc) and remove the rest with
  `agents.sh rm <pane>` (execFile, no `--force` — it refuses a working agent). Never remove the pane
  that just finished if it's the only one of its tier and N ≥ 1.
- Put the selection in a pure exported function (`retireIdle(agents, n) → panes[]`) so it is unit-tested
  without herdr.

### Unit 5 — docs
- `docs/features.md`: the worker-pool/model-routing section gains same-tier reuse, idle retirement, the cap
  and the two settings.

## Tests (Definition of Done)
1. `node --test skills/wt-handoff/scripts/handoff.test.mjs` — new cases on the stub herdr with
   `WT_MODEL_ROUTING=live` and a stubbed route result: a free worker with `model=<routed tier>` is **reused**
   (log shows `agent prompt <that pane>`, no `tab create`); one with a different `model` → **spawn**
   (`tab create … --model`); `WT_WORKERS_MAX=1` with one busy worker → exit 3, no `tab create`.
2. A test for `agents.sh spawn` on the stub herdr: `report-metadata … --token model=<tier>` is logged; a
   respawn passes `--model` from the old token.
3. `cd skills/wt-dashboard && npm test` — `retireIdle` unit test: 3 idle `sonnet` + 1 idle `opus` + 1 busy
   `sonnet`, N=1 → removes exactly the two older idle sonnets; agents without `model` are never picked; N=0
   removes all idle routed ones.
4. Settings validation test: `WT_WORKERS_MAX=0` and `abc` rejected.
5. `./setup doctor` clean; `docs/features.md` updated.
Done = all of the above pass and the transcript shows each named assertion. No real agents are prompted
(throwaway stub herdr only — CLAUDE.md Traps).

## Out of scope
Switching a running session's model; dashboard UI for the settings beyond the generic project-settings form
(it renders registered keys already).
