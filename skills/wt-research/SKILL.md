---
name: wt-research
description: >
  Gather evidence about a ticket or a change against the real code, sharded by question type
  and returned as structured findings rather than a prose report. Verifies what the ticket
  claims AND sweeps for what nobody named, reads installed dependency behaviour from the
  package rather than from docs or memory, and returns records with verdicts, quoted evidence
  and confidence. Use when starting a ticket, before writing a plan, when a ticket's claims
  need checking against the current code, or when asked "what does this change actually
  touch". Called by wt-plan; also useful invoked alone on a ticket or an existing plan.
allowed-tools: Bash, Read, Glob, Grep, Agent, ToolSearch
---

# wt-research

Paths to scripts and files are relative to this skill's base directory (announced when it loads), so they
work both from the `./setup` links and from a plugin install (WP-122).

Returns a **findings table**, never a report. Read
`../wt-plan/references/findings-schema.md` before dispatching — it is the output contract, and
a shard that returns prose has not done the job.

## The two questions

Every run carries both. They are not mergeable.

1. **Is the ticket true?** Each named claim confirmed or disproved against the code.
2. **What does this change touch that nobody has named?** Open-ended.

Question 1 is a closed set — it can only find what someone already thought to write down. Question 2 is the
one that finds the third caller, and it dies when bundled into a verification brief: the named questions
crowd it out and the shard reports back on them. **It gets its own shard, always**, even when that means
two agents for a small change.


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

## Sizing

**Model per shard (WP-128).** Pipe each shard's brief to `node ../wt-shared/scripts/model-route.mjs pick --skill
<shard name> --role researcher`; when it prints a tier (live routing), pass it as that Agent call's `model`. When it
prints nothing (shadow or off, the default), leave `model` unset. A hook cannot set it, so this is the only place it gets set.

Shard by **question type, never by file**. Two shards must never read the same file — that rule is what makes
parallelism cheaper rather than merely faster.

| Shard | Dispatch when | Persona |
|---|---|---|
| surface | always | `references/agents/surface-researcher.md` |
| blindspot | always | `references/agents/blindspot-researcher.md` |
| dependency | the change depends on a library's behaviour | `references/agents/dependency-researcher.md` |

Floor 2, ceiling 4. A change crossing three or more packages may split the blindspot sweep by package, with
disjoint roots stated in each brief. Read `references/shard-sizing.md` before splitting.

**Dispatch every shard in one message** so they run concurrently. Queueing, not tokens, is the measured cost
of a multi-agent step — a shard dispatched in its own turn adds its whole scheduling wait to the run.

## Brief

Each shard gets: the ticket text, the worktree path, its own question, its disjoint surface, and the schema.
Tell it explicitly to

- **quote code**, not summarise it — a path alone is an assertion about a file, a quote is the file speaking
- **separate verified fact from inference**, and use `verdict: unknown` rather than hedging
- return records only, with no narrative wrapper

## Consolidate

Merge the shards into one table. Assign stable ids in one pass — never renumber while the caller is still
using them.

**Write the table to the session scratchpad, not the repository.** It is a working artifact: the caller reads
it, absorbs what the plan needs, and the plan is what gets committed. A findings file in the repo is a second
document that duplicates the plan's evidence and then rots beside it.

Where shards disagree, **do not average them.** Keep both records, mark the conflict, and resolve it by
reading the code yourself. A disagreement between two shards is usually a real ambiguity in the code and is
worth a plan sentence.

Report `disproved` records prominently. They are what stops the plan inheriting a stale ticket, and they are
`wt-ship`'s compound input later.

## Optional, ADVISORY: what to read first

`wt-judge.mjs relevance` ranks candidate files against the research question, so the reads that matter
come first. It prints a **reading order, never a shorter list** — there is no threshold and nothing is cut.

```bash
node ../wt-shared/scripts/wt-judge.mjs relevance candidates.json --rev <sha> \
  --question "<the research question, in full>"
```

Candidates are paths, or `{path, line, excerpt}` when a grep already produced the matching text — pass the
match rather than making it re-read the head of the file.

**Read down the order; do not stop because the numbers got small.** The candidate set here is open, unlike
a review's diff, and this skill's job is to sweep for what nobody named — which is exactly what a ranking
is worst at seeing. Trimming the list is how that gets missed, and nothing afterwards can prove it was.

When something near the bottom turns out to have mattered, say so:
`node ../wt-shared/scripts/wt-judge.mjs mark <run>#<i> yes` — that is the only evidence that
could ever justify letting this cut anything.

Measured once: on a real OTP question over 60 candidates, the four files that carried the answer ranked
1, 2, 4 and 6. One case, n=4.

Exit 3 means no key: read the candidates as you always have.

## Every record's quote must establish its claim

A record can carry a real quote that does not establish the claim drawn from it — a document-level evidence
score sees that only in aggregate, and the shard that wrote it cannot see it at all.

```bash
node ../wt-shared/scripts/wt-judge.mjs cite records.json
```

**The contract already says records carry quoted evidence; this is what makes that mean something.** A
quote that is real but does not establish the claim drawn from it passes every check the schema makes, and
is the failure a document-level evidence score cannot see. Check each one by reading, or in one call:

One Noul per record: *does this quote establish this claim on its own?* It catches a path cited without its
contents, and a quote that contradicts the claim made from it. Re-shard what fails rather than passing it to
the plan, where it stops looking like a guess.

**Exit 3 means no key: consolidate as before.** The verdicts in the records are self-assessed either way.

Each run prints `run <id>`. **When you later find a judgment was wrong, say so** —
`node ../wt-shared/scripts/wt-judge.mjs mark <run>#<i> yes|no` — using the observed outcome,
never a second opinion from the same model. That log is the only thing that moves the thresholds.

## What this does not find

Plan errors. A decision that targets the wrong file, a count that does not sum, a heading contradicting its
body — no amount of research prevents those, and on a measured run they were the majority of what review
caught. That class belongs to the self-trace and a feasibility lens. Do not widen a research brief to chase
it.
