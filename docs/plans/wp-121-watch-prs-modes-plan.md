# WP-121 — wt-watch-prs modes: dispatch (orchestrator) + single review

## Goal

wt-watch-prs gains two modes beside its standalone loop:

- **dispatch.** The orchestrator watches the repo's PRs but never reads a diff. It hands each new head to a pool
  reviewer as one wt-message.
- **review.** A reviewer reviews one PR at one SHA, posts the verdict, records it, replies to the sender and
  stops.

The standalone loop (`/wt-watch-prs [repo]`) stays unchanged for herdr-box-style reviewers. The shared
`state.json` and the claims keep any two modes from reviewing the same head twice.

## What research corrected

- **The ticket assumes a reviewer can be picked with "wt-handoff --role reviewer". It can't yet.**
  `handoff.sh:79` has `case "$role" in worker|planner) ;; *) echo "--role: worker or planner"`. Free-agent
  reuse only looks in the worker workspace: `candidates()` (`:133-138`) filters on `worker_ws`, and only planners
  get their own label and spawn cwd (`:182-185`). U2 widens this.
- **The ticket wants the message tagged "kind=dispatch pr=N sha=…". wt-message has no such attributes.**
  `wrap()` (`wt-shared/scripts/wt-message.mjs:13-19`) emits only `id`, `kind`, `from` and an optional `ticket`,
  and the CLI accepts only `--kind`/`--from`/`--ticket` (`wt-message-cli.mjs:8`).
  - Adding attributes after those is safe. Both parsers match a prefix only:
    `server.mjs:629` `/^(?:\/\S+ )*<wt-message id=\w+ kind=(\w+) from="([^"]*)"/`, and
    `wt-memory/claude-plugin/hooks/inject.mjs:31`.
- **Claims and reply-watching are per session, so the two modes have to share one.**
  - `claim N S` refuses a second session with "held by <other>" (`watch-prs.sh`, `claim|release`).
  - `poll-replies` only sees holds whose `reviewer_session == $me`.
  - If the dispatcher claims under its session D and the reviewer used its own session, the reviewer's claim
    would fail and the dispatcher would never see the reviewer's holds.
  - Settled below: a review run under dispatch **acts under D**.
- **Concurrent reviewers under one session would race on the base ref.** `diff` pins the base at a single ref,
  `BASE="refs/review/$S/base"`, so two reviews under D would force-update each other's base mid-review. U1 makes
  it per PR.

## Approach

`watch-prs.sh` gets two new subcommands, `mode` and `dispatch`. `record` gets an
optional `--by`, and the base ref becomes per PR. `handoff.sh` accepts `--role reviewer`, and wt-message carries
`pr`/`sha`. SKILL.md gains two short mode sections. The judgement for review mode is the existing §2–§4; it
reuses them without copying them.

**Settled decisions** (headless, no user available):
- *A review under dispatch acts under the dispatcher's session.* The dispatch message carries `session=D` in its
  body (`/wt-watch-prs review 12 --sha <40> --session D`). The reviewer then:
  - skips `claim`, because D already holds it;
  - records with `reviewer_session D`, so D's `poll-replies` sees the hold;
  - does not `release`, because D releases on the reply.

  Rejected: the reviewer re-claiming under its own session, which the atomic claim forbids. Rejected: a claim
  handover step, a new race window for no gain.
- *The reviewer is remembered in state.* `record … --by <agent-name>` stores `.reviewed[N].reviewer`. When a
  reply lands on a held PR, D re-dispatches to that name if it is idle, otherwise to any free reviewer.
- *Cap = new project setting `maxReviewers`* (overridable, default `2`, range 0–20), modelled on `maxWorking`
  (`project-settings.mjs` `PKEYS`). At the cap, `dispatch` releases its claim and exits 3 ("queued"). The head
  then comes back on its own through `poll-shas`, once the `fired` TTL (900s) runs out. The dispatcher re-queues
  in memory to retry sooner.
- *Held PRs go to the project room.* On a reviewer reply that says it held, D runs
  `room post <basename of main checkout> "Held PR #N: …"`. The `wt-pack` room exists, but other checkouts may
  have none, so the post is best-effort: the Inbox `pr-held` item from WP-116 still shows the hold.
