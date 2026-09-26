# Implementation loop

For each unit, in the plan's order.

```
while units remain:
  - mark in progress
  - read the files the plan names, and the neighbours that define the conventions
  - ALREADY DONE? if the unit's verification criteria are already satisfied by the
    current code, verify it matches the plan's intent, mark complete, move on.
    Do not silently reimplement — the work may have landed on a prior branch.
  - OUT-OF-REPO? if any part of completion depends on state outside the repo
    (a console setting, a DNS record, a CMS object, live rows), that part has no
    git-derived signal. Decide it from the observed state of the deliverable, never
    from a clean tree or a tracker write. Complete only when that state is already
    satisfied; act only when it is observably unsatisfied and re-applying is safe
    or authorized; otherwise ask or block.
  - find existing tests (evidence-strategy.md)
  - choose the evidence strategy BEFORE changing behaviour
  - when it calls for proof-first, write/strengthen the test now and observe the
    expected failure before touching production code
  - implement, following existing conventions
  - add, update or remove the remaining tests the change implies
  - run the system-wide check (system-wide-check.md)
  - run the tests
  - record verification evidence for the unit
  - mark complete
  - evaluate an incremental commit (incremental-commits.md)
```

## Batch the reads

Within a unit, the plan's referenced files, the pattern searches and the test discovery do not depend on one
another — request them in one turn rather than one per turn. Only write-then-verify is inherently sequential.
Scheduling latency, not token count, is what makes a slow run.

## Simplify at phase boundaries, not per unit

After a cluster of related units — every two or three, or at a natural boundary — review the recently changed
files for consolidation: duplicated patterns, a helper that wants extracting, reuse you can now see.

Do **not** do this after every unit. Early patterns often look duplicated and then diverge deliberately in
later units; consolidating early forces a shape the later units have to fight.

When the plan carries `settled:` decisions, they constrain this: a deliberate duplication stays duplicated.
Pass the plan as context for what must stay as it is, not as the scope of the simplification.

## Progress

Keep the task list current. Reference the plan's unit ids in blockers, deferred notes and summaries — not in
routine status updates, where they bury signal under noise. Create new tasks if scope expands, and say so.

## Frontend work

When the change touches views, components, layouts or user-visible routes: preserve the existing design-system
conventions, use real controls and states, keep layouts responsive, and check that text does not overflow or
overlap. Look at the changed UI at desktop and mobile widths before final verification, **with the
`agent-browser` skill first** (`agent-browser skills get core`); other browser tooling only when it is not
installed. Without any, do a code-level responsive review and **record that browser verification was
unavailable** rather than implying it happened.
