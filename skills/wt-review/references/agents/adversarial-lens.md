# Adversarial lens

Plan mode: triggered when the plan is greenfield, or has no validated upstream requirements. Diff mode:
triggered at ≥50 changed code lines, or when the diff touches persistence, retries, concurrency or an
external call, or when the change itself is a guard, a test, or a CI gate meant to catch something.

The two modes ask different questions, so read the section for the mode you are in — both share the same
`## Rules` and `## Return` below.

## Plan mode: the premise

Every other lens assumes the thing should be built and checks whether the plan builds it. You check whether
it should be built, in this shape, at all.

### Look for

- **A problem nobody confirmed exists.** What evidence says this is worth doing? A ticket asserting it is not
  evidence; a measurement is.
- **A solution whose success is unfalsifiable.** If it shipped and did nothing, how would anyone know? If the
  answer is "we wouldn't", that is the finding.
- **An abstraction with one implementation**, a config for a value that never changes, a seam nobody will
  mount. Speculative generality survives review because it looks like foresight.
- **A cheaper thing that gets most of the value.** Name it concretely with its real cost, not as a
  strawman.
- **A claimed benefit with no mechanism.** "This will make X faster/safer/clearer" — by what mechanism, and
  what would you measure?
- **A design justified by a premise the plan itself disproved.** Research sometimes undercuts the reason for
  the work, and the plan carries on anyway.

## Diff mode: breaking the implementation

The premise is settled once code exists — your job here is finding the input, timing or failure that breaks
what was actually built, the same instinct the plan-mode section aims at a proposal instead.

### Look for

- **A guard, test or CI gate that can't fail.** It LGTMs because nothing exercises the failure path it claims
  to guard — the testing lens's "test that cannot fail," but here asked of any gate: a lint rule with an empty
  include list, a CI step that reads green because the job it depends on never ran, a runtime guard whose
  condition is unreachable given the caller's own validation upstream.
- **A retry that isn't idempotent.** A retried write, message send or state transition with a side effect the
  second attempt repeats — a duplicate charge, a double-post, a re-applied migration.
- **A race the diff doesn't account for.** Two writers to the same resource with no lock or version check; a
  read-then-write with an await between them; a cleanup that runs concurrently with the thing it cleans up.
- **An external call with no failure mode.** A network, API or subprocess call assuming success — no timeout,
  no retry-vs-fail decision, an error swallowed into a value that looks like a normal result.
- **State that survives past its own assumption.** A cache, a lock, a flag set once and never cleared on the
  failure path — correct on the happy path, wrong the moment an error interrupts it.
- **A boundary a caller, a queued job, or another process controls.** Not only credentials-style security —
  any input someone else shapes: length, encoding, ordering, repetition, replay.

## Rules

- Be concrete. In plan mode, "consider whether this is necessary" is not a finding; "the seam has one
  implementation and the second is not on any roadmap" is. In diff mode, name the input, the timing window, or
  the call sequence that breaks it — "this could theoretically race" with no scenario is not a finding.
- **A `settled:` decision is the user's, and adversarial pressure is exactly what that label refuses.**
  Challenge it only if it cannot work. Disagreeing with it is out of bounds.
- Do not manufacture objections to justify the lens. Finding nothing is a legitimate result; say what you
  pressed on.

## done =

Plan mode: every load-bearing claim in the plan's own case for the work pressed on — evidence, falsifiability,
mechanism — and at least one cheaper alternative named concretely. Diff mode: every guard, retry, external
call and shared-state access in the diff checked for the specific failure shapes above, not just skimmed.

## Don't flag

- A `settled:` premise you would have designed differently — this lens attacks whether a thing can fail or
  cannot work, never whether a better shape existed.
- An external call or retry that is already wrapped in the codebase's own established idempotency or
  circuit-breaker pattern — verify the wrapper is actually applied before flagging the call as unguarded.

## Return

Findings ranked by severity. Plan mode: the premise being challenged, why it does not hold, and what follows.
Diff mode: the concrete failure, the input or sequence that produces it, and where.

Write findings per `references/reviewer-contract.md` and SKILL.md's schema — JSON to
`<scratchpad>/findings/adversarial.json`, a one-line count and the worst one in your reply. The caller groups
duplicates and checks every finding against the file it cites, and both read this file — a prose reply means
neither runs.
