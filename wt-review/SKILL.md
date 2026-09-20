---
name: wt-review
description: >
  Review a plan or a diff with a lens set computed from what the target actually touches, rather
  than a fixed reviewer panel. A plan always gets coherence and feasibility; a diff always gets
  correctness and regression; both add standards, testing, learnings, security, data, scope or
  adversarial only when the target's own content triggers them, and bundle lenses into as few agents
  as possible. Checks the change against the repo's documented rules and its recorded learnings, so
  earlier work is read rather than only written, and hands reviewers the findings table so they
  verify unsourced claims instead of re-deriving the codebase. Use when a plan, spec or requirements
  document needs reviewing before implementation, or when implemented work needs reviewing before it
  ships. Called by wt-plan and wt-ship; also useful invoked alone.
allowed-tools: Bash, Read, Glob, Grep, Agent, ToolSearch
---

# wt-review

Reviews a **plan** or a **diff**. Returns findings; **the caller applies them.**

One sizing table serves both, deliberately. The triggers are properties of the change, not of the document —
a migration is a data risk whether it is described or written — and a second copy of this table living in the
shipping skill is a lockstep with nothing to fail when it drifts.

Inputs: the target, the findings table, and the `[unsourced]` list (plan mode) or the plan path (diff mode).
A reviewer without the findings table re-reads the codebase to check what research already checked, which is
the expensive part and the avoidable one.


## Execution discipline

Measured across three full runs of this pack and its predecessor. Turn count is what costs — each turn
re-processes a growing context — so these two rules outrank any prose below them.

- **Batch independent calls.** Reads, greps and globs that do not depend on one another belong in one turn,
  either as several tool calls in a single message or as one compound shell command. The compound command is
  the idiom that actually gets used here (93–100% of `Bash` calls in the runs that went well, median ~200
  characters); a run that degenerates into many tiny calls is the failure shape to avoid.
- **Write whole files; do not build them with edits.** A new file, or a rewrite of most of one, is a single
  `Write`. Reach for `Edit` only for a small change to a file that mostly stays. The run that followed this
  rule used 13 edits where the run that did not used 27, for the same measured defect-detection power.

## Mode

**Plan mode** — the target is a plan, spec or requirements document, reviewed before implementation.
**Diff mode** — the target is `git diff <base>...HEAD` or a PR, reviewed before it ships.

The mode swaps only the two mandatory lenses. Everything else — the conditional triggers, the sizing, the
bundling, the prohibitions — is identical.

## Optional: score the target first

If it is configured, `~/.claude/skills/wt-shared/scripts/wt-eval.mjs` returns calibrated scores for the dimensions this pack keeps
failing on — evidence, Definition of Done, scope, unit decomposition on a plan; evidence and actionability
on findings. Use it to aim the review, never to replace it: it scores a document, it does not find defects.

```bash
node ~/.claude/skills/wt-shared/scripts/wt-eval.mjs <target> [--type plan|research|review|learning]
```

**It is optional and unconfigured is the normal case.** It needs a TypeSafe API key, from
`TYPESAFE_API_KEY` or a `TYPESAFE_API_KEY=` line in `~/.claude/.env`. Exit **3** means no key: say nothing
and review as usual. Exit 1 is a real failure worth one line. Never ask the user to obtain a key, and never
block a review on it.

Read the scores as aim, not verdict: a low dimension says which lens to read closely, and **confidence near
zero means the question did not apply to this target** — ignore that row rather than treating it as a finding.
The scores are input to your judgement and never appear in the returned findings.

## Calibrating the optional judgments

`wt-judge.mjs calibrate [cmd]` reports, per command, a Brier score (do the probabilities match reality) and
the threshold that minimises cost on the outcomes marked so far. The two answer different questions: a
well-calibrated model can still be cut in the wrong place. `--apply` writes `~/.claude/wt-judge-thresholds.json`,
which overrides the shipped defaults — and refuses below 20 labelled samples per command, because a threshold
moved on five is superstition.

False positives and false negatives are weighted differently per command, by what each error actually costs:
a false merge in `dedupe` loses a finding, a missed behaviour change in `simplify` ships a bug.

## Optional: compute the lens set instead of matching triggers

