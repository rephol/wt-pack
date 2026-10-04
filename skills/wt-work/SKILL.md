---
name: wt-work
description: >
  Implement a plan to its Definition of Done, unit by unit, with an explicit evidence strategy
  per unit, test discovery before changes, a system-wide check of what fires two levels out,
  and incremental commits on logical boundaries. Takes the plan's findings table so cited
  claims are not re-researched. Use when implementing from a plan document or a concrete work
  prompt, when handed off from wt-plan, or when asked to carry out an agreed plan. Use a
  debugging approach instead for open-ended bugs with no plan.
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Skill, Agent, AskUserQuestion, ToolSearch, NotebookEdit
---

# wt-work

Paths to scripts and files are relative to this skill's base directory (announced when it loads), so they
work both from the `./setup` links and from a plugin install (WP-122).

Implements a plan. Does not re-plan it, and does not ship it — the tail is `wt-ship`.

**This skill is the heaviest in the pack on purpose.** Everywhere else the pack trades prose for structure;
here the prose *is* the quality. Read the references. They are not optional context.

## Intake

Read, in this order:

1. **The plan.** Whole. Including the deferred section and the Definition of Done.
2. **Its inline evidence** (`references/evidence-intake.md`). A claim quoting a `file:line` was verified when
   the plan was written — do not re-research it. A claim marked `[unsourced]` was not; verify it before
   depending on it.
3. **Settled decisions** (`references/settled-decisions.md`). A decision labelled `settled:` was made by the
   user and is not yours to improve.


## Execution discipline

Measured across three full runs of this pack and its predecessor. Turn count is what costs — each turn
re-processes a growing context — so these two rules outrank any prose below them.

- **Batch independent calls.** Reads, greps and globs that do not depend on one another belong in one turn,
  either as several tool calls in a single message or as one compound shell command. The compound command is
  the idiom that actually gets used here (93–100% of `Bash` calls in the runs that went well, median ~200
  characters); a run that degenerates into many tiny calls is the failure shape to avoid.
- **Write whole files; do not build them with edits.** A new file, or a rewrite of most of one, is a single
  `Write`. Reach for `Edit` only for a small change to a file that mostly stays. The run that followed this
  rule used 13 edits where the run that did not used 27, for the same measured defect-detection power.

## The loop

Read `references/implementation-loop.md` before the first unit, and work it per unit. In outline, for each
unit in order:

- mark in progress; read the files the plan names
- **if the unit's work is already present and matches the plan's intent**, verify and move on — do not
  silently reimplement
- **if completion depends on out-of-repo state** (a console setting, a DNS record, live rows), decide from
  the observed state of the deliverable, never from a clean tree
- find the existing tests for what you are about to change (`references/evidence-strategy.md`)
- choose the evidence strategy **before** changing behaviour, and get the red first when it calls for it
- implement, following the conventions already in the files
- run the **system-wide check** (`references/system-wide-check.md`)
- run the tests; record what was proven
- evaluate an incremental commit (`references/incremental-commits.md`)

## Verification honesty

Record per unit: did behaviour change, which existing tests you inspected, what you added/changed/left
unchanged, whether you observed the expected failure, what you ran, and any deliberate no-test exception with
its replacement verification.

**Never report a step as run that was not run.** A plan's verification section is instructions; your report is
results. If the worktree cannot exercise the change — missing service, credential or environment — say that
plainly instead of implying a check happened.

## Blockers

Stop and report, rather than working around:

- a `settled:` decision that implementation proves unworkable (infeasible, wrong-thing, destructive)
- a plan step that targets something that does not exist
- a finding the plan cited that the code contradicts — research was wrong, and that changes the plan
- scope the plan does not cover that the Definition of Done requires

When you stop on a blocker, also put it on the planner's label (a no-op if no planner handed you this):

```
../wt-shared/scripts/task-state.sh planner "blocked: <reason, a few words>"
```

On a local board ticket (`<KEY>-N`, not a Linear team key), also move its card: `../wt-ticket/scripts/wt-ticket move <ID> blocked --note "<reason>" || true`.

A real defect found inside a settled approach is still reported at full strength. The label never suppresses
defect evidence.

## Rules

- **Follow existing patterns.** Read the neighbours first; match naming exactly; reuse what is there. When in
  doubt, grep for a similar implementation rather than inventing a shape.
- **Do not over-implement.** The unit's slice, not the feature you can see from it.
- **Keep the task list current** and reference the plan's unit ids in blockers and summaries.
- **Do not open a PR, review your own diff, or run the tail.** That is `wt-ship`.
- **Infra errors are not yours to retry.** If a command fails for a cause outside the ticket (auth, network, a down
  service), report it once through the reply channel and stop. Do not retry under `/goal`: it re-prompts every turn,
  and the dashboard watchdog clears the goal of an agent that repeats the same infra error (WP-220).
