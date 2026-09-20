# wt-shared

Scripts the wt-* pack shares. Not a skill — nothing loads this; five SKILL.md
files invoke these by path.

- `scripts/typesafe.mjs` — the TypeSafe call path, the judgment log, threshold loading.
- `scripts/wt-judge.mjs` — judgments that DECIDE (lenses, dedupe, cite, learning, triage, ci, simplify), plus `mark` and `calibrate`.
- `scripts/wt-eval.mjs`  — document scores that only REPORT.

All three are optional: exit 3 means no `TYPESAFE_API_KEY`, and every caller
falls back to the pack's behaviour without them.
