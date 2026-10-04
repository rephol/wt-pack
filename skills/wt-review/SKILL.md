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

Paths to scripts and files are relative to this skill's base directory (announced when it loads), so they
work both from the `./setup` links and from a plugin install (WP-122).

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

## Delta reviews

A review of a delta (only what changed since the last round — `wt-watch-prs`'s "review each new head", or a
requested re-review after fixes) applies every sizing and coverage rule below to the **delta's own**
line/file count, not the original diff's. A delta under the shrinking size ceiling can legitimately drop to
fewer agents than the first round used — but it can never drop a lens the delta itself triggers, even one
the first round already ran: if the delta touches auth again, security runs again, regardless of what the
earlier round found.

## Optional: score the target first

If it is configured, `../wt-shared/scripts/wt-eval.mjs` returns calibrated scores for the dimensions this pack keeps
failing on — evidence, Definition of Done, scope, unit decomposition on a plan; evidence and actionability
on findings. Use it to aim the review, never to replace it: it scores a document, it does not find defects.

```bash
node ../wt-shared/scripts/wt-eval.mjs <target> [--type plan|research|review|learning]
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

`../wt-shared/scripts/wt-judge.mjs lenses <target>` returns a probability per trigger and prints the lens set. It is the
same table below, judged rather than string-matched — a docs-only diff fires nothing; a migration plan fires
data and testing at 90%+.

```bash
node ../wt-shared/scripts/wt-judge.mjs lenses <target> [--mode plan|diff]
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
| plan: greenfield, or no validated upstream requirements. diff: ≥50 changed code lines; touches persistence, retries, concurrency or an external call; or the change itself is a guard, a test, or a CI gate | adversarial | `references/agents/adversarial-lens.md` |
| the target changes SKILL.md prose, a prompt, handoff/wt-message text, or MCP tool descriptions | agent-native | `references/agents/agent-native-lens.md` |
| touches timeouts, retries, launchd plists, child processes, kill paths, or a `Monitor` driving a long-running loop | reliability | `references/agents/reliability-lens.md` |
| touches a polling interval, a render loop, work done per tick, or an unbounded read | performance | `references/agents/performance-lens.md` |

Reliability and adversarial overlap on "retries an external call" by design — reliability looks for a defect
in the retry itself, adversarial attacks whether the call can be broken at all. Both firing on the same
target is expected, not a sizing bug.

The two mandatory pairs are counterparts, not different jobs: coherence asks whether the plan agrees with
itself and correctness whether the code does what it says; feasibility asks whether a step can be performed
and regression what performing it disturbed.

**Standards, testing and learnings apply in both modes.** A plan can walk into a documented trap or specify a
guard that cannot fail just as easily as code can — earlier, and more cheaply.

**Learnings is the read side of `wt-compound`.** A store nothing consults on the way in does not compound, it
accumulates. Where a repo has one, this lens is what makes every earlier entry pay.

**Floor 1 agent. Ceiling 4 at ≤200 changed lines, 5 for a per-lens diff review past that (see next section).**
No trigger fires → one agent carrying the mandatory pair. Everything fires, ≤200 lines → four agents with
lenses bundled, never nine.

Bundle by reading surface:

| Agent | Lenses | What it reads |
|---|---|---|
| 1 | mandatory pair + standards + agent-native | the target against the code and the repo's own rules |
| 2 | testing + learnings | the guards, and what the repo already knows |
| 3 | security · data · scope · adversarial | the risk surface and the target's own premise |
| 4 | reliability · performance | how the code behaves under failure and load |

Collapse upward when few triggers fire — two lenses do not need two agents. Never split a bundle to give a
lens its own agent.

## Size by diff, not just by lens (diff mode)

The lens table decides *what* each agent looks for; diff size decides *how the fired lenses are split across
agents*. Read the changed-line count (`git diff <base>...HEAD --shortstat`, or `--numstat` summed) before
assigning agents:

- **≤ 200 changed lines** — the lens-bundle agent count and table above stand: bundle by reading surface,
  floor 1, ceiling 4, each agent reads the whole diff.
