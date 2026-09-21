---
name: wt-plan
description: >
  Take a ticket from named to planned, reviewed and committed, in an isolated git worktree,
  then hand it off. Resolves the ticket and the integration branch, creates the worktree,
  runs sharded research through wt-research, asks only shape-changing questions, writes the
  plan inline with the research absorbed into it as quoted evidence, self-traces, sizes a
  review through wt-review, applies the findings, commits the plan, and emits a handoff
  prompt for wt-work. Use when the user says "worktree and plan", "start <TICKET>", "plan
  <TICKET> in a worktree", or otherwise asks to begin a ticket in isolation and plan it
  before writing code. Also use when a plan is wanted for work that must not touch the
  current checkout.
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Skill, Agent, AskUserQuestion, ToolSearch, EnterWorktree, ExitWorktree
---

# wt-plan

Orchestrator for the `wt-*` pack. Produces a worktree and a reviewed plan. **It never writes implementation
code** — that is `wt-work`, reached through the handoff.

Read `references/findings-schema.md` before step 3. It is the contract every other step depends on.


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

## Spine

1. Resolve the ticket and the base branch
2. Create or enter the worktree
3. Research — `wt-research`
4. Ask only shape-changing questions
5. Write the plan **inline**, absorbing the findings as quoted evidence
6. Self-trace — free, do not skip
7. Review — `wt-review` — then apply
8. Commit the plan **alone**
9. Exit the worktree (`keep`), then hand off

---

## 1. Ticket and base branch

**Named ticket** (`UMK-759`, a tracker URL): fetch it with whatever tracker tooling is connected — a Linear /
Jira / GitHub MCP tool, `gh issue view`, the API. Read the **whole** description including quoted corrections;
an active ticket often carries re-prioritisation notes that change what the work is. No tracker tool available
→ ask for a paste. Never invent a ticket's contents.

**Described work**: that description is the input. Do not invent a ticket id.

**Base branch.** Branch from the repository's integration branch, never local `HEAD` — a worktree cut from
unrelated in-flight work plans against a tree nobody else has. Resolve it from the repo
(`git symbolic-ref refs/remotes/origin/HEAD`, or the project's instructions file; many repos integrate to
`develop`/`preview`/`staging`). `git fetch` first. State which base you chose, in one line.

## 2. Worktree

`scripts/worktree.sh` resolves the base and creates the worktree with plain `git worktree add`, following the
repo's existing convention. **Creation stays plain git** — `EnterWorktree` branches from the repository's
default branch, which is the wrong base wherever the integration branch is not `main`.

Enter it with `EnterWorktree` by `path`. The harness did not create it, so it owns it only loosely: `keep`
works, `remove` is refused, and if the entry never registered, leaving is a no-op and the directory is just a
directory. That is fine — `wt-finish` deletes it with plain git for the same reason.

Branch names are meaningful (`oreviyanto/umk-759-classifier-metering`), never auto-generated. Match the
convention `git worktree list` already shows rather than inventing one.

**Gitignored env files are copied across.** `git worktree add` materialises tracked files only, so a new
worktree arrives with every `.env.example` and no `.env.local` — it looks configured and is not. The script
copies each gitignored `.env*` from the main checkout and prints `env: <path>` per file, skipping templates,
build directories and other worktrees nested under the checkout. It copies rather than symlinks because a
repo guarding secret reads blocks `ln -s <secret>` as an attempted read while allowing the copy.

Two consequences worth knowing: the secret now exists in two places, and an edit in the worktree does not
reach the main checkout. If the run needs a value the main checkout does not have, add it in the worktree
and say so at handoff.

**Do not `cd` back to the main checkout.** Everything after this happens in the worktree.

## 3. Research

Invoke `wt-research` with the ticket and the worktree path. It sizes its own shards and returns a findings
table in the schema, written to the session scratchpad. **It is working material — it does not go in the
repository.** The plan is the artifact; the findings are absorbed into it in step 5.

**Two questions reach it, always**: *is the ticket true?*, and *what does this change touch that nobody has
named?* The second is not optional and not mergeable into the first — a verification-only brief can only find
what someone already thought to write down. `wt-research` enforces this; do not talk it out of the open shard
to save a dispatch.

If research contradicts the ticket, carry the corrected version forward **and record the contradiction in the
plan**, so the next reader does not re-derive the wrong answer.

## 4. Shape-changing questions only

Use the platform's blocking question tool. Ask when different answers produce materially different plans — an
architecture fork, a scope boundary, a tradeoff the user owns. Do **not** ask what the code can answer, and do
not ask permission to proceed. Two or three is the ceiling. Recommend one, say why, give each option its real
cost. If research has already made an option unworkable, do not offer it.

**No synchronous user** (pipeline, headless, goal-driven): do not block. State the assumption you are
proceeding under and record it as a settled decision.

Record what the user chooses. Their answers are **settled decisions** — `wt-review` must frame any challenge
to one as infeasibility, never preference.

## 5. Write the plan inline

**You write it. Do not dispatch a planning agent.** You hold the findings; a subagent would have to be told
them, and what it re-infers from a retelling is the error review pays to find later.

Compose per `references/plan-format.md`. The rules that matter here:

- **Absorb the findings; do not cite them.** Where a load-bearing assertion rests on a finding, state the
  evidence **inline** — `src/policy.ts:21` plus the words that decide it. The findings table is in the
  scratchpad and the implementer will not have it, so `(F-07)` would read as evidenced while being
  unverifiable. If it were false the plan would change → it is load-bearing.
- **Revise the plan against what research disproved.** A `disproved` record usually kills something the plan
  inherited from the ticket. That revision is the whole point of researching first, and it belongs in the
  plan's own text.
- **Anything with no evidence behind it is marked `[unsourced]` inline**, where it sits. Ticket text is not
  evidence.
