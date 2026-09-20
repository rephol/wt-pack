---
name: wt-simplify
description: >
  Simplify freshly implemented code without changing its behaviour, so review spends its attention
  on the shape that will actually ship. Looks for what an implementation written unit by unit could
  not see — the same pattern three times, a helper that already existed, scaffolding a later unit
  made dead. Use after an implementation is complete and before reviewing it, or when asked to tidy
  up settled code. Called by wt-ship. Not for fixing bugs and not for restructuring code the change
  barely touched.
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, ToolSearch
---

# wt-simplify

Behaviour-preserving cleanup of code that is **settled** — written, verified, and about to be reviewed.

The point is not tidiness. It is that review is the expensive step, and every finding it spends on a shape
that was about to change is wasted. Simplify first so review lands on the final thing.

**Nothing to simplify is the common answer.** Say so in one line and stop. A forced simplification is worse
than none: it puts an unreviewed behaviour change into a diff that was finished.


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

## 1. What to look for

Read `references/what-to-cut.md`. It works in **three dimensions**, and they find different things — make a
pass for each rather than one pass that stops at whatever it noticed first:

- **Reuse** — this already exists somewhere (the expensive one, because the reimplementation looks correct)
- **Quality** — this is awkward to read (duplication, redundant state, conversation-bound names, dead
  scaffolding)
- **Efficiency** — this wastes work (N+1, missed concurrency, unbounded growth, hot-path bloat)

The unifying idea: an implementation is written **unit by unit**, so it cannot see across its own units. That
blind spot is the whole opportunity.

**Readable and explicit beats compact.** Fewer lines is not the goal, and net lines removed is not the
measure of a good pass.

## 2. Stay safe

Read `references/preserving-behaviour.md` before editing. Its three load-bearing rules:

- **Never simplify away a safety check** — trust-boundary validation, data-loss protection, security,
  accessibility. A check that looks redundant is usually defence in depth.
- **Protected behaviour is outputs, errors, side effects *and* ordering** — all four. If you cannot argue a
  change is a no-op, skip it.
- **A `settled:` decision constrains this step rather than scoping it.** A deliberate duplication stays
  duplicated, and you say in the report that you left it.

Stay inside the diff's blast radius: a cleanup two packages away is a different piece of work.

## Optional: check each candidate before applying it

Step 2 states the constraint — behaviour must not change. This checks it per candidate instead of asserting
it:

```bash
node ~/.claude/skills/wt-shared/scripts/wt-judge.mjs simplify candidates.json
```

Read the number, not the mark. The model is cautious on "could this change behaviour for **any** input" and
floors near 0.6 even for provably equivalent rewrites — `[...new Set(ids)]` for a dedupe loop scored 0.63.
The threshold is 0.7 for that reason, and a genuine behaviour change scores far higher: dropping a
`try/catch` around `JSON.parse` scored 0.97. Anything above the line still needs step 3 to prove it.

**Exit 3 means no key: apply step 2's judgement as before.**

Each run prints `run <id>`. **When you later find a judgment was wrong, say so** —
`node ~/.claude/skills/wt-shared/scripts/wt-judge.mjs mark <run>#<i> yes|no` — using the observed outcome,
never a second opinion from the same model. That log is the only thing that moves the thresholds.

## 3. Prove it

Typecheck, lint, and the tests matched to the blast radius. Fix what the simplification broke or revert it —
**never relax an assertion, weaken a type or skip a test to get green.** If the project has no suite, lint or
typecheck, say so explicitly rather than reporting an unverified pass as a clean one.

## 4. Commit

**Separately, on its own commit**, so review reads it as its own move and can reject it without touching the
implementation. The message says what was consolidated and what it replaced.

## 5. Report

What was already sound and what improved, by dimension — reuse, quality, efficiency — plus what you skipped
and the check outcomes. Name anything left alone because it was `settled:`; that record stops the next reader
re-proposing it.

**Do not report net lines removed as the result.** A pass that deleted nothing and confirmed the code was
sound is a good pass.
