# WP-369 plan: preferences hook sends only what changed

Base: origin/main (3466d23). Branch `wp-369-prefs-diff`. Areas: wt-memory, wt-dashboard (housekeeping, Settings ›
Memory), plus one post-merge edit of the user's live store (U5, not in the PR).

## Goal

A long orchestrator session today receives the whole preference list again each time any preference line
changes. After this change the `UserPromptSubmit` re-injection carries only the lines that were added, removed or
changed (grouped by section). SessionStart (also after `/clear` and compaction) keeps the full list.
Gate A added (user answers, see the end): a line in a shared preference file can carry `[role: X]` / `[project: Y]`
tags so it reaches only those agents (U4, U4b), and the umkmall-only orchestrator lines move out of
`roles/orchestrator.md` into `projects/umkmall.md` so other projects' orchestrators stop receiving them (U5).

## What research corrected

- **Ticket part (2), "filter the Role preferences sections by role so orchestrator rules never reach engineer or QA
  agents", is already true for the role file.** `skills/wt-memory/scripts/wt-memory:35-38` (`merge`) builds
  `Global preferences`, then `Role preferences (${role})` from `file('role', role)` only the agent's own role, then
  `Project preferences (${project})` from the agent's own project only. A worker never receives
  `roles/orchestrator.md`; a project file (`umkmall.md`) only reaches agents whose project token/repo basename is
  `umkmall`. Nothing to build for those two. The hook calls `wt-memory context --cwd` (`inject.mjs:122`), which runs
  `infer()` for role and project.
- What can still reach the wrong agent: (a) a role-specific line written into `global.md` or a project file (the
  scopes are shared by every role of that scope; e.g. the live `projects/umkmall.md` lines `5441dc` "As orchestrator,
  never let a builder ..." and `db3785` "As umkmall orchestrator you are the WATCHER ..." reach every umkmall agent;
  correction at gate A: the "Never merge into main ..." line cited earlier lives in `roles/worker.md:3`, not in
  `projects/wt-pack.md`, so it is already scoped);
  (a2) the reverse: `roles/orchestrator.md:19-29` holds 11 umkmall-only lines that reach every project's orchestrator;
  (b) `infer()` falling back to no role when `herdr pane get` fails (500 ms, `wt-memory:57-62`), which drops the
  role section for that call. (a) and (a2): answered at gate A, units U4 and U5. (b): U1b.
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

### Line tags (gate A Q1)

Syntax: at the start of a line's content, after an optional `- ` / `* ` bullet, one or more groups
`[role: a, b]` / `[project: c]` (keys lowercase; each value matches wt-memory's `NAME`; spaces after `:` and `,`
optional). Anything else in brackets (`[WIP]`, `[team: x]`, a value that fails `NAME`) is not a tag and the line is
ordinary text (fail open: a typo never hides a line). Tech-lead decisions, each with its reason:

- **Where honored:** every store file `merge()` reads: `global.md`, `roles/*.md`, `projects/*.md`. Not the repo's
  `.wt-pack/roles/` files (WP-204/334: separate trust path, a project's own file needs no project tag). Reason: one
  rule everywhere is simpler to explain and to show in Settings than "tags work in two of three files".
- **Match:** OR within a group, AND across kinds (`[role: orchestrator] [project: umkmall]` = umkmall's orchestrator
  only); two groups of one kind union. A `role` tag matches the agent's `role` OR its `persona` (umkmall agents are
  personas such as `mlj-tech-lead` whose base role is `worker`; a tag must be able to name either).
- **Unknown role/project:** a role tag needs a resolved role or persona, a project tag a resolved project; with none,
  the tagged line is dropped (it is addressed to someone this agent is not shown to be). A plain session with no pane
  and no `WT_ROLE` therefore gets no role-tagged lines; correct by the same rule.
- **Extent:** a tag covers its line plus the indented continuation lines directly under it (a multi-line bullet
  is dropped or kept whole).