`~/.claude/skills/wt-shared/scripts/wt-judge.mjs lenses <target>` returns a probability per trigger and prints the lens set. It is the
same table below, judged rather than string-matched — a docs-only diff fires nothing; a migration plan fires
data and testing at 90%+.

```bash
node ~/.claude/skills/wt-shared/scripts/wt-judge.mjs lenses <target> [--mode plan|diff]
```

**Exit 3 means no key: size from the trigger table below, exactly as before.** Never skip sizing.

Read the numbers, not just the marks. The threshold is 0.4 because 0.5 fired all seven lenses on a real
plan; anything landing between 0.4 and 0.6 is genuinely your call, and adding that lens is the safer error.
The always-on lenses are never judged — they are structural, and asking invites dropping one.

**What `mark` means here, exactly: did the lens belong in the set — not did it pay off on the day.** A
security lens on an auth change belonged there even if it found nothing, or found only things verification
later refuted. Mark it `no` only when the lens had no business running against that target at all. Marking
the two questions interchangeably is how a calibration log quietly stops meaning anything.

## Size from the target, not from judgement

Read the target and compute the risk vector. Each trigger adds a lens; nothing else does.

| Trigger | Lens | Persona |
|---|---|---|
| — always, plan mode — | coherence | `references/agents/coherence-lens.md` |
| — always, plan mode — | feasibility | `references/agents/feasibility-lens.md` |
| — always, diff mode — | correctness | `references/agents/correctness-lens.md` |
| — always, diff mode — | regression | `references/agents/regression-lens.md` |
| the repo has an instructions file or guidelines it documents rules in | standards | `references/agents/standards-lens.md` |
| the target adds or changes tests, or claims a guard | testing | `references/agents/testing-lens.md` |
| the repo has a solutions / learnings store | learnings | `references/agents/learnings-lens.md` |
| touches auth, credentials, safety, secrets, or user data | security | `references/agents/security-lens.md` |
| migration, schema or data-shape change; a backfill | data | `references/agents/data-lens.md` |
| large, or it has a deferred section / unfinished work | scope | `references/agents/scope-lens.md` |
| greenfield, or no validated upstream requirements | adversarial | `references/agents/adversarial-lens.md` |

The two mandatory pairs are counterparts, not different jobs: coherence asks whether the plan agrees with
itself and correctness whether the code does what it says; feasibility asks whether a step can be performed
and regression what performing it disturbed.

**Standards, testing and learnings apply in both modes.** A plan can walk into a documented trap or specify a
guard that cannot fail just as easily as code can — earlier, and more cheaply.

**Learnings is the read side of `wt-compound`.** A store nothing consults on the way in does not compound, it
accumulates. Where a repo has one, this lens is what makes every earlier entry pay.

**Floor 1 agent. Ceiling 3.** No trigger fires → one agent carrying the mandatory pair. Everything fires →
three agents with lenses bundled, never nine.

Bundle by reading surface:

| Agent | Lenses | What it reads |
|---|---|---|
| 1 | mandatory pair + standards | the target against the code and the repo's own rules |
| 2 | testing + learnings | the guards, and what the repo already knows |
| 3 | security · data · scope · adversarial | the risk surface and the target's own premise |

Collapse upward when few triggers fire — two lenses do not need two agents. Never split a bundle to give a
lens its own agent.

**Dispatch every agent in one message.** Queueing dominates a multi-agent step — on a measured run, waiting
on reviewer scheduling cost more than the reviewing. A lens dispatched in its own turn adds its whole
scheduling wait to the run, which is the real argument for bundling. It is not a token argument.

**Do not accept a lens list from the caller** unless they name a reason the triggers cannot see. The rule
exists so the sizing is repeatable rather than a mood.

## What reviewers are told

Each brief carries the target (they read it themselves — do not paste it), the findings table, the
`[unsourced]` list or the plan path, their disjoint surface where one applies, and one instruction that
shapes everything:

> Research has already run. Findings are measured, not remembered. **Do not re-derive the codebase.** Verify
> the `[unsourced]` claims, check the reasoning, and challenge a cited finding only if you have reason to
> think the evidence does not say what the target says it says.

And one prohibition:

> A decision labelled `settled:` was made by the user. Challenge it only as **infeasibility** — that it
> cannot work — never as preference. If you would have chosen differently, that is not a finding.

In diff mode, add the plan's Definition of Done and one more line:

> Work that does not meet the Definition of Done is a finding. Work beyond it is also a finding.

## What review is actually for

On a measured run, the majority of findings were **not** research gaps. They were self-inflicted errors in
the target itself: a unit targeting the wrong one of two same-named config files, inverted merge semantics,
stale line citations, a count written as 20 where the thing counted was 19, a test suite routed to a file
where its fixtures could never load — so every case passed, including the injection check meant to prove
otherwise.

No findings table prevents that class. Feasibility and correctness are the lenses that catch it, which is
why the mandatory pair is never optional. Point reviewers at the target's *internal* consistency and at
whether each step can actually be performed, not at re-auditing the research.

## Return

Before returning, deduplicate. `~/.claude/skills/wt-shared/scripts/wt-judge.mjs dedupe <findings.json>` compares every pair and groups
them transitively, so A~B and B~C come back as one group rather than two pairs you must merge yourself:

```bash
node ~/.claude/skills/wt-shared/scripts/wt-judge.mjs dedupe findings.json --json
```

Exit 3: deduplicate by reading, as before. The threshold is 0.6 and deliberately asymmetric — a false merge
silently drops a real finding, while a false split costs one duplicate line.

## Optional, ADVISORY: where a lens should read first

`wt-judge.mjs attention <diff> --lens <name>` ranks the diff's hunks by whether that lens would find
something in them. It ranks; **it does not decide what you read.**

```bash
node ~/.claude/skills/wt-shared/scripts/wt-judge.mjs attention pr.diff --lens correctness
```

Read the cut list too, every time. This is an experiment with its own falsification: a confirmed finding
out of a hunk the ranking put at the bottom is `mark <run>#<i> yes`, and that is the only evidence that
could ever promote this from advisory.

**It has already been falsified once.** On PR #1083 under `correctness`, the file carrying that review's
worst real defect scored 0.31 and fell in the cut list, while the hunk that merely calls it scored 0.78 —
a new file arrives as one large hunk whose local shape looks inert. Treat the ranking as a reading order,
never as a filter, and do not let it shrink the surface.

Exit 3 means no key: read the diff as you always have.

## Every returned finding carries a verification state

**This is part of the return contract, not an extra.** A findings table whose entries do not each say
`confirmed`, `refuted` or `unverifiable` is an incomplete return, however good the findings are.

The state means one thing: someone opened the file the finding cites and looked. On a measured run, two
of eight load-bearing findings were plainly false against that file — a receiver with no sender check on a
module whose manifest is empty, a "typo ships green" on a string a test pins. Neither reviewer had opened it.

- **confirmed** — the file shows the defect, and the failure predicted follows from it.
- **refuted** — the file contradicts it. **Report it as refuted; do not delete it.** A lens producing
  refuted findings is itself a finding about the review.
- **unverifiable** — the answer lives outside the files at hand: a dependency's behaviour, a runtime value,
  a build output. Ships with the word attached. These are the ones worth a human minute, and they are not
  a pass.

Verify by reading, or let the judgment layer do the reading:

```bash
node ~/.claude/skills/wt-shared/scripts/wt-judge.mjs verify findings.json --rev <sha> --json
```

Give every finding a `file`, a `line` where there is one, and `related` — the paths where a refutation would
live, the test that pins the string, the caller. A finding whose answer is in a file you did not supply comes
back unverifiable, correctly.

**Exit 3 means no key: verify by reading. The contract is unchanged** — the tool is the fast path to it, never
the reason for it. And the tool is a filter on findings you already have, never a substitute for finding them:
on that same run it confirmed at 60% a finding a pinning test refutes, with the test in front of it. Read the
number.

Findings ranked most-severe first. Each one: what is wrong, the concrete failure it produces, where, and its
verification state.

Each run prints `run <id>`. **When you later find a judgment was wrong, say so** —
`node ~/.claude/skills/wt-shared/scripts/wt-judge.mjs mark <run>#<i> yes|no` — using the observed outcome,
never a second opinion from the same model. That log is the only thing that moves the thresholds.
Deduplicate across lenses before returning — two agents finding the same thing is one finding, and reporting
it twice inflates the apparent yield of a bigger panel.

State plainly which mode ran, which lenses ran, and which triggers fired. A caller cannot tell a clean
target from a narrow review otherwise.
