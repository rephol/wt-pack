# wt-shared

Scripts the wt-* pack shares. Not a skill — nothing loads this; five SKILL.md
files invoke these by path.

- `scripts/typesafe.mjs` — the TypeSafe call path, the judgment log, threshold loading.
- `scripts/wt-judge.mjs` — judgments that DECIDE (lenses, dedupe, cite, learning, triage, ci, simplify), plus `mark` and `calibrate`.
- `scripts/wt-eval.mjs`  — document scores that only REPORT.

All three are optional: exit 3 means no `TYPESAFE_API_KEY`, and every caller
falls back to the pack's behaviour without them.

- `typesafe.mjs` `judge(feature, state, questions, {timeoutMs, key})` — the fail-open entry point for the
  Jev integrations: returns the answers or `null` (never throws or exits), 2s timeout, 10-min in-process cache,
  one line per call in `~/.local/share/wt-dashboard/jev-calls.jsonl` (rotated at 5 MB, never holds the key).
  `enabled(feature)` / `minFor(feature)` read `WT_JEV_<FEATURE>[_MIN]` from env, then the dashboard env file.
- `scripts/jev-eval.mjs <feature>` — accuracy and p50/p95 of a feature on `jev-fixtures/<feature>.json`.

- `scripts/task-state.sh` — a planner's task label lifecycle as herdr pane tokens (`task`, `task_state`,
  source wt-dashboard): `own` (wt-plan), `planner "<state>"` / `planner --clear` (wt-ship, wt-work, wt-finish,
  from the worker's pane via `handoff_from_pane`; only a role=planner pane still on the same ticket). Silent
  no-op outside herdr.