- *Mode default from the role token.* `mode` reads the `role` token of the canonical pane
  (`herdr pane get "$HERDR_PANE_ID"`; the CLAUDE.md Trap says `HERDR_PANE_ID` may be the stable id and
  `pane get` resolves it). An explicit mode argument always wins.

  | Role | Mode |
  |---|---|
  | orchestrator | dispatch |
  | reviewer | standalone |
  | none or other | standalone |

## Implementation units

### U1 — `watch-prs.sh`: mode, dispatch, record --by, per-PR base (wt-watch-prs)
- `mode [arg]` prints `dispatch|review|standalone`. The first argument is either `dispatch`, `review`, or an
  owner/repo (meaning standalone). With none given, it uses the pane role token as above, read with
  `herdr pane get` and `jq -r '.result.pane.tokens.role // empty'` (the shape `handoff.sh:262` already reads).
  With no herdr or no pane, the mode is standalone.
- `dispatch N --sha <40> --session D` works in this order:
  1. `claim N D`. If it is held, it prints what `claim` prints and exits 1.
  2. It picks a target: the recorded `.reviewed[N].reviewer` if that agent is idle or done; otherwise a free
     reviewer; otherwise a spawn, if the live reviewers in `<repo>-reviewers` number fewer than `maxReviewers`.
  3. At the cap, it runs `release N D` and exits 3 with `queued: at maxReviewers (<n>)`.
  4. Otherwise it runs `handoff.sh --role reviewer --kind dispatch --pr N --sha X [--pane P] --no-goal <main>`
     with the prompt `/wt-watch-prs review N --sha X --session D`. `--no-goal` because a review is one run that
     stops. Review couldn't verify this live: wt-review's lens agents finish inside the turn or wake the session.
     If reviewers stop mid-review, switch to a goal. The reply footer only carries the sender pane when D runs in a
     herdr pane, so dispatch mode requires herdr.
  5. It prints `dispatched #N to <name>`. If the handoff fails, it releases the claim and exits 1.
  - It never calls `diff` or `gh pr diff`.
- `record … [--by NAME]` stores `.reviewer` (name validated `^[a-z0-9_-]{1,32}$`). Existing callers are
  unchanged.
- `diff`: `BASE="refs/review/$S/pr-$P-base"`.
- Tests in `watch-prs.test.mjs` use the existing stub-PATH and temp-`HOME` pattern, plus a `handoff.sh` stub via
  `WATCH_PRS_HANDOFF` (a test knob like `WATCH_PRS_SLEEP`):
  - `mode`: an explicit arg wins; role orchestrator gives dispatch; role reviewer gives standalone; no herdr
    gives standalone.
  - `dispatch`: it claims, calls the handoff with `--role reviewer --pr 12 --sha …`, and leaves the claim in
    place.
  - A second `dispatch` of the same PR exits 1 (held). A standalone `claim` under another session also loses:
    this is the cross-mode guarantee.
  - At the cap it releases the claim and exits 3. A failed handoff releases the claim.
  - Re-dispatch: with `.reviewed[12].reviewer = r1` and r1 idle in the herdr stub, the handoff gets `--pane`
    for r1. With r1 working, or r1 missing from `herdr agent list` (gone), it gets no `--pane`.
  - `record --by` stores the reviewer, and a bad name is refused.
  - `diff` under two PRs leaves two distinct base refs.
- **Verify:** `node --test skills/wt-watch-prs/scripts/*.test.mjs`.

### U2 — `handoff.sh --role reviewer` + `--pr/--sha` (wt-handoff, wt-shared)
- `handoff.sh`:
  - accepts `--role reviewer`;
  - turns the planner special case at `:182-185` into "any role except worker", which gives the workspace label
    `<repo>-<role>s` and a spawn in the main checkout. `candidates()` follows that label once it is set, so it
    needs no change of its own;
  - gates the Jev MCP pick (`:159`) off for non-workers. Review checked that the Jev route is already skipped
    when a role is given, and that the board move is already worker-only (`:266`);
  - passes `--pr N` / `--sha X` through to the wrapper.
- `wt-message.mjs` `wrap()`:
  - accepts `pr` (digits) and `sha` (`^[0-9a-f]{7,40}$`) and appends ` pr=N sha=X` after `ticket`;
  - drops anything that fails the check.
  - The CLI gets `--pr/--sha`.
