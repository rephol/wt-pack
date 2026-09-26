# Plan format

One file, in the repo's plans directory, following whatever naming convention that directory already shows.
If it shows none, `YYYY-MM-DD-NNN-<type>-<topic>-plan.md`.

A plan is a **point-in-time record**, not a living document. Once it ships it stays as written; what was
actually built is derived from git.

## Sections

**Goal** — what changes for whom, in a few sentences. Not a restatement of the ticket.

**What research corrected** — every `disproved` finding, and every stale claim carried in the ticket. This
section exists so the next reader does not re-derive a wrong answer, and so the implementer does not trust a
ticket line the plan already knows is false. Quote the evidence that disproved each one.

**Approach** — the shape of the change and why this shape. Name the alternatives that were live and why they
lost. A settled decision from step 4 is labelled `settled:` with its rejected alternative beside it.

**Implementation units** — each with a stable `U-id`, a goal, the files it touches, and its own verification.
Units are commit boundaries, so size them as something a reviewer can read in one sitting.

**Files** — a flat list of every path created or modified. Re-derive it from the units rather than writing it
first; the two disagreeing is the most common self-trace catch.

**Verification** — how each unit is proven. Written as instructions, not as results, unless the plan run
actually executed them — in which case say which.

**Definition of Done** — the conditions that make this complete. `wt-work` implements to this, and it is what
tells a reader whether a worker that went idle actually finished, so each condition must be checkable against
the worktree rather than asserted in chat.

**Risks and deferred** — what could still be wrong, and what is deliberately not being done. A deferred item
that the Definition of Done secretly depends on is a scope-lens finding; catch it here first.

## Evidence

The findings table stays in the scratchpad. **This document is the only artifact**, so it carries its own
evidence: where a load-bearing assertion rests on something research read, quote it inline —
`src/policy.ts:21` and the words that decide it. Load-bearing means the plan would change if it were false.

Never write `(F-07)`. The implementer will not have the findings table, so a finding id reads as evidenced
while resolving to nothing — worse than no citation, because it stops them checking.

Anything with no evidence behind it is marked `[unsourced]` **inline, where it sits** — not footnoted, not
collected in an appendix. Visibility at write time is the entire mechanism.

Ticket text is not evidence. A claim carried from the ticket with no shard behind it is `[unsourced]` however
confidently the ticket states it. The same applies to your own memory of the codebase.

**Keep the quoting proportionate.** One line and a location for a load-bearing claim, not a transcript. The
plan absorbs what a reader needs to trust it, and the rest of the table dies with the session — which is the
intent, not a loss.

## Numbers

Re-derive every one. A figure copied from the ticket has been verified by nobody. A count stated in two
sections must sum in both directions, and a gate written as a count passes while the thing it counts is wrong.

## What does not go in a plan

Reading strategy, instructions about how to work, restatements of the repo's conventions, or an argument for
why the plan is good. `wt-work` knows how to work a plan. Every defensive paragraph is complexity smuggled in
as prose, and the next edit will contradict it.
