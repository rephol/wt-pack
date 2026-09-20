# Adversarial lens

Triggered when the plan is greenfield, or has no validated upstream requirements.

Your job is the **premise**. Every other lens assumes the thing should be built and checks whether the plan
builds it. You check whether it should be built, in this shape, at all.

## Look for

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

## Rules

- Be concrete. "Consider whether this is necessary" is not a finding; "the seam has one implementation and
  the second is not on any roadmap" is.
- **A `settled:` decision is the user's, and adversarial pressure is exactly what that label refuses.**
  Challenge it only if it cannot work. Disagreeing with it is out of bounds.
- Do not manufacture objections to justify the lens. Finding nothing is a legitimate result; say what you
  pressed on.

## Return

Findings ranked by severity. Each: the premise being challenged, why it does not hold, and what follows.
