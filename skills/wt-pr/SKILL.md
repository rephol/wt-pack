---
name: wt-pr
description: >
  Push the current branch and open a DRAFT pull request whose body carries what a reviewer needs —
  what the change does, what research corrected about the ticket, what review corrected about the
  implementation. Refuses a dirty tree, a detached HEAD and the base branch itself, and never
  promotes a PR out of draft. Use when implemented and verified work is ready to be published for
  review. Called by wt-ship. Not for updating an existing PR's body or resolving its feedback.
allowed-tools: Bash, Read, Write, Glob, Grep, ToolSearch
---

# wt-pr

The only step in the pack that **publishes**. Everything before it is local and reversible; this is not.

**It opens a draft, always.** Promoting a PR is a judgement about whether the work is ready for someone's
attention — the plan's Definition of Done supports that judgement, it does not make it. `scripts/pr.sh` has
no flag to open a non-draft, deliberately.


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

## 1. Check before you publish

The script refuses a dirty tree, a detached `HEAD` and a PR from the base branch onto itself. Those are its
guards, not yours — yours are the ones it cannot see:

- **Does a PR already exist for this branch?** `gh pr list --head <branch>`. If one does, this is an update,
  which is not this skill.
- **Is the base right?** The script resolves `origin/HEAD`, then `preview`/`develop`/`staging`/`main`/
  `master`. Where the repository integrates somewhere other than its default branch, pass the base
  explicitly rather than letting it guess.
- **Is anything in the tree that should not be published?** A scratch file, a debug log, a credential in a
  fixture. Read the file list once.

## 2. Write the body

Read `references/pr-body.md`. The short version: a reviewer should be able to start reviewing without
opening the plan, and should learn the two things only this run knows — **what research corrected about the
ticket** and **what review corrected about the implementation**.

Follow the repository's PR conventions and its attribution rules. Write the body to a file; the script takes
a path, not a string, so a body with backticks and newlines survives intact.

## 3. Open it

```
scripts/pr.sh <title> <body-file> [base]
```

It pushes `-u` and opens the draft. On failure it exits non-zero with the reason on stderr — **read the
reason rather than retrying.** A refusal here is nearly always correct: a dirty tree means work that is not
in the PR and that nobody will review.

## 4. Report

The PR number and URL, that it is a **draft**, and anything you left out of the body deliberately. If the
push succeeded and the PR creation did not, say so explicitly — the branch is on the remote either way, and
a silent half-success is how a second PR gets opened later.

## Rules

- **Draft, always.** Never `--ready`, never promote, whatever the state of the checks — at open time they
  have not run. Promotion is `wt-babysit`'s, once they are green.
- **Never force-push** to recover from a failure here.
- **The body is for the reviewer, not the author.** No narration of how the work went.
- **Do not open a PR for someone else's branch**, and do not reopen a closed one.
