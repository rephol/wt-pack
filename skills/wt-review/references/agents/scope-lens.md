# Scope lens

Triggered when the target is large, or has a deferred section.

## Look for

- **Work smuggled in past the ticket.** A unit that is a good idea and is not what was asked. Name it; the
  user decides, not the target.
- **A deferred item the Definition of Done depends on.** The target cannot complete as written, and the
  dependency is invisible because the two sit in different sections.
- **A "later" with no owner and no trigger.** "We will revisit when X" where nothing measures X is a promise
  with no assertion behind it. A placeholder that disappears "when ENG-NNN lands" is the same shape.
- **A unit too large to review.** Units are commit boundaries; one that touches fifteen files across four
  packages will land as an unreviewable diff whatever the target says.
- **Scope that grew to make a decision look necessary.** A refactor justifying itself by the work it enables,
  where the work could be done without it.
- **Missing work the goal requires.** The opposite failure, and easier to miss: a Definition of Done that
  cannot be met by the units listed.
- **Duplicated logic a sibling helper already provides.** A new function reimplementing what a neighbour
  already does, found by grepping for the same shape before trusting the diff's own naming.
- **A new abstraction with one caller.** An interface, base class or config layer introduced for exactly one
  concrete use — the abstraction is speculative until a second caller exists.

## Rules

- Do not argue for a smaller target as a preference. Name the specific item and what it costs.
- A `settled:` decision is challengeable only as infeasibility.
- Verify before reporting.

## done =

Every unit checked against the ticket's actual ask, every deferred item traced against the Definition of
Done, and a grep run for sibling helpers or abstractions the new code might duplicate rather than trusting
the diff's own framing.

## Don't flag

- A unit that is larger than usual but is a single atomic commit that cannot be split without leaving the
  tree in a broken intermediate state — size alone is not the finding, unreviewability is.
- A new abstraction with one caller today when the target's own text names the second caller landing in a
  unit later in the same plan — that is staged introduction, not speculative design.

## Return

Findings ranked by severity: the item, whether it is excess or absence, and its concrete consequence.

Write findings per `references/reviewer-contract.md` and SKILL.md's schema — JSON to
`<scratchpad>/findings/scope.json`, a one-line count and the worst one in your reply. The caller groups
duplicates and checks every finding against the file it cites, and both read this file — a prose reply means
neither runs.
