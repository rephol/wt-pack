# Scope lens

Triggered when the plan is large, or has a deferred section.

## Look for

- **Work smuggled in past the ticket.** A unit that is a good idea and is not what was asked. Name it; the
  user decides, not the plan.
- **A deferred item the Definition of Done depends on.** The plan cannot complete as written, and the
  dependency is invisible because the two sit in different sections.
- **A "later" with no owner and no trigger.** "We will revisit when X" where nothing measures X is a promise
  with no assertion behind it. A placeholder that disappears "when UMK-NNN lands" is the same shape.
- **A unit too large to review.** Units are commit boundaries; one that touches fifteen files across four
  packages will land as an unreviewable diff whatever the plan says.
- **Scope that grew to make a decision look necessary.** A refactor justifying itself by the work it enables,
  where the work could be done without it.
- **Missing work the goal requires.** The opposite failure, and easier to miss: a Definition of Done that
  cannot be met by the units listed.

## Rules

- Do not argue for a smaller plan as a preference. Name the specific item and what it costs.
- A `settled:` decision is challengeable only as infeasibility.
- Verify before reporting.

## Return

Findings ranked by severity: the item, whether it is excess or absence, and its concrete consequence.
