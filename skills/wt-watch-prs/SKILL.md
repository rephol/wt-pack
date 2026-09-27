---
name: wt-watch-prs
description: >
  Reviewer loop for a repo's open pull requests: watch every open PR, review each new head (the delta
  after the first review), and post the verdict — approve, comment, or hold with request-changes — under a
  dedicated reviewer identity, re-reviewing a held PR when its author replies. Held PRs show in the
  wt-dashboard Inbox. Use when started as a reviewer (`wt-agents spawn reviewer`), or when asked to watch,
  review or keep reviewing a repo's PRs. Three modes: standalone (`/wt-watch-prs [repo]`, this loop), dispatch
  (an orchestrator hands each new head to a pool reviewer and never reads a diff), and review (`/wt-watch-prs
  review <pr> --sha <sha> --session <D>`: one PR at one head, then stop). Not for watching your own PR to
  merge-ready — that is wt-babysit.
allowed-tools: Bash, Read, Grep, Glob, Skill, Agent, ToolSearch, Monitor, TaskList, TaskStop
---

# wt-watch-prs

A code reviewer, not a test runner: it reads pinned refs and CI's verdict, never checks out, installs or runs
suites. The mechanics live in `scripts/watch-prs.sh` (call it as `W=~/.claude/skills/wt-watch-prs/scripts/watch-prs.sh`);
this file is the judgement. Run everything from the repo's main checkout (a reviewer starts there).

## Modes (WP-121)

`$W mode [arg]` picks: `dispatch` or `review` when given, `standalone` for an `owner/repo` argument; with none,
the pane's role token decides (orchestrator → dispatch; reviewer, none or no herdr → standalone). All three share
`state.json` and the claims, so no head is reviewed twice across modes.

**Dispatch** (orchestrator). §1 preflight, then arm `$W poll-shas` and `$W poll-replies --session D` (D is your
session id, as S below). Never open a diff — the review judgement is not the dispatcher's.
- New head → `$W dispatch N --sha <40> --session D`: claims under D, then hands
  `/wt-watch-prs review N --sha X --session D` (kind=dispatch, pr=/sha= on the tag) to the reviewer that last held
  N if it is free, else a free `<repo>-reviewers` agent, else a new one while fewer than the project's
  `maxReviewers` (default 2) are live. Exit 1: held by another session (do nothing) or handoff failed (claim
  released). Exit 3 `queued`: at the cap, claim released — retry that head later (poll-shas re-fires it after
  15 min anyway).
- Reviewer's reply (`#N: <verdict> (<sha7>)`) → `$W release N D`; when it held, post
  `room post <main checkout's basename> "Held PR #N: …"` (best effort — the Inbox Held PR item shows it anyway).
- Reply on a held PR (poll-replies) → `$W dispatch N --sha <current head> --session D` again; it re-picks the
  same reviewer when free.
- NO LONGER OPEN → §5, as the loop does.

**Review** (a pool reviewer, from a dispatch message). One PR, one head, then stop — no claim (D holds it), no
Monitors, no release (D releases on your reply):
`$W describes N` → `$W gate N` → `$W diff N D --sha X` → wt-review → post (§3) → record under D with your own agent
name, `$W record N <sha40> <state> - D --by <your name>`, then
`~/.claude/skills/wt-handoff/scripts/handoff.sh --reply <sender pane> "#N: <verdict> (<sha7>)"` and stop.
The judgement is §2 (from Describes on), §3 and §4, unchanged.

**Standalone** is §1–§5 below.

## 1. Preflight, then arm

```bash
$W preflight          # exit 1 on any HARD fail → report and stop; DEGRADED lines go in the arming report
$W identity           # "<login> <source>" — the account reviews post as
```

- **Session id** `S`: 4–16 chars of `[a-z0-9-]` (e.g. the first 8 of your session id). Stable for the whole
  session and distinct from any other reviewer's — it names your claims, refs and reply filter.
- **Identity.** The project setting `reviewerGithubAccount` (dashboard Settings › Projects) wins, then
  `GH_REVIEWER_TOKEN_FILE` (default `~/.config/gh-reviewer-token`). With neither you run **degraded** under the
  default identity: comment only, never approve (GitHub refuses self-approval, and an approval from the account
  that opened the PR means nothing). Say so in every affected review.
- **Post only through `$W gh …`** (`$W gh pr review 12 --approve --body-file f`). It injects the reviewer token
  per call; never print, echo or store the token, and never pass it in argv.