- **Injected text:** the tag groups are removed from the lines an agent receives (the bullet stays). Reason: the
  agent only gets lines that apply, so the tag is noise, and a re-tag that keeps a line visible is not a change.
- **Interaction with U1 (diff):** tags are applied inside `merge()`, so `hash`, `.ctx` and the diff all see the
  filtered text. An edit to a line tagged for another role changes nothing for this agent (no re-injection); moving
  a line between files shows as `-` in one section and `+` in the other; a re-tag that now excludes this agent shows
  `-` ("no longer applies"), which is the truth.
- **Interaction with U1b (role unknown):** this makes U1b more important, not less: without it, a transient
  `herdr pane get` failure would turn every role-tagged shared line into a `-` too. With `--strict-pane` the prompt
  emits nothing and the next healthy prompt diffs against the last good text. SessionStart on a failed lookup keeps
  today's role-less behaviour (role-tagged lines absent, as the role file already is).
- **`recall` (WP-235)** reads `entries()` directly, not `merge()`; it must apply the same tag filter or it would
  leak a role-tagged line into another role's prompt. In U4.
- **`remember`:** an explicit `--role R` / `--project P` flag (not one inferred from the pane) becomes a tag when it
  does not select the file: `--scope project` (or no `--scope` with a project inferable) + `--role R` writes
  `[role: R]` into the project file; `--scope global` + `--role`/`--project` stores the tags on the pending proposal
  and `accept` writes them. `--scope role --role R` and `--scope project --project P` select the file exactly as
  today. Reason: today those flags are silently ignored in exactly these combinations, so honouring them breaks no
  working call; output and exit codes keep their shape (CLAUDE.md "Keep every CLI backward compatible"). The MCP
  `remember` tool passes the same args, so it inherits this; its `role`/`project` descriptions say so.
