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

- prior text readable: compute a line diff per `## <section>` of the previous vs current `ctx` (set difference on
  trimmed non-empty lines; a section that appears or vanishes lists all of its lines as added or removed) and emit
  `Preferences changed (lines added +, removed -; everything else you already have is unchanged):` followed by the
  sections that differ, each with `+ <line>` / `- <line>`. A line edited in place shows as one `-` and one `+`.
- prior text missing (a session whose state predates this change, deleted cache, first prompt with `prev === null`
  and non-empty ctx): fall back to today's full `Preferences updated:\n\n<ctx>`.
- everything removed (`ctx` empty, `prev` set): keep today's `(all standing preferences were removed)` wording.
- The change detection (hash) and the SessionStart text are untouched. The diff is a pure function in a new module
  `skills/wt-memory/claude-plugin/hooks/prefdiff.mjs` (imported by `inject.mjs` the same way `paths.mjs` is) so it
  is unit-testable without spawning the hook.

Alternatives rejected: diffing in the `wt-memory` CLI (`context --since`): the CLI runs for Codex/Gemini too and a
new flag is more surface than a hook-local cache; storing the text in `.hash` itself: breaks the `.hash` file's
existing meaning for anything reading it. [unsourced: no other reader of `.hash` was searched beyond the repo
grep for `.hash`, which shows only `inject.mjs`]

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

### U2: pin and document the role/project scoping that already exists
Owner: wt-pack:wt-engineer
Files: `skills/wt-memory/scripts/wt-memory.test.mjs`, `skills/wt-memory/SKILL.md` (the Claude Code paragraph at
~line 44-47), `docs/features.md` (the Memory entry at ~line 715).
Goal: no behaviour change. Add tests that `wt-memory context --role worker` never contains text from
`roles/orchestrator.md` and that a project file only appears for its own `--project`; assert the same through the
hook (`WT_ROLE=worker`) for both SessionStart and the changed-lines message. Document: "re-injected as changed lines
only; SessionStart keeps the full list; the context already holds only global + the agent's own role + its own
project".
Same commit as U1 (one area, one skill, per CLAUDE.md "one commit per skill touched"): the order is U1 then U2.

## Files
- `docs/plans/wp-369-prefs-diff-plan.md` (this plan)
- `skills/wt-memory/claude-plugin/hooks/prefdiff.mjs` (new)
- `skills/wt-memory/claude-plugin/hooks/inject.mjs`
- `skills/wt-memory/scripts/wt-memory.test.mjs`
- `skills/wt-memory/SKILL.md`
- `docs/features.md`

## Definition of Done
- `node --test skills/wt-memory/scripts/*.test.mjs` passes, including the new tests above.
- `npm test` at the repo root passes (CLAUDE.md "Build and test"); `skills/wt-memory/scripts/paths.test.mjs` still
  passes (the new hook module is imported sibling-relatively).
- In a session with a stored `.ctx`, editing one preference line produces a UserPromptSubmit message that contains
  only that line's `+`/`-` and contains no other preference line (checked by the hook test, string absence).
- SessionStart output is byte-identical to before for the same inputs (existing hook tests unchanged and green).
- A missing `.ctx` yields the old full `Preferences updated:` text, not an empty or error output.
- `skills/wt-memory/SKILL.md` and `docs/features.md` describe changed-lines-only re-injection and the existing
  role/project scoping; neither says role filtering is new.
- One commit for wt-memory (code, tests, SKILL.md) and the docs line in the same merge; plan file already committed.

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

## Risks and deferred
- `infer()` can lose the role transiently (herdr call timeout). Today that already flips the hash and re-sends the
  list; with diffs it would send a spurious `-` for the whole role section and a `+` when it returns. Not fixed here
  (a separate defect in `infer`); the message wording says lines are "removed from your preferences" only as a diff,
  and the next prompt restores them. Acceptable; note it in the commit.
- Diff granularity is the line; a reordered line is not a change (set difference), a duplicated line is not either.
- Cache files `<session>.ctx` grow the cache dir by up to a few KB per session; `.hash` files are never pruned
  today either. Pruning is deferred.
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
