---
name: wt-ship
description: >
  Finish implemented work: simplify the changed code, review the diff with a lens set sized from
  what it touches, record what was learned, and open a draft pull request — in that order, from a
  single read of the diff. Orchestrates wt-simplify, wt-review, wt-compound and wt-pr. Use after an
  implementation is complete and verified, when handed off from wt-work, or when asked to wrap up,
  tidy and open a PR for work already written. Not for reviewing someone else's PR or resolving
  feedback already left on one.
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Skill, Agent, AskUserQuestion, ToolSearch
---

# wt-ship

Four steps, one diff read, in this order. **The order is the content of this skill** — it is why the caller
invokes one name instead of four.

1. **`wt-simplify`** — so review spends its attention on code that will actually ship
2. **`wt-review`** (diff mode) — so every finding lands on the final shape
3. **`wt-compound`** — so the learning records what survived scrutiny, not what was merely believed
4. **`wt-pr`** — last, because it is the only step that publishes

**Local board ticket** (the branch starts with a `<KEY>-N` from `~/.claude/skills/wt-ticket/scripts/wt-ticket keys`, not UMK): once the PR is open,
`~/.claude/skills/wt-ticket/scripts/wt-ticket move <ID> review || true` and `~/.claude/skills/wt-ticket/scripts/wt-ticket comment <ID> "PR <url>" || true`. A merge-direct project (wt-pack: no PR)
moves it straight to `done` on the merge to main, with the merge commit as the comment.

Each is its own skill and owns its own rules; this one owns **the order, the shared diff read, and the
stop conditions between steps.** Never collapse it into "review before opening a PR" — that phrasing drops
the middle steps and nobody notices.


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

## 0. Read the diff once

`git diff <base>...HEAD`. Read it whole, before step 1. **You hold it for all four steps** — they are skills,
not subagents, so they run in this context and inherit what you have already read. Re-reading the diff per
step is the cost this skill exists to remove.

Note as you read: the unit boundaries (the commits), what the change touches, and the risk surface — step 2
sizes itself from the last one.

Confirm first that the work is actually finished: the plan's Definition of Done met, the tree clean, the
tests the change owns run. **Work that does not meet it is a blocker to report, not a scope to expand.**

## 1–4. Run them in order

Invoke each skill in turn. What this skill adds is what happens *between* them:

- **After `wt-simplify`** — if it changed anything, it committed separately; that commit is now part of what
  step 2 reviews. If it changed nothing, say so in one line and move on rather than retrying it.
- **Into `wt-review`** — hand it the diff's base, the plan path, the findings table and the plan's Definition
  of Done. It swaps its mandatory pair to correctness and regression for a diff and computes the rest from
  its own trigger table. **Do not restate its sizing rules**; a second copy of that table is a lockstep with
  nothing to fail when it drifts.
- **After `wt-review`** — apply the findings, verifying the load-bearing ones yourself first. A finding not
  applied is a finding wasted; record any you decline and why. **A finding that invalidates the work is a
  stop**, not an input to step 3.
- **Into `wt-compound`** — the applied review findings and the plan's `disproved` records are its input. Most
  runs record nothing, which is the normal outcome.
- **Into `wt-pr`** — the two paragraphs only this run can write, what research corrected and what review
  corrected, come from steps 2 and 3.

## After the PR

**Tell the planner.** If a planner handed you this work, move its label on (a no-op otherwise, or once the
planner has moved to another ticket):

```
~/.claude/skills/wt-shared/scripts/task-state.sh planner "done (PR #<N>)"
```

Not a fifth step — the four above are what `wt-ship` *does*. Both of these are the user's call, so offer
them in one line each and wait for a yes.

- **`wt-babysit`** — watches the open PR until it is merge-ready, working review rounds and CI as they land.
  Offer it once the PR is open and you are leaving it unattended. Note what it will be watching: the PR you
  just opened is a **draft**, so in most repositories CI runs on it and review does not. `wt-babysit` knows
  the difference: it watches CI, **promotes the PR once the checks are green** — which is what starts
  review — and works the review rounds from there. It still never merges.
- **`wt-finish`** — retires the worktree and its branch, **after the PR merges**. Never offer it at PR-open
  time: the branch is what the draft PR points at, and deleting it closes the PR. `wt-finish` refuses on an
  open PR for that reason, but the offer should not create the pressure in the first place.

Both are standalone, so a user who says no here can invoke either later by name.

## Rules

- **Do not re-plan.** Work that does not meet the Definition of Done is a blocker to report, not a scope to
  expand.
- **Do not promote the PR** out of draft. Shipping ends at an open draft; promotion belongs to
  `wt-babysit`, which does it on green.
- **Do not skip a step silently.** "Nothing to simplify" and "nothing worth recording" are results to state,
  not steps to omit.
- **Report honestly.** If tests fail, say so with the output. If a step was skipped, say which and why.