- **Arm two Monitors, both `persistent: true`**, after checking `TaskList` that this session has neither yet
  (another session's pair is fine — claims resolve overlap):
  - `$W poll-shas` — description `new commits on open <repo> PRs [session S]`. Emits
    `PR #n — new commits <sha> — …` for each unreviewed head, and `PR #n — NO LONGER OPEN — MERGED|CLOSED …`.
  - `$W poll-replies --session S` — description `replies on held <repo> PRs [session S]`. Emits human replies
    and reviews on PRs *this session* holds. It refuses to start when the login is unresolved (it would wake on
    its own holds).
- Report: both task ids, the repo, the identity and its source, S, and every DEGRADED line.

The first poll fires every open unreviewed PR — a backlog. **That is a work queue, not a report.** Drain it
oldest-first (a stack base-first) without ending the turn between PRs; never end a turn on "starting #n next"
without the tool call that starts it. A PR whose gate is pending goes to the back of the queue.

## 2. Per event: claim → gate → read → review → post → record → release

```bash
$W claim 12 "$S"                    # exit 1 "held by <other>" → do nothing at all on this PR
$W describes 12                     # no-body | branch-title → hold (below), asking for a description
$W gate 12                          # green | red | pending | none
$W diff 12 "$S" --sha <reported sha> > "$TMPDIR/pr12.diff"
```

- **Claim first**, before any reading, so a losing session spends nothing. Release on every exit path,
  including abandonment: `$W release 12 "$S"`. A claim older than ~2h with no record is a dead session —
  say so and remove `~/.local/share/wt-watch-prs/<owner>-<repo>/claims/pr12` by hand; never auto-expire.
- **Describes.** An empty body or a raw branch-name title is a hold in its own right (bots exempt): the
  decisions in a PR body cannot be rebuilt from the diff.
- **Gate.** `pending`/`none` → wait or re-queue; `none` is not green. `red` → fetch the failing log
  (`gh run view <id> --log-failed`); caused by the PR → it is the headline finding; unrelated → say why, with
  evidence, and hold anyway unless the author acknowledged it. Checks the repo marks as informational
  (name contains "informational") are ignored; other non-gating checks belong in the project's CLAUDE.md.
- **Diff.** `diff` pins `refs/pull/N/head` and the base (project `baseBranch`, else `origin/HEAD`, else
  `main`) under `refs/review/S/`, aborts if the ref is not the reported head, and prints either
  `# DELTA <old>..<new>` (your recorded head is an ancestor) or `# FULL …` (first sight, or a force-push/rebase
  — a full review is then correct, not lazy). Read files with `git show refs/review/S/pr-12-head:"path"`
  (quote ref and path separately in zsh). Never `git checkout`, `switch`, `reset` or `stash` here, and never
  cite `gh pr diff` (it is live, not pinned).
- **Review** with the `wt-review` skill in diff mode on that diff file — first sight gets the full lens set; a
  delta gets the delta only, with the earlier findings carried forward as context. Verify each finding against
  the code before relaying it. On a delta, walk your earlier findings: fixed / partly / untouched, and name the
  test that would catch each fix regressing.
- **Re-run `$W gate` immediately before posting.** Approve only on `green`.

## 3. The verdict

| Situation | Post |
|---|---|
| Failing required check, P0/P1, must-fix P2 | `--request-changes` |
| A question only the author can answer that changes what should merge | `--request-changes` as a **hold** — say it is for clarification, not a defect, and that you will approve on the answer |
| No body / branch-name title | `--request-changes`, the only blocker; say what you verified anyway |
| Nothing outstanding, gate green, distinct identity | `--approve` (observations ride along; they need no reply) |
| Same identity as the author, degraded, or gate not green | `gh pr comment` saying what the verdict would be and what it waits on |

**Never approve with a question.** An approval means nothing outstanding; asking belongs in a hold, telling
rides in an approval. A later blocker on a PR you approved → amend to `--request-changes`, saying it supersedes.
Tag every body's first line with `reviewed by session S` — one identity, several sessions.

## 4. Record, only what actually posted

```bash
$W gh pr review 12 --request-changes --body-file "$TMPDIR/r12.md" \
  && $W record 12 <full 40-char head sha> changes-requested - "$S" < "$TMPDIR/note12.txt"
$W release 12 "$S"
```

- States: `approved`, `changes-requested`, `commented`, `merged`, `closed`, `open` (a deliberate mute).
- Take the SHA from `gh pr view 12 --json headRefOid -q .headRefOid`; `record` refuses a short one (a short
  SHA re-fires forever). Pass the note on stdin (`-`) — it will contain backticks and `$`.
- The note says what CI said (job, conclusion, SHA) and, on a delta, what was carried from which SHA.
- `changes-requested` puts the PR in the dashboard Inbox as **Held PR** and in your reply watcher; recording
  any other state clears both.

## 5. Other events

- **Reply on a held PR** — verify the answer against the code (an answer is a claim), then approve superseding
  the hold, or hold again naming only what is still open, and `record`.
- **NO LONGER OPEN** — `record` it `merged`/`closed` and delete `refs/review/S/pr-N-head`
  and `refs/review/S/pr-N-base` (`git update-ref -d`). **Merged while you held a blocker → say so loudly, immediately.**
- **Negative results need a live probe**: a grep that finds nothing proves nothing until the pattern matches
  something you know is there; a ref must equal the reported head before you trust a file read from it.

## Limits

Session-scoped: the Monitors die with this session (the state survives). Inline diff-line comments
(`pulls/N/comments`) are not watched — post holds as review bodies so answers land in the conversation.
State: `~/.local/share/wt-watch-prs/<owner>-<repo>/` (`state.json`, `claims/`, `state.lock`).
