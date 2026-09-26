# Preserving behaviour

This step is only worth running because it is safe. The moment a simplification changes behaviour it stops
being cleanup and becomes an unreviewed change inside a finished diff — the worst place for one, because
review has already been told this part is settled.

## Never simplify away a safety check

Not for elegance, not because it looks redundant, not because a caller "always" passes a valid value. Leave
alone:

- **validation at a trust boundary** — anything parsing or accepting input from outside
- **data-loss protection** — a confirmation, a refusal on a dirty tree, an idempotency key, a guard before a
  destructive operation
- **security checks** — authorization, a fail-closed default, a scrubber, an origin check
- **accessibility affordances** — a label, a role, a focus target, a keyboard path

A check that looks redundant is usually defence in depth, and depth is the point. If one is genuinely dead,
that is a finding to report, not an edit to make.

## What counts as protected behaviour

Every **output, error, side effect and ordering**. All four, not just the return value — a rewrite that
produces the same value while throwing a different error, or emitting events in a different order, has
changed behaviour.

**If you cannot argue a change is a no-op, skip it.** "Probably equivalent" is the sound of a bug being
introduced. Two specific cases where that instinct is usually wrong:

- **Replacing a serializer or a coercion.** Prove equivalence across every value type actually in play, or
  leave it.
- **Consolidating near-identical code.** The difference between the copies is often the whole reason there
  are two.

## Settled decisions constrain this step

A `settled:` decision in the plan is not scope for simplification — it is a boundary on it. A deliberate
duplication stays duplicated; consolidating it overturns a choice the user made, and does so invisibly,
inside a commit labelled cleanup.

Where you leave something alone for this reason, **say so in the report.** That record is what stops the next
reader re-proposing it.

## Prove it

Run the project's typecheck and lint, and the tests matched to the blast radius — scoped tests for a local
change, broader ones where the change is shared or wide-reaching, the full suite when the runner cannot
scope.

- **Report failures with the check name and the real output.**
- **Fix what the simplification broke, or revert that change.** Never relax an assertion, weaken a type or
  skip a test to get green — that converts a caught regression into a shipped one.
- **If no suite, lint or typecheck is configured, say so explicitly.** An unverified simplification is
  reportable, not silent.

## When there is nothing to do

A scope with no substantive hand-written code — only docs, generated files, lockfiles or mechanical churn —
has nothing to simplify. Say so and stop. This is about the *kind* of change, never its size: a small
deliberate scope still runs.
