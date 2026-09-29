# WP-183: wt-review depth 2/2 (per-lens agents on bigger diffs, new lenses, verdict word + fixes, lens wording)

Base: `origin/main` @ ec5736a, which already contains WP-182 (`6d0e128 wt-review: reviewer contract, …`).
Branch `wp-183-review-depth`. This is prose-only work in `skills/wt-review` and `skills/wt-ship` (plus
`docs/features.md`). There is no code.

## What research found (evidence)
- **WP-182 already delivered part of item (7).** `references/reviewer-contract.md` requires `suggested_fix`
  ("Every finding also carries `suggested_fix`: one sentence, concrete enough … to start typing") and the
  `residual_risks` / `testing_gaps` arrays. `SKILL.md:257` shows `suggested_fix` in the findings JSON, and
  `SKILL.md:264` says "`confidence`, `evidence` and `suggested_fix` are required on every finding, every lens".
  The ticket's "a suggested_fix per finding" is therefore **done**. What remains is (a) wt-ship consuming it
  and (b) residuals being filed.
- **Drift that WP-182 left behind:** each lens file still carries its own older JSON template without those
  fields. For example, `references/agents/security-lens.md` ends with
  `{ "lens": "security", "title": …, "severity": "high|medium|low" }` and has no `confidence`, `evidence` or
  `suggested_fix`. Only `adversarial-lens.md` mentions them (grep for `suggested_fix|confidence` over
  `references/agents/*.md` matches that one file). A reviewer reading its own persona sees the short
  schema. Fix it here, because item (8) rewrites every lens anyway.
- **Current diff sizing, which (5) replaces:** `SKILL.md` "Size by diff" splits by *files*. For "200–800",
  it says "at least 2 agents … each given an explicit, disjoint slice of `git diff --name-only`". For
  "> 800" it says "3 agents". It adds "The **ceiling stays 3** either way", and "Floor 1 agent. Ceiling 3" appears in
  the lens-bundle section, with a 3-row bundle table (mandatory+standards / testing+learnings /
  security·data·scope·adversarial).
- **Trigger table:** 11 rows at `SKILL.md` ~117-129. There is no maintainability lens today (grep
  `maintainab` → nothing). "Fold maintainability into scope" therefore means adding bullets to `scope-lens.md`,
  not merging two files.
- **Plan-only wording:** `security-lens.md:3` "Triggered when the plan touches …", `data-lens.md:3`
  "Triggered when the plan carries …", and `scope-lens.md:3` "Triggered when the plan is large". These lenses run
  in both modes (trigger table), so "plan" is wrong in diff mode.
- **Verdict:** `SKILL.md` "Coverage line in the verdict" already says partial coverage makes the verdict "a
  send-back for coverage", but no verdict **word** is defined. wt-watch-prs maps a verdict to
  approve/comment/hold (`wt-watch-prs/SKILL.md:136-145`) and reads the coverage line (`:132`).
- wt-ship's apply step: "apply the findings, verifying the load-bearing ones yourself first … **A finding that
  invalidates the work is a stop**" (`wt-ship/SKILL.md:72-74`). It does not mention `suggested_fix` or residuals.

## Settled decisions (headless: stated assumptions)
1. **Per-lens split (5).** For a diff over 200 changed lines, there is one agent per fired lens, each reading
   **every** changed file (the lens is its filter, the file list is still explicit), capped at **5**. When more
   than 5 lenses fire, bundle the extras using the existing 3-row bundle table's groupings, merging the smallest
   bundles first, until 5 remain. This **replaces** the 200–800 / >800 file-slice rules. The per-file coverage
   rows, the union check, the effort floor and the coverage line stay unchanged. At ≤200 lines, the current
   bundling (floor 1, ceiling 3) stays. Plan mode is unchanged (it keeps ceiling 3).
   *Why not keep file slices past 800:* two sizing axes that multiply is what the ticket's cap exists to avoid.
   `[unsourced]`: whether a per-lens agent can read a >800-line diff in full within its ~40-call budget. The
   contract's own skimmed/skipped accounting surfaces that when it happens, which is enough.
