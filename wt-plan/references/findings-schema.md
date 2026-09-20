# Findings schema — the pack's shared contract

Every research shard returns **records**, never a report. `wt-plan` absorbs them into the plan and `wt-review`
verifies against them, both inside the planning session. `wt-work` never sees the table — it reads the
evidence the plan quotes.

## The record

```
F-07
claim:      one sentence, falsifiable
verdict:    confirmed | disproved | unknown
evidence:   path/to/file.ts:142 + a verbatim quote of the lines that decide it
confidence: high | medium | low
```

- **`id` is stable** and never renumbered. The plan cites it; a renumber silently re-points a citation.
- **`verdict: unknown` is a real answer.** A record that says "could not determine" is more useful than a
  paragraph that hedges, because the plan can mark the claim `[unsourced]` honestly instead of rounding up.
- **`evidence` quotes.** A path alone is an assertion about a file; a quote is the file speaking. A shard that
  cannot quote has not verified.
- **`confidence: low` with `verdict: confirmed`** is legitimate — it means "the code says this, but I could
  not rule out a path that contradicts it."

## The table is working material, not a deliverable

It lives in the session scratchpad. The **plan** is the artifact that gets committed, and the findings are
**absorbed into it** — not referenced from it.

Absorbing means: where a load-bearing assertion rests on a finding, the plan states the evidence **inline** —
`src/policy.ts:21` plus the words that decide it. Not `(F-07)`. A citation pointing at a file the implementer
does not have is worse than no citation: it reads as evidenced while being unverifiable, and the implementer
re-derives it anyway.

Load-bearing means: if it were false, the plan would change. Everything else needs no evidence.

An assertion with no finding behind it is written `[unsourced]` inline, where it sits — not footnoted, not
collected in an appendix. The marker makes an unverified claim visible at write time, when it costs one line
to check, instead of at review time, when it costs an agent.

Ticket text is not evidence. A claim carried from the ticket with no shard behind it is `[unsourced]`, however
confidently the ticket states it.

**Revise the plan against the findings before committing it.** A `disproved` record usually invalidates
something the plan inherited from the ticket; that revision is the point of researching first, and it must
land in the plan rather than in a note beside it.

## What this does not do

It does not catch plan errors — a decision that targets the wrong file, a count that does not sum, a heading
that contradicts its body. Nothing structural prevents those; the self-trace and a feasibility lens do.
Measured on UMK-690, that class was the majority of what review found. Do not expect this schema to shrink it.
