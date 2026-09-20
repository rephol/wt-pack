# The PR body

A reviewer should be able to start reviewing **without opening the plan**, and should finish the body knowing
the two things only this run can tell them.

## Shape

**What it does** — two or three sentences, in the domain's words. What behaviour is different afterwards, and
for whom. Not a file tour; the diff is right there.

**What research corrected about the ticket** — the `disproved` findings. This is the highest-value paragraph
in the body and the one no one else can write: the reviewer is about to read the ticket, and the ticket is
wrong in the specific ways listed here. Quote the evidence inline, the same way the plan does.

**What review corrected about the implementation** — the findings that were applied. It tells the reviewer
which areas already had a pass and what the near-misses were, so they spend their attention elsewhere.

**Verification** — what was actually run, and what was *not*. A change that is dormant on the default
config, or that preview cannot exercise, says so plainly. Never imply a check that did not happen.

**Anything still open** — deferred items, known residuals, a requirement gap the plan named. A reviewer who
finds one of these unannounced treats the whole body as unreliable.

## Rules

- **Facts, not narration.** No "I first tried X, then realised Y". The reviewer is deciding about the code,
  not the process.
- **No acceptance-criteria recital.** Link the plan; do not paste its Definition of Done.
- **State the base branch** when it is not the repository default. A reviewer reading a diff against the
  wrong base sees changes that are not yours.
- **Do not claim green.** Say which suites ran and what they returned. If something is red, say so in the
  body — a reviewer who discovers it from CI stops trusting the rest.
- **Follow the repo's conventions and attribution rules**, including any required trailer.

## Mechanics

Write it to a file and pass the path — `scripts/pr.sh` takes `--body-file`, so backticks, newlines and
code fences survive without shell quoting mangling them.

Keep it readable at the length a reviewer will actually read. If the interesting part is the research
correction, let that be the longest section and cut the rest.