2. **New lenses (6)**, about 45 lines each, following the existing structure (header, "Triggered when the
   target …", Look for, Rules, done =, Don't flag, Return pointing at the contract):
   - `agent-native-lens.md`: the target changes SKILL.md, prompt, handoff/wt-message text, or MCP tool prose.
     It looks for instructions an agent will misread, script paths that are not sibling-relative (CLAUDE.md:
     never `~/.claude/skills/…`), ambiguity between the user and wt-message traffic, and the lockstep copies
     wt-ship warns about.
   - `reliability-lens.md`: timeouts, retries, launchd plists, child processes, kill paths (CLAUDE.md BSD pkill
     trap), and Monitors whose arm can silently fail (the CLAUDE.md WP-152 trap).
   - `performance-lens.md`: polling intervals, work per tick, render loops, unbounded reads (WP-146's tray
     rebuild every 4 s is the worked example).
   - Trigger rows are added to the table, and the adversarial trigger's "retries … an external call" is kept
     (reliability looks for defects, adversarial attacks the premise; the overlap is accepted).
   - Bundle table: agent-native joins bundle 1 (standards, same reading surface); reliability and performance
     join bundle 3.
3. **Maintainability → scope.** Add "Look for" bullets to `scope-lens.md`: duplicated logic that a
   sibling helper already provides, and a new abstraction with one caller. Its trigger is unchanged.
4. **Verdict word (7).** The verdict's first line is exactly one of **Approve**, **Approve with fixes**, or
   **Send back**. The rules are: any confirmed high-severity finding, an intent mismatch, or partial coverage
   → Send back; confirmed medium/low findings only → Approve with fixes; none → Approve. The coverage line stays
   last. wt-watch-prs maps Approve → approve, Approve with fixes → comment, Send back → hold. Edit its §3 table.
5. **Fixes and residuals (7).** wt-ship's apply step applies each confirmed finding by its `suggested_fix`
   (after verifying the load-bearing ones, as it already says). `residual_risks` that survive dedupe are filed
   by the **caller of wt-review** (wt-ship in diff mode, wt-plan in plan mode), not by reviewers, with
   `../wt-ticket/scripts/wt-ticket new` (labels `residual`, one ticket per distinct risk, and only on a local
   board: `wt-ticket keys` matches the repo). Otherwise they are listed in the PR body. Reviewers never file
   tickets. `[unsourced]`: the exact `wt-ticket new` flags. The worker reads `wt-ticket`'s usage line first.
6. **Lens wording (8).** Every lens file says "target", not "plan", where it runs in both modes. Every lens gets
   a `done =` line (what a finished pass has checked) and a `Don't flag` list specific to that lens. The
   contract's general false-positive list stays in the contract. Each lens's inline JSON template is replaced
   by one line: "Write findings per `references/reviewer-contract.md` and SKILL.md's schema", which removes
   the drift noted above.
- Out of scope, per the ticket: cross-model peer, run-dir/finish machinery, depth packs, and stack personas.

## Units
1. **Lens wording pass:** all 11 existing lens files get plan→target where both modes apply, `done =`, `Don't
   flag`, the JSON template replaced by a contract pointer, and maintainability bullets in scope. One commit
   (`wt-review`).
2. **New lens files:** agent-native, reliability and performance. Add them to the trigger and bundle tables.
3. **Sizing:** rewrite `SKILL.md` "Size by diff" per decision 1. Update the "Floor 1 agent. Ceiling 3" sentence
   to say the ceiling is 3 at ≤200 lines and 5 for per-lens diff reviews.
4. **Verdict word:** a new first-line rule in `SKILL.md` (next to the coverage line section), and the
   wt-watch-prs §3 mapping. The wt-watch-prs edit is its own commit.
5. **wt-ship:** the apply step uses `suggested_fix`, and residual filing per decision 5 (a `wt-ship` commit).
   wt-plan step 7 gets one sentence for plan-mode residuals (a `wt-plan` commit).
6. **Docs:** `docs/features.md` wt-review entry (the verdict words, per-lens split, and new lenses).

## Definition of done
Each item is checkable from a transcript by running the command shown:
- `grep -c "Triggered when the plan" skills/wt-review/references/agents/{security,data,scope}-lens.md` → 0
  for each.
- `grep -L "done =" skills/wt-review/references/agents/*.md` → prints nothing (every lens, 14 files).
- `grep -l '"severity": "high|medium|low"' skills/wt-review/references/agents/*.md` → nothing (no stale
  inline schema).
- `ls skills/wt-review/references/agents/` lists `agent-native-lens.md`, `reliability-lens.md` and
  `performance-lens.md`, and each is named in the SKILL.md trigger table (`grep -c` ≥1 each).
- `grep -n "Approve with fixes" skills/wt-review/SKILL.md skills/wt-watch-prs/SKILL.md` matches in both.
- `grep -n "suggested_fix\|residual" skills/wt-ship/SKILL.md` matches the apply step.
- `grep -n "ceiling stays 3" skills/wt-review/SKILL.md` → nothing, and the new text says 5.
- `node --test skills/wt-shared/scripts/paths.test.mjs` passes (no `~/.claude/skills` in the new prose), and
  `./setup doctor` is clean.
- A dogfood check: wt-ship's own wt-review run on this branch prints a verdict word as its first line.

## Order
1 → 2 → 3 → 4 → 5 → 6. Unit 1 comes first because units 2–3 copy its lens shape. Make one commit per skill
touched.

## Risks
- A lockstep: the trigger table must not be restated in wt-ship (`wt-ship/SKILL.md:68-71` warns about this).
  Unit 5 references wt-review by name only.
- 5 parallel agents cost more. The >200-line threshold keeps small diffs at ≤3.
