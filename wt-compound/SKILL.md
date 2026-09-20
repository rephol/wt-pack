---
name: wt-compound
description: >
  Record what a piece of finished work taught, as a durable repo learning — but only when the
  reasoning is absent from the code, the tests, the plan and the existing docs, and only after its
  claims are verified against the tree. Draws on what research disproved and what review corrected
  rather than re-investigating, then checks findability and vocabulary so the next agent actually
  retrieves it. Use after work is verified and about to ship, or when asked to write up a learning
  or convention. Called by wt-ship. Not for routine fixes whose own diff explains them.
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, AskUserQuestion, ToolSearch
---

# wt-compound

Turns a finished piece of work into a learning the next person gets for free. **This is the step the whole
pack exists to feed** — everything before it produces one change; this is the only part that makes the next
change cheaper.

Which is also why it is the step where a mistake is most expensive. What lands here is read later as
established fact and acted on without re-checking, so a wrong entry compounds exactly as fast as a right one.
**Most runs correctly record nothing**, and recording nothing is a success state.

**You are not investigating.** The material is already in hand from the plan and the review; re-deriving it
is the waste this step avoids.


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

## 1. Does anything qualify?

Read `references/what-earns-an-entry.md`. The bar is a counterfactual: **if this document disappeared, would
an engineer reading the final implementation repeat the mistake or redo the investigation?** No → stop and
say so. Effort and diff size do not qualify anything.

**One learning per run.** Several worth recording means several runs, never one batched document.

If prior work here has become materially wrong, that qualifies on its own — **update it rather than writing
a second document beside it.**

## 2. Write it

Per that reference's shape rules. The two that decide whether it is ever useful: **name the failure in the
domain's words, not the incident's**, and **say where the enforcement is** — naming the test, or saying
plainly that nothing enforces it.

Match the repository's convention for location, frontmatter and naming by reading a recent neighbour. If
there is no convention, do not invent a location: say what you would have recorded and let the user decide.

## 3. Ground it — do not skip this

Read `references/grounding.md` and check the claims against the tree **before** the document lands.

Code-behaviour claims verify against the local working tree with a quoted `file:line`. Merge-state claims
("landed", "fixed in #N") verify against remote truth, because the checkout may predate the merge. Counts
get counted. A commit SHA gets replaced with a PR number — this repository squash-merges, so a SHA that
resolves today often resolves to nothing next week.

**Never record a guess as a finding.** Unverifiable is a real answer: soften it, attribute it, or cut it.

## 4. Make it findable

Read `references/discoverability.md`. Three checks: would anyone searching find this; does a term the area
depends on need defining; did this just make an older document wrong. Ask before editing a root instruction
file — it is the user's.

## Optional: ask something other than yourself

Steps 1 and 4 both ask the author to judge their own work — whether the reasoning is already recoverable, and
whether the wording is findable. An outside judgment is cheap:

```bash
node ~/.claude/skills/wt-shared/scripts/wt-judge.mjs learning LEARNING.md --against <diff> --against <plan>
```

`redundant` high means the artifacts already carry the reasoning — do not write it. `findable` low means
reword around the trigger situation, in the words someone hitting it would search for.

**Exit 3 means no key: judge it yourself against steps 1 and 4.**

Each run prints `run <id>`. **When you later find a judgment was wrong, say so** —
`node ~/.claude/skills/wt-shared/scripts/wt-judge.mjs mark <run>#<i> yes|no` — using the observed outcome,
never a second opinion from the same model. That log is the only thing that moves the thresholds.

## 5. Commit and report

Its own commit, including whatever index the repo's convention requires. Then one line: what was recorded
and why it was not already obvious from the diff — or that nothing was, and why.

## Rules

- **Durable, not incidental.** The shape generalises; the instance does not.
- **Absent from every artifact, or it does not go in.** A fix whose diff explains itself needs no entry.
- **Verified, or stated as unverified.** Never both ways.
- **No session narrative.** "We first tried X" describes the conversation, not the tree.
- **Short enough to be read.** An entry nobody finishes protects nothing.