- **> 200 changed lines** — **one agent per fired lens**, capped at **5**. Each of those agents reads **every**
  changed file in full — the lens is its filter, not a slice of the file list — so give each agent the
  complete `git diff --name-only` list, not a disjoint subset. This replaces file-slicing: past 200 lines, the
  split is by lens, not by file. **The mandatory pair (correctness + regression, or coherence + feasibility in
  plan mode) always shares one agent, exactly as it does at ≤200 lines** — it never counts as two toward the
  5-agent cap and is never split by this rule.
  - When more than 5 lenses fire (counting the mandatory pair as one), merge whole rows of the 4-row bundle
    table, starting with rows 3 and 4 (security · data · scope · adversarial · reliability · performance —
    merge their fired members into one agent first, since they are the largest rows and yield the biggest
    single reduction), then row 2 (testing + learnings) if still over 5, then absorb standards and agent-native into the
    mandatory-pair agent (row 1) last. Stop merging as soon as the agent count is ≤5 — do not merge further
    than the cap requires.
  - `[unsourced]`: whether a per-lens agent can read a diff past ~800 lines in full within its ~40-call tool
    budget. The effort floor and per-file coverage rows below surface it when an agent runs thin — report a
    thin pass as partial coverage rather than assuming the read happened.

Diff size never lowers the lens-bundle count from the ≤200 table; past 200 lines it can only raise the agent
count, up to the 5-agent ceiling.

## Per-file coverage, checked against the diff

Once there is more than one agent, every brief carries **its own explicit file list** — never "read the
diff" unqualified. Its reply's short summary (not the findings JSON) ends with one row per assigned file:
`<path>: full | skimmed | skipped — <reason>`. Skimmed and skipped both need a reason; "ran out of turns" is
a valid one, "looked simple" is not.

The caller unions every agent's file rows and diffs that union against `git diff --name-only`. Any path
missing from the union, or marked skimmed/skipped, is a coverage gap — carry it into the verdict's coverage
line (below), never drop it silently.

## Effort floor

Fewer tool calls than a third of an agent's assigned file count is a thin pass, not a review — an agent
handed 12 files and making 3 tool calls did not read them. Read the count from the agent's own completion
notice. On a thin pass, re-dispatch that agent once with the same file list; if it is still thin, report the
gap as partial coverage rather than silently accepting a skim as done.

**Model per lens agent (WP-128).** Pipe each lens agent's brief to `node ../wt-shared/scripts/model-route.mjs pick --json --skill
<lens agent name> --role reviewer`; when its `apply` is a tier (live routing), pass it as that Agent call's `model`. When
`apply` is null (shadow or off, the default), leave `model` unset. A hook cannot set it, so this is the only place it gets set. Keep its `ref` (`--json` prints it even in shadow) and,
once you have judged that agent's output, record it (WP-215): `node ../wt-shared/scripts/model-route.mjs outcome <ref> ok`
when you accept it as returned, `… outcome <ref> send-back "<why>"` when you re-dispatch it or redo its work yourself.

**Send-back marker (WP-128).** In diff mode on a local board ticket, when a confirmed finding sends the work back to
its author, record it so routing can learn: take the last `ref` from the ticket's `routing: … ref <run#i>` comment and
run `../wt-ticket/scripts/wt-ticket comment <ID> "routing: send-back <ref> — <one-line why>"` and
`node ../wt-shared/scripts/model-route.mjs outcome <ref> send-back "<why>"`. No routing comment → skip both. Two
send-backs or returns escalate the ticket's next handoff to opus (live routing only).

**Dispatch every agent in one message.** Queueing dominates a multi-agent step — on a measured run, waiting
on reviewer scheduling cost more than the reviewing. A lens dispatched in its own turn adds its whole
scheduling wait to the run, which is the real argument for bundling. It is not a token argument.

**Do not accept a lens list from the caller** unless they name a reason the triggers cannot see. The rule
exists so the sizing is repeatable rather than a mood.

## What reviewers are told

Each brief carries the target (they read it themselves — do not paste it), the findings table, the
`[unsourced]` list or the plan path, their disjoint surface where one applies — in diff mode with more than
one agent, an explicit file list (§ Per-file coverage) rather than "the diff" — `references/reviewer-contract.md`
(every reviewer follows it: confidence, evidence, `suggested_fix`, the false-positive list, intent mismatch,
the tool budget, `residual_risks`/`testing_gaps`), and one instruction that shapes everything:

