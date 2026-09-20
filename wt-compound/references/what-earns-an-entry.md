# What earns an entry

## The bar is a counterfactual, not a feeling

**If this document disappeared, would an engineer reading the final implementation still repeat the mistake
or redo substantial investigation?**

Yes → it qualifies. No → write nothing, and say why.

**Completion, effort and diff size do not establish eligibility.** A hard week that ends in code explaining
itself earns no entry; a two-line fix whose reason is invisible may earn one. The question is only ever what
the artifacts fail to carry.

A learning earns its place when it holds durable reasoning **not readily recoverable** from the final code,
tests, types, comments or existing docs, and losing it would cause recurrence, material risk, or substantial
rediscovery.

## One per run

A session that produced several learnings gets several runs, not one batched document. Batching produces a
document organised around *a session* — which nobody will ever search for — instead of around a problem,
which is how the next person arrives.

## An inaccurate existing learning qualifies

If prior work here has become materially wrong or incomplete, that earns a run on its own: leaving it
actively misleads, which is worse than the gap it filled. **Update that document rather than writing a second
one beside it.** Two documents on one subject is how a knowledge store stops being trusted.

## The input already exists

You are not investigating. The material is in hand:

- **`disproved` findings from the plan.** Something the ticket asserted that the code contradicted. If the
  *reason* it was wrong is structural — two lists with no compile-time link, a config that wins at a level
  nobody checks — that is a learning.
- **Review findings that were applied.** Especially a feasibility or correctness finding: the plan targeted
  the wrong file, or a guard that could not fail. The shape of that mistake generalises; the instance does
  not.
- **A blocker hit during implementation** that the plan did not anticipate.

## Shape

- **Name the failure in the domain's words, not the incident's.** "An unmount is cleanup nobody declared"
  outlives the ticket; "the UMK-1073 bug" does not. The title is the search term.
- **Say what makes it invisible** — a green suite, a clean tree, a successful default, a typecheck that
  passes. If it announced itself, it needed no document.
- **Say where the enforcement is.** Name the test. If nothing enforces it, say that plainly: an unenforced
  rule is a warning, and a warning dressed as a guarantee is worse than silence.
- **Cut the session narrative.** "We first tried X, then realised Y" describes the conversation, not the
  tree. Nobody arriving at this document was in that conversation.
- **Short enough to be read.** An entry nobody finishes protects nothing.

## Where it goes

Follow the repository's own convention — many have a solutions or learnings directory with required
frontmatter, a naming pattern, and an index updated in the same change. Read a recent neighbour and match it.

If the repo has no convention, **do not invent a location.** Say what you would have recorded and let the
user decide.
