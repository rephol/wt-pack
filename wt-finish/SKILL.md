---
name: wt-finish
description: >
  Retire a finished worktree: leave it, delete the directory, and delete the branch — after
  establishing that nothing is lost by doing so. Use when work on a worktree is done and merged,
  when asked to clean up or remove a worktree, or to tidy up stale worktrees from earlier tickets.
  Not for stepping out of a worktree you intend to come back to — that is ExitWorktree with keep.
allowed-tools: Bash, Read, Glob, Grep, AskUserQuestion, ToolSearch
---

# wt-finish

Deletes a worktree and its branch. It is the only skill in the pack whose failure mode is **losing work**,
so the whole of it is about what must be true first.

**The branch is the deliverable until it is merged.** A worktree directory is cheap to recreate; the branch
is what a draft PR points at, and deleting it closes the PR and takes the head commit with it.


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

## 1. Establish what would be lost

One compound command, before anything is deleted. For the target worktree and branch:

- **Is there a PR, and what state is it in?** `gh pr list --head <branch> --state all --json number,state,url`
- **Are the commits reachable from the integration branch?** `git branch --merged origin/<base>` — or
  `git log origin/<base>..<branch> --oneline`, which is the same question asked the way that shows you what
  is at stake.
- **Is the tree dirty, and is anything unpushed?** `git -C <worktree> status --short` and
  `git log <upstream>..<branch> --oneline`.

## 2. The gate

**Delete only when the work is safe somewhere else.** Any one of these is sufficient:

- the PR is **merged**, or
- every commit on the branch is reachable from the integration branch, or
- the user has been shown what would be lost and said to delete it anyway.

**Refuse, and say why, when:**

- **a PR is open** — merged is the bar, not approved and not "looks ready". Deleting the branch closes the PR
  and the review history stops pointing at anything. This is the case the skill exists to prevent.
- the branch has commits on no other ref
- the tree is dirty, or commits are unpushed

A refusal names the specific thing — the PR number, the unmerged commits, the dirty paths — and offers the
alternative: leave it, and come back when the PR merges. **Never widen the gate to get past your own refusal.**

## 3. Delete

**Prefer `ExitWorktree` with `remove`.** It restores the session's directory and cleans up in one move, and it
refuses on uncommitted or unmerged work — a second gate under yours. If it refuses and step 2 cleared the
work, re-invoke with `discard_changes: true`; if step 2 did **not** clear it, the refusal is correct and you
stop.

**It will report no active worktree session when the worktree was not created by `EnterWorktree`.** That is
the normal case for anything `wt-plan` made — it creates with plain `git worktree add` and enters by path, so
the harness never owned it. Fall back to plain git, from the main checkout:

```
git worktree list                       # confirm the path and branch
git -C <main> worktree remove <path>    # --force only after the user accepts the loss
git -C <main> branch -d <branch>        # -D only after the user accepts the loss
```

`-d` refuses an unmerged branch. That refusal is a third gate and is load-bearing — reaching for `-D` to
silence it is the failure this skill is written to prevent.

Then drop the task labels: the planner's that handed you this work (only while it is still on this ticket),
then the one wt-handoff put on your pane (display-only; best effort, a no-op outside herdr):

```
~/.claude/skills/wt-shared/scripts/task-state.sh planner --clear
[ -n "${HERDR_PANE_ID:-}" ] && herdr pane report-metadata "$HERDR_PANE_ID" --source wt-dashboard --clear-token task >/dev/null 2>&1 || true
```

## 4. Report

What was deleted, what is left, and where the session now is. If the branch survives on the remote, say so —
"the local branch is gone, `origin/<branch>` still has it" is the difference between cleanup and data loss,
and the user cannot tell which happened without being told.

## Rules

- **Merged is the bar for an open PR.** Not approved, not green, not "it only needs one more look".
- **Never `--force` or `-D` on your own initiative.** They exist for the user's decision, not yours.
- **Leave other people's worktrees alone.** `git worktree list` shows everyone's; touch only the one named.
- **One refusal is enough.** If the gate closes, report and stop. Do not re-derive a reason to proceed.