- Tests:
  - Extend the existing `wt-shared/scripts/wt-message.test.mjs`: the attrs are emitted, invalid
    ones are dropped, and the `server.mjs:629` regex still matches the result.
  - A handoff `--dry-run` case: `--role reviewer` targets `<repo>-reviewers` and prints `would spawn a reviewer
    in <main>`.
- **Verify:** `node --test skills/wt-shared/scripts/*.test.mjs skills/wt-handoff/scripts/*.test.mjs`.

### U3 — `maxReviewers` setting (wt-dashboard)
- `project-settings.mjs` `PKEYS`: add
  `maxReviewers: { scope: 'overridable', label: 'Max reviewers', routine: true, default: '2', check: 0–20 }`.
- `web/src/projects-settings.tsx`: add an `ABOUT` entry.
- Test in `project-settings.test.mjs`.
- `watch-prs.sh` reads it through `project-setting.mjs get maxReviewers --cwd .`, falling back to `2`.
- **Verify:** `npm test` in `skills/wt-dashboard`; `npx tsc --noEmit -p web`; web `npm run build`; then **one**
  `npm run service:restart`, because `server.mjs:22` loads `PKEYS` at startup.

### U4 — SKILL.md + docs (wt-watch-prs, docs, CLAUDE.md)
- `SKILL.md` gets a "Modes" section at the top:
  - how `mode` is chosen;
  - **dispatch**: preflight, then arm `poll-shas` and `poll-replies --session D`. For each new head, run
    `$W dispatch`. Exit 3 means re-queue. For a reply from a reviewer, run `release`, then the room post if it
    held. For a reply on a held PR, run `dispatch` again (it re-picks the same reviewer). Never open a diff;
    the review judgement is not the dispatcher's.
  - **review**: `gate` → `describes` → `diff --sha` → wt-review → post (§3) → `record … --by <own name>`
    under D, then `handoff.sh --reply <sender pane> "#N: <verdict> (<sha7>)"`, then stop. No claim, no
    Monitors.
  - The existing §1–§5 stay as the standalone loop, and review mode points to §2–§4.
  - Update the description frontmatter to name the three modes.
- `docs/features.md`: add the modes under the wt-watch-prs entry, plus `maxReviewers` under Projects.
- `CLAUDE.md` skill map: extend the wt-watch-prs row with `dispatch | review <pr> | [repo]`.
- **Verify:** `./setup doctor` is clean for wt-watch-prs.

## Files

- `skills/wt-watch-prs/scripts/watch-prs.sh`, `skills/wt-watch-prs/scripts/watch-prs.test.mjs`,
  `skills/wt-watch-prs/SKILL.md`
- `skills/wt-handoff/scripts/handoff.sh` + its test
- `skills/wt-shared/scripts/wt-message.mjs`, `skills/wt-shared/scripts/wt-message-cli.mjs`,
  `skills/wt-shared/scripts/wt-message.test.mjs`
- `skills/wt-dashboard/project-settings.mjs`, `skills/wt-dashboard/project-settings.test.mjs`,
  `skills/wt-dashboard/web/src/projects-settings.tsx`
- `docs/features.md`, `CLAUDE.md`

## Definition of Done

The transcript shows each command's output:

1. `node --test skills/wt-watch-prs/scripts/*.test.mjs` passes, with every U1 case including cross-mode claim
   and re-dispatch.
2. `node --test skills/wt-shared/scripts/*.test.mjs skills/wt-handoff/scripts/*.test.mjs` passes.
3. `npm test` in `skills/wt-dashboard` passes, and web `tsc` is clean.
4. `handoff.sh --role reviewer --dry-run … <main>` prints a reviewers-pool target.
5. `watch-prs.sh mode` run in this pane prints the mode its role token implies.
6. SKILL.md, features.md and CLAUDE.md are updated, with one commit per skill touched, merged and pushed.

## Risks and deferred

- **Not run end to end** against a real PR with a live reviewer agent. Spawning real reviewers against a real
  repo is the user's call. Tests use stubs only and never prompt real agents (CLAUDE.md Trap).
- **A reviewer that dies mid-review leaves D's claim.** The existing rule applies: a claim older than about 2h
  with no record is removed by hand. The dispatcher never auto-expires claims.
- **Out of scope:** a dashboard server dispatch loop and a PRs view (the ticket names a follow-up).