- **Author the plan in one `Write`.** Compose it fully, then write it once. A plan built up through a dozen
  `Edit` calls is the largest avoidable cost measured in this skill.
- **Re-derive every number.** A figure copied from the ticket has been verified by nobody, and a gate written
  as a count passes while the thing it counts is wrong.

## 6. Self-trace

Costs nothing — no tool calls, no agent. Measured as the cheapest correction in the run, and it catches the
class that no findings table can.

Read back every decision and ask **what it makes true elsewhere.** Not "is it right" — "what else changes".
The failures are self-inflicted and always the same shapes:

- a decision removes the last member of a set, and something downstream requires it non-empty
- a heading asserts one outcome while the body beneath argues the opposite
- a count stated in one section is partitioned differently in another, and the two no longer sum
- a file list names a file the decision no longer touches, or omits one it now does
- **the plan targets a file that does not exist, or the wrong one of two with the same name** — a config
  override at the wrong level is the canonical case: it looks configured and is decorative

### State the four dimensions before moving on

**Part of the self-trace, not an extra.** Before step 7, say plainly where the plan stands on each — one
line each, in the session, not in the plan:

- **evidence** — do the load-bearing claims quote the tree, or did any go in from memory?
- **definition of done** — could an evaluator reading only a transcript of the work tell whether it landed?
- **scope** — does the plan commit to anything the ticket did not ask for?
- **unit decomposition** — does each unit stand alone, in the order given?

Answer them by reading, or have them scored. The plan is the one artifact in this loop no skill owns scoring — `wt-review` reads it for defects in what it
says, not for its shape as a plan. These four dimensions are the ones this pack measurably keeps failing on,
and they were written from plans produced by this very step.

```bash
node ~/.claude/skills/wt-shared/scripts/wt-eval.mjs <plan> --type plan
```

It reports; it decides nothing, and the scores never appear in the plan — the four answers above are owed
either way. Read a low dimension as "re-read
this part of what I just wrote": weak `evidence` means claims went in from memory, a weak `definition_of_done`
means an evaluator reading only a transcript could not tell whether the work landed, weak `unit_decomposition`
means the stated order breaks partway through. **Confidence near zero means the question did not apply** —
ignore that row rather than editing the plan to satisfy it.

**Exit 3 means no key: answer the four by reading.** The contract is unchanged; the tool is the fast path
to it, never the reason for it. Never block on it, never ask for a key.

## 7. Review, then apply

Invoke `wt-review` with the plan path, the scratchpad findings table (still live this session), and the
`[unsourced]` list. It computes its own
lens set from the plan's risk surface and bundles them — do not hand it a lens list unless you have a reason
the rules cannot see.

**Then apply the findings.** A review that produces a report and no edit is wasted. Verify the load-bearing
ones yourself first — reviewers are wrong sometimes, and a confident wrong finding applied blind is worse
than no review.

**Report corrections plainly.** When a reviewer catches something the plan asserted wrongly, fix it *and* say
what was wrong. That record is the point.

Tie-break: **a review finding wins on facts about the code; the plan wins on settled decisions.**

## 8. Commit

Commit **the plan alone**, on the worktree branch. The findings stay in the scratchpad: their content is
already in the plan, and a second document in the repo duplicates that evidence and then rots beside it.

The message carries what a reviewer needs: what the plan does, what research corrected about the ticket, what
review corrected about the plan. Follow the repo's commit conventions; many lint the subject line.

## 9. Exit the worktree (`keep`), then hand off

**Get back to the main checkout first.** `ExitWorktree` with `keep` — never `remove`, the plan is committed
there and the branch is the work. It may report no active session, because step 2 created the worktree with
plain git; then just `cd` to the main checkout. Either way, **verify where you are** rather than assuming the
call moved you.

Do this *before* the handoff, not after: the implementer is about to own that worktree and two sessions on
one checkout is how a stash gets popped out from under someone, and a worker is picked from the repo's main
checkout, so a planner still parked inside a worktree cannot hand off to one.

**Then read `references/handoff.md` before emitting anything.** The prompt is three lines, carries no
explanation, and names no findings path — the findings were absorbed into the plan in step 5.

Three things in that reference are easy to skip and all three have already gone wrong:

- **Copy the three-line prompt verbatim; do not compose one like it.** A composed draft named an acceptance
  criterion and dropped `wt-ship`, and had to be corrected in the next message.
- **When `herdr` is on PATH, always offer** to send it to a worker rather than making the user paste it —
  and wait for a yes.
- **The prompt goes out as a one-line `/goal`**, which re-prompts the worker after every turn until the
  condition holds. It is one line because herdr types it into the pane and a newline is Enter, so let the
  script flatten it. It can still end early — impossible verdict, or no tool use for several turns — so say
  it may need a nudge rather than promising an unattended run.

---

## Rules

- **Never write implementation code.** Worktree and plan only.
- **Verify before asserting.** Anything stated as fact should be something read, not remembered. Where
  certainty is unavailable, say so rather than rounding up.
- **Do not claim verification that cannot be performed.** If the change is dormant on the default config, or
  preview cannot exercise it, the plan says that plainly.
- **A finding not applied is a finding wasted.** Apply, or record the decision not to.
- **Prefer correcting the plan over defending it.** It is a draft until review is done with it.
- **Leave other people's work alone.** Do not touch branches, worktrees or tickets In Progress, In Review, or
  owned by someone else.
- **Respect standing constraints** — logging rules, prohibited tools, stash discipline, commit trailers. They
  outrank this skill's defaults.

## When not to use this

- A one-line fix with no decisions in it — just do it.
- The user asked to implement, not plan — `wt-work`.
- A plan exists and needs deepening — edit it directly, and re-run `wt-review` on it.
