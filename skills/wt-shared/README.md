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

- `scripts/task-state.sh` — a planner's task label lifecycle as hc labels (`task`, `task_state`,
  source wt-dashboard): `own` (wt-plan), `planner "<state>"` / `planner --clear` (wt-ship, wt-work, wt-finish,
  from the worker's pane via `handoff_from_pane`; only a role=planner pane still on the same ticket). Silent
  no-op outside an hc terminal.

- `scripts/hc.mjs` — the node adapter for `hc` (herdr-core), WP-378: `hc()` runner with error kinds (`blocked` exit 9, `status_mismatch` 10,
  `finished` 11, `not_found`, `name_taken`, `timeout`, `unavailable`), `list()` (ONE `hc connect` `terminal.list` call = labels, status,
  foreground; `machine/` rows dropped), `get/send/keys/read/wait/waitUntil/interrupt/kill/rm/killRm`, `setLabels/clearLabel` (the pack's
  32 labels / 80-char values / key shape / known roles, which hc itself does not enforce), `nextName`, `spawn/spawnNumbered` (always
  `--bg --outlive-parent --no-notify`; removes the launcher env file when `hc run` fails), `coreUp()` (does not start a core).
  `send` never uses `--force`: a blocked agent throws `blocked` for the caller to queue; `{ifIdle}` also accepts the resting `done` status.
  Import it dynamically inside the subcommand that needs it. CLI for agents.sh only: `node hc.mjs spawn --prefix P --cwd D [--label k=v]... -- <argv>`.
- Tests on recorded real output: `scripts/fixtures/hc/<verb>.json` (one file per verb, cases `{args,exit,stdout,stderr}`), replayed by
  `scripts/fake-hc/hc` (a PATH shim; `installFakeHc({cases})` in `scripts/fake-hc.mjs` returns `{env, calls(), cleanup()}`; cases per verb, an
  array answers call 1, 2, ...). Add a recording with `scripts/hc-record.mjs capture <verb> <case> -- <hc args>` (or `scenario`) — it
  refuses to run unless `HC_SESSION` names an isolated core and `XDG_STATE_HOME` is a scratch dir. Opt-in real test:
  `WT_REAL_HC=1 HC_SESSION=wtt-x XDG_STATE_HOME=… XDG_RUNTIME_DIR=… node --test skills/wt-shared/scripts/hc.test.mjs`
  (socket paths are limited to 103 bytes: keep the scratch dirs short).

