---
name: wt-watch-prs
description: >
  Reviewer loop for a repo's open pull requests: watch every open PR, review each new head (the delta
  after the first review), and post the verdict — approve, comment, or hold with request-changes — under a
  dedicated reviewer identity, re-reviewing a held PR when its author replies. Held PRs show in the
  wt-dashboard Inbox. Use when started as a reviewer (`wt-agents spawn reviewer`), or when asked to watch,
  review or keep reviewing a repo's PRs. Three modes: standalone (`/wt-watch-prs [repo]`, this loop), dispatch
  (an orchestrator hands each new head to a pool reviewer and never reads a diff), and review ("Use wt-watch-prs to
  review <pr> --sha <sha> --session <D>": one PR at one head, then stop). Not for watching your own PR to
  merge-ready — that is wt-babysit.
allowed-tools: Bash, Read, Grep, Glob, Skill, Agent, ToolSearch, Monitor, TaskList, TaskStop
---

# wt-watch-prs

Paths to scripts and files are relative to this skill's base directory (announced when it loads), so they
work both from the `./setup` links and from a plugin install (WP-122).

A code reviewer, not a test runner: it reads pinned refs and CI's verdict, never checks out, installs or runs
suites. The mechanics live in `scripts/watch-prs.sh` (call it as `W=<this skill's base directory>/scripts/watch-prs.sh`);
this file is the judgement. Run everything from the repo's main checkout (a reviewer starts there).

## Modes (WP-121)

`$W mode [arg]` picks: `dispatch` or `review` when given, `standalone` for an `owner/repo` argument; with none,
the pane's role token decides (orchestrator → dispatch; reviewer, none or no herdr → standalone). All three share
`state.json` and the claims, so no head is reviewed twice across modes.

**Dispatch** (orchestrator). §1 preflight, then arm `$W poll-shas` and `$W poll-replies --session D` (D is your
session id, as S below). Never open a diff — the review judgement is not the dispatcher's.
- New head → `$W dispatch N --sha <40> --session D`: claims under D, then hands
  "Use wt-watch-prs to review N --sha X --session D" (kind=dispatch, pr=/sha= on the tag) to the reviewer that last held
  N if it is free, else a free `<repo>-reviewers` agent, else a new one while fewer than the project's
  `maxReviewers` (default 2) are live. Exit 1: held by another session (do nothing) or handoff failed (claim
  released). Held by D itself means an earlier reviewer never replied: `dispatch` hands it again under the same
  claim. Exit 3 `queued`: at the cap, claim released — retry that head later (poll-shas re-fires it after
  15 min anyway).
- Reviewer's reply (`#N: <verdict> (<sha7>)`) → `$W release N D`; when it held, post
  `room post <main checkout's basename> "Held PR #N: …"` (best effort — the Inbox Held PR item shows it anyway).
- Reply on a held PR (poll-replies) → `$W dispatch N --sha <current head> --session D` again; it re-picks the
  same reviewer when free.
- NO LONGER OPEN → §5, as the loop does.

**Review** (a pool reviewer, from a dispatch message). The arguments arrive inside a
`<wt-message kind=dispatch … pr=N sha=X>` tag: read `review N --sha X --session D` from its text ("Use wt-watch-prs to review …", or the older
`/wt-watch-prs review …` form) (that is the
mode — do not run `$W mode` on it), and the sender pane from its "Handed off by … (pane P)" footer. One PR, one
head, then stop — no claim (D holds it), no Monitors, no release (D releases on your reply):
`$W describes N` → `$W gate N` → `$W diff N D --sha X` → wt-review → post (§3) → record under D with your own agent
name, `$W record N <sha40> <state> - D --by <your name> < "$TMPDIR/noteN.txt"` (§4: the note on stdin), then
`../wt-handoff/scripts/handoff.sh --reply <sender pane> "#N: <verdict> (<sha7>)"` and stop.
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
  `GH_REVIEWER_TOKEN_FILE` (default `~/.config/gh-reviewer-token`). A machine whose default gh login IS the
  reviewer account (a remote box with no dashboard) declares it instead: `WT_REVIEWER_LOGIN=<login>` (start.sh or
  the pane env) or one line in `~/.config/gh-reviewer-login`. When the default login matches, preflight reports
  `default identity (declared reviewer <login>)` and you are not degraded; a mismatch stays degraded (WP-126).
  With none of these you run **degraded** under the
  default identity: comment only, never approve (GitHub refuses self-approval, and an approval from the account
  that opened the PR means nothing). Say so in every affected review.
- **Post only through `$W gh …`** (`$W gh pr review 12 --approve --body-file f`). It injects the reviewer token
  per call; never print, echo or store the token, and never pass it in argv.
- **Arm two Monitors, both `timeout_ms: 1800000`** (30 minutes — the maximum; `Monitor` has no `persistent`
  option, every monitor expires and must be re-armed, see below), after checking `TaskList` that this session
  has neither yet (another session's pair is fine — claims resolve overlap):
  - `$W poll-shas` — description `new commits on open <repo> PRs [session S]`. Emits
    `PR #n — new commits <sha> — …` for each unreviewed head, and `PR #n — NO LONGER OPEN — MERGED|CLOSED …`.
  - `$W poll-replies --session S` — description `replies on held <repo> PRs [session S]`. Emits human replies
    and reviews on PRs *this session* holds. It refuses to start when the login is unresolved (it would wake on
    its own holds).
- **A Monitor that fails to arm is silent, not absent** — the tool can come back with no task id and no error
  the reader would notice (the harness's own auto-mode classifier gave no verdict). Treat that exactly like an
  error, per Monitor: retry arming *that one* up to twice more (an immediate re-issue, then again next turn)
  before giving up on it specifically. Never report §1 done, or start draining the backlog, while either
  Monitor's task id is still unconfirmed.
- **Re-arm on expiry the same way** — a monitor's own expiry notice is not a stop condition, it is another arm
  call with the same `timeout_ms: 1800000` and the same silent-failure exposure as the first arm: confirm the
  new task id before trusting the watch is still live, and an unconfirmed re-arm gets the same
  retry-twice-then-give-up-on-that-one treatment, not a shrug and a continue believing nothing changed.
  `poll-shas` and `poll-replies` keep their own progress in `state.json` under
  `~/.local/share/wt-watch-prs/<owner>-<repo>/` (durable across process restarts — `seen()` reads
  `.reviewed[n].sha` from it), so a re-armed process picks up where the expired one left off; nothing already
  reviewed re-fires, and `poll-replies`' in-process reply cursor only resets to a slightly wider, overlapping
  window on restart — at most a redundant notice, never a missed one. `poll-shas`' vanished-PR comparison seeds
  its baseline from `state.json` too (WP-188): every PR this repo has reviewed and not yet recorded
  merged/closed counts as "was open" from the first poll of a fresh process, so a PR that merges or closes in
  the gap between the old process dying and the new one's first poll is still caught, not silently dropped —
  routine now that a 30-minute re-arm cycle makes that gap a normal event rather than a rare crash-restart.
- **One Monitor exhausted, the other armed → keep going, degraded.** Report the failed one as DEGRADED
  (alongside the identity DEGRADED lines) rather than tearing down a Monitor that is working — losing
  `poll-replies` still leaves new-head detection running, which is most of the loop's value. Keep retrying the
  failed one occasionally between events instead of dropping it for good.
- **Both Monitors exhausted → this repo is unwatched.** Whether from the initial arm or a failed re-arm on
  expiry, say so where it will be noticed, not just in your own reply: `room post <main checkout's basename>
  "wt-watch-prs: could not arm monitoring for <repo> after 3 attempts each — this repo is unwatched until
  re-started"`, and reply through whatever channel started you (a wt-message dispatch/handoff footer), if any —
  nothing else will tell that sender the loop never started (or stopped watching). Then stop the session —
  continuing with zero Monitors armed is silent coverage loss dressed up as a running loop, the exact failure
  this exists to prevent.
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
- **Read the verdict's coverage line** (`Coverage: N/M files read in full · lenses: <fired lenses> · tests:
  …`, WP-175). `N < M` is partial coverage — carry it into §3 and §4 below.
- **Re-run `$W gate` immediately before posting.** Approve only on `green`.

## 3. The verdict

`wt-review`'s own verdict word (its first line: **Approve**, **Approve with fixes**, or **Send back**) maps
onto what gets posted: Approve → `--approve`, Approve with fixes → `gh pr comment`, a **defect** Send back
(a confirmed high finding or intent mismatch) → `--request-changes` as a **hold**. A **coverage-only** Send
back (nothing confirmed, but the coverage line shows `N < M`) is its own row below, posted as `gh pr comment`
— an unread file is neither a defect nor a question, so it is not a hold either. The situations below are
that mapping worked out against this skill's own gate/coverage/identity rules, which can still override it —
a defect Send back from `wt-review` with a failing required check is still `--request-changes`, not softened
by anything else.

| Situation | Post |
|---|---|
| `wt-review` verdict: Send back on a confirmed defect — failing required check, P0/P1, must-fix P2, intent mismatch | `--request-changes` |
| A question only the author can answer that changes what should merge | `--request-changes` as a **hold** — say it is for clarification, not a defect, and that you will approve on the answer |
| No body / branch-name title | `--request-changes`, the only blocker; say what you verified anyway |
| `wt-review` verdict: Send back on coverage alone (coverage line's `N < M`, no confirmed defect) — cannot issue Approve here | `gh pr comment` naming exactly what's uncovered — never an approval, never a hold (below) |
| `wt-review` verdict: Approve with fixes | `gh pr comment` naming the confirmed medium/low findings and what applying them would take |
| `wt-review` verdict: Approve, gate green, full coverage, distinct identity | `--approve` (observations ride along; they need no reply) |
| Same identity as the author, degraded, or gate not green | `gh pr comment` saying what the verdict would be and what it waits on |

**Never approve with a question.** An approval means nothing outstanding; asking belongs in a hold, telling
rides in an approval. A later blocker on a PR you approved → amend to `--request-changes`, saying it supersedes.
Tag every body's first line with `reviewed by session S` — one identity, several sessions.

**Never approve on partial coverage.** `wt-review`'s coverage line is the gate: a file left `skimmed`/
`skipped`, an effort-floor miss it could not clear by re-dispatching, or a triggered lens that never ran means
the diff was not actually read, whatever the findings so far say. Post `gh pr comment` naming exactly what's
uncovered (from the coverage line) instead of `--approve` or `--request-changes` — it is neither a defect nor
a question, so it is not a hold either. Re-review the same head once more before merge is plausible; if the
author merges anyway, §5 below picks it up.

## 4. Record, only what actually posted

```bash
$W gh pr review 12 --request-changes --body-file "$TMPDIR/r12.md" \
  && $W record 12 <full 40-char head sha> changes-requested - "$S" --coverage full < "$TMPDIR/note12.txt"
$W release 12 "$S"
```

- States: `approved`, `changes-requested`, `commented`, `merged`, `closed`, `open` (a deliberate mute).
- Take the SHA from `gh pr view 12 --json headRefOid -q .headRefOid`; `record` refuses a short one (a short
  SHA re-fires forever). Pass the note on stdin (`-`) — it will contain backticks and `$`.
- The note says what CI said (job, conclusion, SHA) and, on a delta, what was carried from which SHA.
- `changes-requested` puts the PR in the dashboard Inbox as **Held PR** and in your reply watcher; recording
  any other state clears both.
- **`--coverage full|partial`** (WP-176), from the review's coverage line (`N == M` vs `N < M`). Always pass
  it — §5 reads it on merge to decide whether the merged diff needs a full re-review.

## 5. Other events

- **Reply on a held PR** — verify the answer against the code (an answer is a claim), then approve superseding
  the hold, or hold again naming only what is still open, and `record`.
- **NO LONGER OPEN** — before recording, check `reviewed[N].coverage` in `state.json`. **Merged with
  `partial`** (WP-176): it shipped on a review that never actually covered it, so treat the merge itself as a
  fresh review target — diff the merged commit against its parent (`git show --format= <merge sha>`, or `$W
  diff`'s base/head refs before they're deleted) and run it through `wt-review` in diff mode as a full review
  (a merged commit has no "delta from last round" to size against). File a ticket per finding (`wt-ticket new`
  on this board, or the repo's own tracker via the orchestrator if it has one) tagged with the PR number, and
  say so loudly wherever a held-blocker merge would be said (room post / reply to whoever dispatched you) — a
  partial-coverage merge is exactly as serious as a merge past a held blocker. A merge recorded `full` needs
  none of this. Either way, `record` it `merged`/`closed` and delete `refs/review/S/pr-N-head` and
  `refs/review/S/pr-N-base` (`git update-ref -d`). **Merged while you held a blocker → say so loudly, immediately.**
- **Negative results need a live probe**: a grep that finds nothing proves nothing until the pattern matches
  something you know is there; a ref must equal the reported head before you trust a file read from it.

## Limits

Session-scoped: the Monitors die with this session (the state survives). Inline diff-line comments
(`pulls/N/comments`) are not watched — post holds as review bodies so answers land in the conversation.
State: `~/.local/share/wt-watch-prs/<owner>-<repo>/` (`state.json`, `claims/`, `state.lock`).
