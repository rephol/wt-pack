# Reviewer contract

Every reviewer this skill dispatches — any lens, either mode — follows this. It is what turns a finding into
something the caller can act on without re-opening the file itself: a confidence the caller can trust, a
quoted line instead of a paraphrase, a fix idea instead of a diagnosis with nowhere to go.

## Confidence: five steps, each tied to what you actually did

Not a felt number. Report how much you verified, from this fixed scale — pick the step whose description
matches what you did, not the one that sounds better:

- **100** — you read the exact line(s) the finding is about, in the current file, and traced the concrete
  failure end to end: a real caller, a test, or a realistic input that reaches it.
- **75** — you read the file and the cited line, but did not trace the full failure path (you could not run
  the test, or the failure depends on a runtime value you did not observe).
- **50** — you read the file, but the finding rests on an inference ("this looks like it would break if X")
  without confirming X actually happens on this path.
- **25** — you did not open the file. The finding comes from the diff hunk, a description, or pattern-matching
  against a shape you recognise.
- **0** — a guess with no evidence behind it.

**Drop anything below 50 before it leaves your findings file.** A 25 or 0 is a lead for you to go verify or
delete, not review output.

**A finding at ≥75 must quote the offending line in `evidence` (below), verbatim.** If you cannot quote it,
your real confidence is lower than you are claiming — demote the finding to match what you actually checked,
do not round up.

## Evidence

Every finding carries `evidence`: the literal snippet, error text, or line content that shows the defect —
not a restatement of it in your own words. `detail` says what is wrong; `evidence` is what you actually saw
when you looked. A finding whose `evidence` does not quote anything from the file it cites is a finding
nobody downstream can fast-check, and belongs at a lower confidence per the rule above.

## suggested_fix

Every finding also carries `suggested_fix`: one sentence, concrete enough for whoever applies it to start
typing — "reject an empty `paths` array before the join, the same as the sibling branch two lines up," not
"add validation." A finding with no fix idea has usually not been thought through past "this looks wrong."

## Known false positives — do not report these

- A `catch` with no rethrow next to a comment explaining it is intentional (`// fail-open`, `// ponytail:`
  or similar) — a documented design choice, not a missed error path, unless the comment's own reasoning is
  itself wrong.
- A test pinned to a fixed number that matches the code's own constant — a pinning test working as intended,
  not a "test that cannot fail," unless that same constant is what this diff changes.
- A loose or `any` type confined to a third-party type shim or a `.d.ts` override — normal for bridging a
  library's own loose types, not new unsafety introduced by this diff.
- A missing `await` on a call whose result is genuinely never needed (a fire-and-forget broadcast, an
  analytics ping) — check the call's own contract before assuming every un-awaited promise is a bug.

## Intent mismatch

Its own finding type: the code does something different from what the diff *says* it does — the commit
message, the PR description, the plan's Definition of Done, or a comment inside the diff. State the claim,
quote it, and show the line where behaviour diverges. Report this even when the actual behaviour looks fine
on its own merits — a correct implementation that contradicts its own stated intent still needs the mismatch
resolved (fix the code, or fix the claim), and whoever applies findings cannot tell which without being told.

## Tool budget

Roughly 40 tool calls. Spend them opening your assigned/cited files, tracing a caller or two per suspect
finding, and checking one sibling implementation when a finding claims inconsistency — not on re-deriving
research the findings table already measured (the research scoping in SKILL.md's "What reviewers are told").

When the budget runs out before every assigned file is read in full, say so in your reply: name the files you
did not reach and why. This is the same skimmed/skipped accounting the per-file coverage section already
requires — the budget is a reason it happens, not a separate rule to satisfy independently.

## residual_risks and testing_gaps

Two arrays in your reply, not per finding — one set for your whole pass:

- `residual_risks` — things you noticed that are not defects yet but could become one: an untested retry
  path, a config value that is currently safe only because nothing sets it.
- `testing_gaps` — assigned surface with no test covering it at all. Distinct from a per-file "skipped":
  skipped is about your own reading budget; a testing gap is about the *code's* own coverage.

Empty arrays are a legitimate, common result. State them as empty — do not omit the keys.