> Research has already run — its findings table is measured, not remembered. **Do not re-derive the
> research:** verify the `[unsourced]` claims, check the reasoning, and challenge a cited finding only if you
> have reason to think the evidence does not say what the target says it says. This scopes to the *research*,
> never to the code. In diff mode, read the actual files you are assigned, trace a suspicious call to its
> callers, and read whole functions rather than the hunk alone — a hunk shows what changed, not what the
> function now does.

And one prohibition:

> A decision labelled `settled:` was made by the user. Challenge it only as **infeasibility** — that it
> cannot work — never as preference. If you would have chosen differently, that is not a finding.

In diff mode, add the plan's Definition of Done and one more line:

> Work that does not meet the Definition of Done is a finding. Work beyond it is also a finding.

**Every brief keeps an open-ended core, in these or equivalent words, regardless of anything else in it:**

> Read every file assigned to you in full. Report anything wrong you find — not just what any targeted
> question below asks about.

A targeted question (a specific claim to verify, a specific risk to check) is an addition to that core,
never a replacement for it. A brief that is only targeted questions is how a reviewer stops reading a file
the moment its question is answered.

### Every reviewer writes JSON, not prose

**Tell each agent to append its findings to `<scratchpad>/findings/<lens>.json`** and to return only a short
summary in its reply — plus its `residual_risks` and `testing_gaps` arrays (`references/reviewer-contract.md`;
empty arrays are a legitimate, common reply, state them rather than omit the keys). One array, one object per
finding:

```json
[{ "lens": "correctness",
   "title": "arm() awaits the handshake with no timeout",
   "detail": "What is wrong, and the concrete failure it produces.",
   "file": "src/auth/otp-autofill.ts",
   "line": 78,
   "related": ["src/auth/__tests__/otp-autofill.test.tsx"],
   "severity": "high",
   "confidence": 75,
   "evidence": "line 78: `await handshake()` has no timeout or AbortController wrapping it",
   "suggested_fix": "wrap the call in Promise.race with a timeout, or pass an AbortSignal it can honour" }]
```

