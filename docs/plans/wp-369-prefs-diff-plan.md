# WP-369 plan: preferences hook sends only what changed

Base: origin/main (3466d23). Branch `wp-369-prefs-diff`. Area: wt-memory only.

## Goal

A long orchestrator session today receives the whole preference list again each time any preference line
changes. After this change the `UserPromptSubmit` re-injection carries only the lines that were added, removed or
changed (grouped by section). SessionStart (also after `/clear` and compaction) keeps the full list.

## What research corrected

- **Ticket part (2), "filter the Role preferences sections by role so orchestrator rules never reach engineer or QA
  agents", is already true for the role file.** `skills/wt-memory/scripts/wt-memory:35-38` (`merge`) builds
  `Global preferences`, then `Role preferences (${role})` from `file('role', role)` only the agent's own role, then
  `Project preferences (${project})` from the agent's own project only. A worker never receives
  `roles/orchestrator.md`; a project file (`umkmall.md`) only reaches agents whose project token/repo basename is
  `umkmall`. Nothing to build for those two. The hook calls `wt-memory context --cwd` (`inject.mjs:122`), which runs
  `infer()` for role and project.
- What can still reach the wrong agent: (a) a role-specific line written into `global.md` or a project file (the
  scopes are shared by every role of that scope; e.g. the live `projects/wt-pack.md` line "Never merge into main and
  never git push ... the orchestrator merges after QA" is addressed to workers but also lands in the orchestrator);
  (b) `infer()` falling back to no role when `herdr pane get` fails (500 ms, `wt-memory:57-62`), which drops the
  role section for that call. (a) needs a product decision, see Open questions. (b) is a risk below.
- "Keep the full list at SessionStart" is already true: `inject.mjs:141` `text = [ctx, how, rooms, wtm]`.
- The ticket says the hash file is `<session_id>.hash` (~line 132) and the update text ~line 142: both confirmed
  (`inject.mjs:132`, `:142`). The hash file holds only 16 hex characters, so a diff is impossible today: the previous
  text is not kept. This is the real work.

## Approach

`inject.mjs` keeps, next to `<session>.hash` in `~/.cache/wt-memory/`, the last injected `ctx` text as
`<session>.ctx` (written wherever `.hash` is written, `inject.mjs:146-147`, both events). On `UserPromptSubmit`
when `prev !== hash`:

- prior text readable AND its hash equals `prev` (`sha256(.ctx).slice(0,16) === prev`, the same digest as
  `inject.mjs:130`; review: two best-effort writes can leave a `.ctx` that is not the text `prev` describes, and a
  diff against it would miss a line added then removed in between): compute a line diff per `## <section>` of the previous vs current `ctx` (set difference on
  trimmed non-empty lines; a section that appears or vanishes lists all of its lines as added or removed) and emit
  `Preferences changed (lines added +, removed -; everything else you already have is unchanged):` followed by the
  sections that differ, each with `+ <line>` / `- <line>`. A line edited in place shows as one `-` and one `+`.
  The header says plainly that a `-` line no longer applies (stop following it) and a `+` line now applies, so a
  bullet line (`- Never merge …` becomes `- - Never merge …`) is not misread; exact wording is the engineer's,
  pinned by the hook test.
- a transient role lookup failure is NOT a change (review decision, see U1b): on `UserPromptSubmit` the hook calls
  `wt-memory context --strict-pane`; when `HERDR_PANE_ID` is set, role or project was still unresolved, and
  `herdr pane get` threw or timed out, `context` prints nothing and exits 75. The hook already treats a failed
  `context` as "no preferences this prompt" (`inject.mjs:128`: `ctxOut == null` emits only the reminder and
  writes no state), so `.hash`/`.ctx` keep the last good text and the next prompt diffs against it.
  SessionStart does not pass the flag (its output stays byte-identical, DoD).
- prior text missing or not matching `prev` (a session whose state predates this change, deleted cache, a failed
  write, first prompt with `prev === null` and non-empty ctx): fall back to today's full `Preferences updated:\n\n<ctx>`.
- everything removed (`ctx` empty, `prev` set): keep today's `(all standing preferences were removed)` wording.
- The change detection (hash) and the SessionStart text are untouched. The diff is a pure function in a new module
  `skills/wt-memory/claude-plugin/hooks/prefdiff.mjs` (imported by `inject.mjs` the same way `paths.mjs` is) so it
  is unit-testable without spawning the hook.

Alternatives rejected: diffing in the `wt-memory` CLI (`context --since`): the CLI runs for Codex/Gemini too and a
new flag is more surface than a hook-local cache; storing the text in `.hash` itself: breaks the `.hash` file's
existing meaning for anything reading it. (Review corrected the earlier "only `inject.mjs`" claim:
`skills/wt-dashboard/housekeeping.mjs:112` prunes the cache by file name,
`f.match(/^(.+)\.hash$/) && !ctx.live.sessions.has(m[1])`, older than `cacheDays`; it never reads content. So `.ctx`
needs the same pruning, U3.)

## Implementation units

### U1: line diff on UserPromptSubmit
Owner: wt-pack:wt-engineer
Files: `skills/wt-memory/claude-plugin/hooks/prefdiff.mjs` (new), `skills/wt-memory/claude-plugin/hooks/inject.mjs`.
Goal: the approach above. `prefdiff.mjs` exports `diffPrefs(prev, cur)` returning the formatted block or `null`
when the two are equal after trimming. Writes of `.ctx` are best effort like `.hash` (failure never blocks the hook;
`inject.mjs` ends in a blanket `catch {}`). Keep the hook's 2 s context budget: no extra subprocess.
Tests (in `skills/wt-memory/scripts/wt-memory.test.mjs`, which already owns hook tests; note its `hook()` helper gives
every call a fresh `HOME`, so these tests must pass one shared `HOME` and a fixed `session_id` so the cache survives
between calls):
- unit: `diffPrefs` add only, remove only, edit (one `-` and one `+`), new section, vanished section, identical
  returns null, CRLF/trailing space not counted as a change.
- hook: SessionStart (full list in the output), then edit one line of the role file, then UserPromptSubmit: output
  contains `Preferences changed`, the new line with `+`, the old with `-`, and does NOT contain an unchanged line from
  the same file or from `global.md`.
- hook: UserPromptSubmit with no `.ctx` but a stale `.hash` (older state): falls back to full `Preferences updated:`.
- hook: no change between two prompts: no preference text (existing behaviour kept).
- hook: all preference files emptied after a SessionStart: `(all standing preferences were removed)`.
- hook: `.ctx` present but written for an older hash (overwrite `.ctx` with different text, keep `.hash`): falls
  back to full `Preferences updated:`, never a diff against the stale text.
Use a test-local `WT_MEMORY_HOME` (not the shared `home` other tests mutate). Red proof: the hook tests asserting
`Preferences changed` and the stale-`.ctx` fallback are written and run first, and fail on the current
`inject.mjs` (it always sends `Preferences updated:`); keep that failing output for the review.

### U1b: a failed role lookup is not a preference change (review decision)
Owner: wt-pack:wt-engineer
Files: `skills/wt-memory/scripts/wt-memory` (`infer`, `context`, `flags`), `inject.mjs` (pass the flag on
UserPromptSubmit only), `skills/wt-memory/scripts/wt-memory.test.mjs`.
Goal: the `--strict-pane` behaviour in Approach. `infer` records that the `herdr pane get` call threw (today it is
swallowed at `wt-memory:64`, `} catch {}`); `context --strict-pane` then prints nothing and exits 75. Without the
flag, `context` and `hash` behave exactly as today (backward compatible CLI, CLAUDE.md). A pane whose lookup
succeeds but carries no `role` token is not a failure. `WT_ROLE` set (headless, `wt-memory:56`) skips the herdr call
and is unaffected. The `recall` subprocess is unchanged.
Tests (PATH-shimmed fake `herdr` in a temp dir, `HERDR_PANE_ID=p1`; never the real herdr, CLAUDE.md Traps):
- red proof first: shim returns `{"result":{"pane":{"tokens":{"role":"worker"}}}}`; SessionStart, then shim exits 1;
  UserPromptSubmit. Before U1b this prints `-` lines for every worker line (after U1) or the role-less full list
  (today); after U1b it prints no preference text and `.hash` is unchanged. Then shim succeeds again and an edited
  worker line yields only that line's `-`/`+`.
- `wt-memory context --strict-pane` with the failing shim exits 75 with empty stdout; without the flag exits 0 with
  global + project (today's output).
- shim succeeds with no `role` token: `--strict-pane` exits 0.

### U3: prune `.ctx` with `.hash`
Owner: wt-pack:wt-engineer
Files: `skills/wt-dashboard/housekeeping.mjs:112`, `skills/wt-dashboard/housekeeping.test.mjs`.
Goal: the stale-cache matcher takes `^(.+)\.(hash|ctx)$`, same liveness and age rule. Test: a dead session's old
`.ctx` is deleted, a live or fresh one kept (extend the existing fixture at `housekeeping.test.mjs:23-24`, adjust
the file count at `:80`). Red proof: the new `dead.ctx` assertion fails before the regex change. Own commit
(wt-dashboard is another skill).

### U2: pin and document the role/project scoping that already exists
Owner: wt-pack:wt-engineer
Files: `skills/wt-memory/scripts/wt-memory.test.mjs`, `skills/wt-memory/SKILL.md` (the Claude Code paragraph at
~line 44-47), `docs/features.md` (the `## wt-memory` section, ~line 1025: "injected at session start (re-injected when they
change)"; review: ~715 is the Settings tab list, not this feature).
Goal: no behaviour change. Add tests that `wt-memory context --role worker` never contains text from
`roles/orchestrator.md` and that a project file only appears for its own `--project`; assert the same through the
hook (`WT_ROLE=worker`) for both SessionStart and the changed-lines message. Document: "re-injected as changed lines
only; SessionStart keeps the full list; the context already holds only global + the agent's own role + its own
project".
Same commit as U1 and U1b (one area, one skill, per CLAUDE.md "one commit per skill touched"): the order is U1,
U1b, U2. U3 is a separate wt-dashboard commit; `docs/features.md` goes with the wt-memory commit.

## Files
- `docs/plans/wp-369-prefs-diff-plan.md` (this plan)
- `skills/wt-memory/claude-plugin/hooks/prefdiff.mjs` (new)
- `skills/wt-memory/claude-plugin/hooks/inject.mjs`
- `skills/wt-memory/scripts/wt-memory` (U1b)
- `skills/wt-memory/scripts/wt-memory.test.mjs`
- `skills/wt-memory/SKILL.md`
- `docs/features.md`
- `skills/wt-dashboard/housekeeping.mjs`, `skills/wt-dashboard/housekeeping.test.mjs` (U3)

## Definition of Done
- `node --test skills/wt-memory/scripts/*.test.mjs` passes, including the new tests above.
- `npm test` at the repo root passes (CLAUDE.md "Build and test"); `skills/wt-memory/scripts/paths.test.mjs` still
  passes (the new hook module is imported sibling-relatively).
- In a session with a stored `.ctx`, editing one preference line produces a UserPromptSubmit message that contains
  only that line's `+`/`-` and contains no other preference line (checked by the hook test, string absence).
- SessionStart output is byte-identical to before for the same inputs (existing hook tests unchanged and green).
- A missing `.ctx`, or one whose hash is not the stored `.hash`, yields the old full `Preferences updated:` text,
  not an empty or error output.
- A failed `herdr pane get` on UserPromptSubmit yields no preference text and leaves `.hash`/`.ctx` unchanged; the
  CLI without `--strict-pane` is unchanged (U1b tests).
- `cd skills/wt-dashboard && npm test` passes with the `.ctx` prune test (U3).
- Each new guard (diff, stale-`.ctx` fallback, `--strict-pane`, `.ctx` prune) has a red proof: its test's failing
  output on the pre-change code, quoted in the unit's commit or the review reply.
- `skills/wt-memory/SKILL.md` and `docs/features.md` describe changed-lines-only re-injection and the existing
  role/project scoping; neither says role filtering is new.
- One commit for wt-memory (code, tests, SKILL.md, docs line), one for wt-dashboard (U3), in the same merge; plan
  file already committed.

## QA brief
A user (the QA agent) in a throwaway `WT_MEMORY_HOME` and `HOME` (never the live `~/.config/wt-memory`, never a real
agent's pane): create `global.md`, `roles/orchestrator.md`, `roles/worker.md`, `projects/demo.md`. Pipe a
SessionStart JSON to `skills/wt-memory/claude-plugin/hooks/inject.mjs` with `WT_ROLE=worker`, then edit one line in
`roles/worker.md` and pipe a UserPromptSubmit JSON with the same `session_id`; then edit `roles/orchestrator.md` and
prompt again; then delete `<session>.ctx` and change the file once more.
Evidence kept (nothing else): the three hook stdout JSONs plus the SessionStart one, as text in the QA comment on the
ticket, and the `node --test` summary line. Expected: SessionStart has all of global + worker + project and never
orchestrator text; first prompt shows only the changed worker line as `-`/`+`; second prompt (orchestrator edit)
produces no preference text for the worker; the deleted-`.ctx` case shows the full list under `Preferences updated:`.
Role-loss case: with a PATH-shim `herdr` in a temp dir (never the real herdr) and `HERDR_PANE_ID` set instead of
`WT_ROLE`, make the shim fail for one prompt after a preference edit: that prompt has no preference text; the next
(shim healthy) shows only the edited line.

## Risks and deferred
- `infer()` can lose the role transiently (herdr call timeout, 500 ms at `wt-memory:53`). Review decision: in scope
  (U1b). Reason: a diff turns the lost role section into an explicit "these lines no longer apply" for every role
  rule (for the orchestrator that includes its merge/push gates), which an agent can act on for a whole turn; today's
  full re-send is ambiguous but never says "stop". The guard is one flag and one exit code, no extra subprocess, and
  it also removes today's spurious full re-send. SessionStart keeps today's behaviour on a failed lookup (role-less
  list); not changed here.
- A multi-line preference (bullet with a continuation line) edited in one line shows only that line without its
  bullet; accepted, the line is the unit.
- Diff granularity is the line; a reordered line is not a change (set difference), a duplicated line is not either.
- Cache files `<session>.ctx` are a few KB per session; pruned with `.hash` by the dashboard's housekeeping (U3).
  Without the dashboard (plugin-only install) neither is pruned, as today.
- Deferred, awaiting the open question: tagging role- or project-specific lines inside shared files.

## Open questions for the user
1. Do you want line-level scoping inside the shared files (a line in `global.md` or a project file marked for
   specific roles, e.g. a `[role: worker]` prefix that `merge()` filters on)? The ticket's "orchestrator rules never
   reach engineer or QA agents" is already met for role files, so this only matters for role-addressed lines that
   live in global or project files (the `wt-pack.md` "Never merge into main" line is one). Yes: adds unit U3 in
   `wt-memory` (`merge`, `remember --role` option and the dashboard Settings list), a syntax to define and to show in
   Settings, and a migration of existing lines; No: this plan is complete as written and the fix for such lines is to
   move them into the role file.
2. "umkmall-specific lines only reach umkmall agents": confirm the intent is the existing `projects/umkmall.md`
   scoping (already works by repo basename). If instead some lines sit in `global.md` and are umkmall-only, the
   answer to question 1 covers them with a `[project: umkmall]` tag; otherwise nothing changes.