- **`entries()` / `list --json`:** each entry's `text` is tag-free and gains `tags: {role?: string[], project?:
  string[]}` only when tagged (additive field). `list` text output prefixes `[role: …]`. `dup()` compares
  tag-free text AND equal tags (the same rule for two roles is two entries).

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
Also document the tag syntax and rules from "Line tags" (SKILL.md store section and `remember` line,
`docs/features.md` wt-memory section and the Settings › Memory entry ~line 715 for U4b's display), and the
`remember --role/--project` tag behaviour. `docs/features.md` is owned by this unit only (U4b sends its one sentence
here) so one committer touches it.
Same commit as U1, U1b and U4 (one skill, CLAUDE.md "one commit per skill touched"): order U1, U1b, U4, U2.

### U4: line tags in shared preference files (gate A Q1)
Owner: wt-pack:wt-engineer
Deps: U1b (shares `flags`/`infer` in `wt-memory`; its tests then cover role-tagged lines on a failed lookup).
Files: `skills/wt-memory/scripts/wt-memory` (tag parser, `merge`, `entries`, `dup`, `remember`, `accept`, `recall`,
`list`), `skills/wt-memory/mcp/server.mjs` (descriptions only), `skills/wt-memory/scripts/wt-memory.test.mjs`.
Goal: "Line tags" in Approach. The parser is one function (`tagsOf(line) -> {tags, text}`) used by `merge`,
`entries` and `recall`; no second regex elsewhere (the dashboard reads `list --json`).
Tests (temp `WT_MEMORY_HOME`):
- red proof first: `global.md` with `- [role: orchestrator] only-orch` and `- for-all`; `context --role worker` must
  not contain `only-orch`; fails today (the line passes unfiltered, tag and all).
- `context --role orchestrator` contains `- only-orch` without the tag text; `--persona X` matches `[role: X]`;
  `[role: a] [project: p]` needs both; `[role: a, b]` either; no role at all drops role-tagged lines; `[WIP] x` and
  `[role: bad/name] x` pass through unchanged; an indented continuation line follows its tagged bullet.
- tags in `roles/*.md` and `projects/*.md` honored too.
- `remember --scope project --project p --role orchestrator "x"` writes `- [role: orchestrator] x <!-- wtm:… -->`
  to `projects/p.md`; `--scope role --role r` writes untagged to `roles/r.md` (unchanged); `--scope global --role r`
  pending JSON carries the tag and `accept` writes it; same text with different tags is not a dup, same tags is.
- `list --json` gives `text` without the tag and `tags`; untagged entries have no `tags` key.
- `recall` as worker never returns an orchestrator-tagged entry that shares keywords with the prompt.
- hook (with U1): a SessionStart then an edit to an orchestrator-tagged line in `global.md` as `WT_ROLE=worker`:
  next UserPromptSubmit emits no preference text.

### U4b: Settings › Memory shows tags (gate A Q1)
Owner: wt-pack:wt-engineer
Deps: U4's `list --json` contract above (can start against a fixture; final check after U4 is committed).
Files: `skills/wt-dashboard/web/src/memory.tsx`, `skills/wt-dashboard/server.mjs` (preview route only),
a web unit test beside them, `skills/wt-dashboard/SKILL.md` (the Memory line).
Goal: the "Remembered by agents" row's supporting line shows the tags (`project umkmall · for orchestrator · by ·
at`); each file editor gets one supporting line under it naming the syntax ("Start a line with [role: id] or
[project: name] to send it only to those agents."; copy is the engineer's, kept to one line); the Preview passes
the agent's `persona` token too (`/api/memory/preview` accepts `persona`, same `MEMORY_NAME` check, `--persona`
to `context`) so a persona-tagged line previews correctly. Server otherwise unchanged (it already relays
`list --json`). Tests: a pure formatter for the supporting line (tags present / absent) in a `*.test.ts` (web
tests run under `npm test` in `skills/wt-dashboard`); a route test for `/api/memory/preview?role=worker&persona=p`
with a temp `WT_MEMORY_HOME` holding `- [role: p] persona-only` (the server runs the real `wt-memory` from its
sibling path, so no PATH shim). Red proofs: both tests fail before the change. `npm run build`; the server change
needs one service restart (CLAUDE.md: not repeatedly). The browser check is QA's (QA brief).
Same wt-dashboard commit as U3 (one commit per skill), U3 first.

### U5: move the umkmall orchestrator lines and tag role-addressed lines in the live store (gate A Q1 + Q2)
Owner: wt-pack:wt-engineer
Deps: U4 merged to main and the main checkout at that commit (the full install loads the checkout through
`CLAUDE_CODE_PLUGIN_DIRS`, and every hook call spawns `wt-memory` fresh, so no session restart is needed for
`context`). Runs AFTER the merge, on the orchestrator's go; not part of the PR, no commit.
Decision: a one-off, reversible edit of `~/.config/wt-memory`, not a migration step in code. Reason: which line is
"role-addressed" is a judgement on prose that no code can make safely, and the store exists only on this machine;
shipped migration code would run against every other install's store. Order matters: moving the 11 lines into
`projects/umkmall.md` BEFORE tag-aware `merge()` is live would send them to every umkmall agent.
Manifest (exact; lines identified by `wtm` id, trailers kept byte-for-byte, only the `[role: orchestrator] ` prefix
is inserted after the bullet):
- Move from `roles/orchestrator.md` to the end of `projects/umkmall.md`, tagged `[role: orchestrator]` (11 lines):
  `4add31`, `2d47eb`, `5a9731`, `7e74c4`, `8c228d`, `aea65d`, `a4947d`, `7d2833`, `65c771`, `937f44`, `668f79`.
- Tag in place in `projects/umkmall.md` with `[role: orchestrator]`: `5441dc`, `db3785`.
- Nothing else is touched (see the new open questions for the lines left alone).
Procedure: (1) `mkdir -p ~/.local/share/wt-memory/backup/wp-369` and copy `roles/orchestrator.md` and
`projects/umkmall.md` there with `cp -p` (outside the store, so neither wt-memory nor the dashboard reads it);
(2) capture `wt-memory context --cwd / --role orchestrator --project wt-pack`, `… --project umkmall`, and
`--role worker --project umkmall` (also `--persona mlj-tech-lead --role worker --project umkmall`) to the backup dir
as `before-*.txt`; (3) apply the manifest with a short node script kept in the session scratchpad that edits by id and
refuses if any id is missing or present twice; (4) capture `after-*.txt` and check: orchestrator/wt-pack lost exactly
the 11 lines and nothing else; orchestrator/umkmall has the same line set as before (moved between sections,
tags not shown); worker/umkmall and the persona lost exactly `5441dc` and `db3785` and gained nothing.
Rollback: if neither file changed since step 1 (compare to the copies' mtime + sha256 recorded in step 1), copy the
two backups back; otherwise reverse the manifest by id (remove the prefix, move the 11 lines back). The backup dir
and the step-1 hashes stay until the user says otherwise. Evidence: the four before/after diffs (line lists, not the
files) in the ticket comment.

## Files
- `docs/plans/wp-369-prefs-diff-plan.md` (this plan)
- `skills/wt-memory/claude-plugin/hooks/prefdiff.mjs` (new)
- `skills/wt-memory/claude-plugin/hooks/inject.mjs`
- `skills/wt-memory/scripts/wt-memory` (U1b)
- `skills/wt-memory/scripts/wt-memory.test.mjs`
- `skills/wt-memory/SKILL.md`
- `docs/features.md`
- `skills/wt-dashboard/housekeeping.mjs`, `skills/wt-dashboard/housekeeping.test.mjs` (U3)
- `skills/wt-memory/mcp/server.mjs` (U4, descriptions)
- `skills/wt-dashboard/web/src/memory.tsx`, `skills/wt-dashboard/server.mjs` (preview `persona`), a web test,
  `skills/wt-dashboard/SKILL.md` (U4b)
- Not in the repo: `~/.config/wt-memory/roles/orchestrator.md`, `~/.config/wt-memory/projects/umkmall.md` (U5,
  post-merge, backup in `~/.local/share/wt-memory/backup/wp-369/`)

## Unit order, owners and parallelism
One worktree, one committer at a time; the lead serialises commits.
| Unit | Owner | Deps | Commit |
|---|---|---|---|
| U1 diff | wt-pack:wt-engineer (A) | none | wt-memory |
| U1b strict-pane | wt-pack:wt-engineer (A) | U1 | wt-memory |
| U4 tags | wt-pack:wt-engineer (A) | U1b | wt-memory |
| U2 pin + docs | wt-pack:wt-engineer (A) | U4 | wt-memory (one commit for U1, U1b, U4, U2) |
| U3 prune `.ctx` | wt-pack:wt-engineer (B) | none | wt-dashboard |
| U4b Settings tags | wt-pack:wt-engineer (B) | U4 contract (final check after A's commit) | wt-dashboard (one commit for U3, U4b) |
| U5 live store | wt-pack:wt-engineer | merge of the above | none (user data) |
Parallel: chain A (`skills/wt-memory/**`, `docs/features.md`) and chain B (`skills/wt-dashboard/**`) touch disjoint
paths and can run at the same time; B commits only when A is not committing, and B's commit waits for A's so the
U4b final check runs against real `list --json`. Within a chain units are serial. U5 runs alone after the merge.

## Definition of Done
- `node --test skills/wt-memory/scripts/*.test.mjs` passes, including the new tests above.
- `npm test` at the repo root passes (CLAUDE.md "Build and test"); `skills/wt-memory/scripts/paths.test.mjs` still
  passes (the new hook module is imported sibling-relatively).
- In a session with a stored `.ctx`, editing one preference line produces a UserPromptSubmit message that contains
  only that line's `+`/`-` and contains no other preference line (checked by the hook test, string absence).
- SessionStart output is byte-identical to before for the same inputs when no store line carries a tag (existing hook
  tests unchanged and green).
- A `[role: X]` / `[project: Y]` tagged line reaches only matching agents through `context`, the hook and `recall`;
  `remember --role/--project` writes tags as specified; `list --json` carries `tags` (U4 tests, red proof first).
- Settings › Memory shows an entry's tags and the syntax hint, and the preview honours a persona (U4b).
- A missing `.ctx`, or one whose hash is not the stored `.hash`, yields the old full `Preferences updated:` text,
  not an empty or error output.
- A failed `herdr pane get` on UserPromptSubmit yields no preference text and leaves `.hash`/`.ctx` unchanged; the
  CLI without `--strict-pane` is unchanged (U1b tests).
- `cd skills/wt-dashboard && npm test` passes with the `.ctx` prune test (U3).
- Each new guard (diff, stale-`.ctx` fallback, `--strict-pane`, `.ctx` prune, tag filter, `recall` tag filter,
  Settings tag formatter) has a red proof: its test's failing
  output on the pre-change code, quoted in the unit's commit or the review reply.
- `skills/wt-memory/SKILL.md` and `docs/features.md` describe changed-lines-only re-injection and the existing
  role/project scoping; neither says role filtering is new.
- One commit for wt-memory (code, tests, SKILL.md, docs), one for wt-dashboard (U3 + U4b), in the same merge; plan
  file already committed.
- After the merge, U5's after-captures show the expected deltas and nothing else; backup and hashes kept.

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
Tags: add `- [role: orchestrator] orch-only` to `projects/demo.md`; as worker, SessionStart lacks it; as
orchestrator it is present without the tag text; `wt-memory remember --scope project --project demo --role worker
"x"` then `list` shows the tag. Settings › Memory (agent-browser, `--session <name>`, dashboard as installed): an
entry with tags shows them; after U5, the Preview for a wt-pack orchestrator contains none of the 11 moved lines and
one for a umkmall orchestrator contains all of them. Evidence: the stdout texts and one screenshot.

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
- A mistyped tag value (`[role: orchestator]`) hides the line from everyone, silently. Accepted for now; Settings
  shows the tag so it is visible there. `wt-memory list` could warn on a tag naming no known role; deferred.
- U5 edits the user's live store. Guarded by the backup, by-id edits that refuse on a missing/duplicate id, the
  before/after captures, and the post-merge ordering above.

## User answers (gate A)
1. Line-level scoping inside shared files: yes. Units U4 (wt-memory) and U4b (Settings), migration in U5.
2. umkmall-only orchestrator lines: move them into `projects/umkmall.md` (tagged `[role: orchestrator]`) so other
   projects' orchestrators stop receiving them. Done as U5, a one-off reversible edit of the live store after merge.

## Open questions for the user (new, none blocks the units)
1. `roles/orchestrator.md` `25e4e6` "Never hand a ticket to the planner (/team-plan, ticket filing) without the
   user's explicit permission" names umkmall's `/team-plan`. Move it with the 11 (umkmall only) or keep it for every
   orchestrator? Default in U5: keep where it is.
2. `projects/umkmall.md` tech-lead lines `3629a1`, `012eda`, `18aeb0` ("As (umkmall) tech lead …") and `311c02`
   ("Never spawn … only the orchestrator does that", addressed to everyone but the orchestrator, which a tag cannot
   express): tag the tech-lead ones `[role: mlj-tech-lead]` (only that persona would get them; the subagent tech
   lead under a ticket lead has no pane role) or leave them for every umkmall agent? Default in U5: leave untagged.
3. `projects/umkmall.md` `940d5f` is the literal text `undefined` (a `remember` that lost its note). Remove it?
   Default: left alone; worth a separate ticket on how `remember` accepted it.
