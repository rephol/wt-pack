# Evidence intake

The plan carries its own evidence. Research ran before it was written and was **absorbed** into it: where a
load-bearing claim rests on something read, the plan quotes the `file:line` and the words that decide it.
There is no separate findings document, by design — one would duplicate this and then drift from it.

## How to use it

- **A claim quoting a `file:line` was verified.** Someone opened that file and read those lines when the plan
  was written. Do not re-read it to satisfy yourself. Re-verifying an evidenced plan is the cost this
  absorption exists to avoid.
- **A claim marked `[unsourced]` was not verified.** The plan is telling you it could not back this up.
  Verify it before you depend on it, and say what you found.
- **A "what research corrected" section is why the plan diverges from the ticket.** Read it first. It explains
  decisions that otherwise look arbitrary, and it stops you "fixing" the plan back toward a stale ticket.

## When the code contradicts the plan's evidence

That is a blocker, not a detail. Either the file moved or research was wrong, and either way the plan may be
wrong in a way nobody has seen. Stop, report the claim, what the code says now, and what it changes. Do not
quietly adapt.

## When the plan carries no evidence at all

Say so explicitly in your first report — a plan with no quoted locations was not written by this pipeline, or
was written without research. Treat every claim as unverified, check as you go, and expect to be slower. A
plan's confidence is not evidence.