**An intent-mismatch finding (`references/reviewer-contract.md`'s own finding type) sets `"type":
"intent-mismatch"`** alongside the usual fields — omit `type` for every ordinary defect finding. This is the
field the verdict word (below) reads mechanically to apply its intent-mismatch Send-back trigger; a reviewer
that writes the prose but not the field leaves that finding unable to force a Send back.

`file` and `line` are **the location the finding is about** — in plan mode that is usually the plan itself
(`docs/plans/….md`, and the line in it), in diff mode a source file. `related` names the paths where a
*refutation* would live: the test that pins the string, the caller, the doc that contradicts it. A finding
with no `related` is the one most likely to come back unverifiable. `confidence`, `evidence` and
`suggested_fix` are required on every finding, every lens, both modes — `references/reviewer-contract.md`
defines them (the confidence scale, what counts as evidence, why a fix idea is owed). A finding under 50
confidence does not belong in this file at all; it is a lead for the reviewer to verify or drop before
returning.

This is the difference between the judgments being used and not. A panel that returns prose leaves the caller
to retype eighteen findings into an array before `dedupe` or `verify` will run, so it reads them by hand
instead — observed, on a real run where the full three-agent panel returned prose and neither judgment was
invoked. Collecting the files costs nothing:

```bash
cat <scratchpad>/findings/*.json | jq -s 'add' > <scratchpad>/findings.json
```

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

Before returning, deduplicate. `../wt-shared/scripts/wt-judge.mjs dedupe <findings.json>` compares every pair and groups
them transitively, so A~B and B~C come back as one group rather than two pairs you must merge yourself:

```bash
node ../wt-shared/scripts/wt-judge.mjs dedupe <scratchpad>/findings.json --json
```

Exit 3: deduplicate by reading, as before. The threshold is 0.6 and deliberately asymmetric — a false merge
silently drops a real finding, while a false split costs one duplicate line.

## Optional, ADVISORY: where a lens should read first

`wt-judge.mjs attention <diff> --lens <name>` ranks the diff's hunks by whether that lens would find
something in them. It ranks; **it does not decide what you read.**

```bash
node ../wt-shared/scripts/wt-judge.mjs attention pr.diff --lens correctness
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
node ../wt-shared/scripts/wt-judge.mjs verify <scratchpad>/findings.json [--rev <sha>] --json
```

**Both modes.** `--rev` reads each cited file at that commit and is for diff mode; without it the working
tree is read, which is what plan mode needs — a finding citing `docs/plans/….md:88` is checked against the
plan as written, exactly like one citing a source file. The reviewers already wrote `file`, `line` and
`related`, so this is a pipe, not a transcription job. A finding whose answer lives in a file nobody supplied
comes back unverifiable, correctly.

**Exit 3 means no key: verify by reading, through the independent validator below** — the contract is
unchanged, the tool is the fast path to it, never the reason for it. And the tool is a filter on findings you
already have, never a substitute for finding them: on that same run it confirmed at 60% a finding a pinning
test refutes, with the test in front of it. Read the number.

## Independent validation for high and medium findings

**One fresh agent — no history in this review, not the one that ran or dedup'd it — re-checks every merged
`high` and `medium` finding before it is returned.** The reviewer that found it is not the one who gets to
confirm it stands; that is the same conflict a `settled:`-label check exists to prevent elsewhere in this
skill, applied to the review's own output instead of the target's.

This is the default path when `wt-judge.mjs verify` exits 3 (no key) — the caller does not self-verify by
reading its own dispatched findings, which is exactly the confirmation bias a second, fresh agent removes.
When a key is present, `wt-judge.mjs verify` still runs first (it is cheaper and catches the easy cases); the
independent agent then re-checks whatever it left `confirmed` at `high`/`medium`, not the ones it already
refuted.

The validator gets the finding (title, detail, `file`, `line`, `evidence`, `related`) and nothing else from
the review that produced it — no other lens's findings, no summary, no hint at the verdict. It opens the cited
file itself and decides `confirmed`, `refuted`, or `unverifiable`, the same three states as above.

**To reject (`refuted`) a finding that describes a security hole or data loss — from any lens, not only the
`security` lens itself — the validator must cite the specific `file:line` that contradicts it.** "Looks fine"
or "seems unlikely" is not a rejection — an unresolved doubt about a security or data-loss finding stays
`confirmed` or moves to `unverifiable`, never silently drops to refuted on a validator's unsupported hunch.
Every other finding may be refuted on the validator's read of the file without this extra bar.

Findings ranked most-severe first. Each one: what is wrong, the concrete failure it produces, where, and its
verification state.

Each run prints `run <id>`. **When you later find a judgment was wrong, say so** —
`node ../wt-shared/scripts/wt-judge.mjs mark <run>#<i> yes|no` — using the observed outcome,
never a second opinion from the same model. That log is the only thing that moves the thresholds.
Deduplicate across lenses before returning — two agents finding the same thing is one finding, and reporting
it twice inflates the apparent yield of a bigger panel.

State plainly which mode ran, which lenses ran, and which triggers fired. A caller cannot tell a clean
target from a narrow review otherwise.

## Verdict word

The verdict's **first line** is exactly one of **Approve**, **Approve with fixes**, or **Send back** — nothing
else on that line. Compute it from the merged, verified findings and the coverage state:

- **Send back** — any confirmed `high`-severity finding, a confirmed finding with `"type": "intent-mismatch"`
  (§ "Every reviewer writes JSON, not prose"), or partial coverage (below).
- **Approve with fixes** — no `high`/intent-mismatch/coverage reason to send back, but at least one confirmed
  `medium` or `low` finding.
- **Approve** — no confirmed findings at any severity, and coverage is complete.

A `refuted` or `unverifiable` finding never on its own forces Send back or Approve with fixes — only a
`confirmed` one does. The coverage line (below) always follows the verdict word as the last line; it never
replaces it.

**A Send back driven only by coverage, with no confirmed finding, is not the same as a Send back for a
defect** — say which one it is in the reply. A caller maps them differently: `wt-watch-prs` posts a defect
Send back as a hold (`--request-changes`) but a coverage-only Send back as a plain comment naming the gap,
because an unread file is neither a question nor a defect (see its §3).

## Coverage line in the verdict

The verdict's last line is always: `Coverage: N/M files read in full · lenses: <fired lenses> · tests:
run|not run (CI relied on)`. M is `git diff --name-only`'s count (or 1, undivided, in single-target plan
mode); N is how many of those came back `full` in the § Per-file coverage union — a file one agent skimmed
after another already read it in full still counts full. **Partial coverage (N < M) is stated, never rounded
up, and the verdict cannot be an approval while it holds** — it is a send-back for coverage, the same as a
send-back for a confirmed finding.
