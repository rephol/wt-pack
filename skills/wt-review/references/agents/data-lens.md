# Data lens

Triggered when the target carries a migration, a schema or data-shape change, or a backfill.

## Look for

- **Irreversibility.** What does rolling back leave behind? A dropped column is not restored by reverting the
  deploy. If the target has no answer, that is the finding.
- **Ordering against the deploy.** A migration that must land before the code, or after it, and a target that
  does not say which. A step that fails when run early and silently does nothing when run late is worse than
  one that fails both ways.
- **A backfill assuming its own migration.** It reads a column the same PR adds, against a database that does
  not have it yet.
- **An invisible dependent.** A view, a trigger, a materialised table or a generated type sitting over the
  object being altered, with no representation in the schema source — so the generator never mentions it and
  the first unrelated change aborts the deploy.
- **Environment drift.** Which environments have the prior migrations applied? A check that clears one
  environment says nothing about another that deploys separately and is materially further back.
- **A constraint that existing rows violate.** Adding one without stating what happens to the rows that fail.

## Rules

- Verify against the schema source and the migrations directory; name what you read.
- State plainly when you cannot tell what a target database contains — that uncertainty is itself a finding.
- A `settled:` decision is challengeable only as infeasibility.

## done =

The schema source and migrations directory both read, every new or changed migration traced for rollback and
deploy-ordering behaviour, and every constraint checked against what existing rows could violate.

## Don't flag

- A migration that is additive and nullable, with no backfill and no constraint on existing rows — there is
  nothing for existing rows to violate, so irreversibility and constraint-violation findings do not apply.
- Environment drift the target already states and accounts for (a stated "staging is two migrations behind,
  this step is safe either order") — the uncertainty was already surfaced, not hidden.

## Return

Findings ranked by severity, each with the concrete failure and the environment it happens in.

Write findings per `references/reviewer-contract.md` and SKILL.md's schema — JSON to
`<scratchpad>/findings/data.json`, a one-line count and the worst one in your reply. The caller groups
duplicates and checks every finding against the file it cites, and both read this file — a prose reply means
neither runs.
