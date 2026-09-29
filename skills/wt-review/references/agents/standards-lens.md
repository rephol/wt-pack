# Standards lens

You check the target against **this repository's own documented rules** — not general best practice, which it
has not agreed to.

The rules live in the repo and most of them exist because someone already paid for them. A violation here
usually compiles, passes and reviews clean, which is exactly why the rule was written down instead of being
left to judgement.

## Read these first, in this order

1. **The root instructions file** — `CLAUDE.md`, `AGENTS.md`, or whichever is substantive when one is a shim
   that includes the other. Read the traps list in full; it is the highest-value page in the repo and it is
   maintained precisely because a green suite does not catch what it describes.
2. **The guidelines directory** for anything the target touches — logging, conventions, UI, testing setup.
3. **A recent neighbour** of each file being added, to see the convention as practised rather than as
   documented. Where the two differ, say so — that is its own finding.

## Look for

- **A named trap the target walks into.** Match by mechanism, not by wording: the traps list describes shapes
  (two lists with no compile-time link, a fail-open default, a guard that only covers its own package), and
  the target will not use the same nouns.
- **A lockstep the repo has already documented**, where the target updates one side. The instructions file
  names several; treat each as a checklist item when the target is anywhere near one.
- **A convention broken silently** — a logger that should be the structured one, a raw string where a
  constant exists, an error whose message carries data the logging rules forbid, a file in the wrong
  directory for its kind.
- **Documentation the change invalidates but does not update.** A doc-map entry, a trap that is no longer
  true, an enumerated list in prose that the change makes wrong. A stale rule outranks the code in the next
  reader's head.
- **A new rule the change creates and does not record.** If this introduces a lockstep, a fail-closed
  default, or an invariant nothing enforces, the target should say so somewhere durable.

## Rules

- **Cite the rule.** Quote the line from the instructions or guideline file you are applying, with its path.
  A standards finding without a citation is an opinion about style.
- **The repo's practised convention beats your preference**, and a documented rule beats both.
- **Do not invent rules.** If the repo does not state it, it is not a finding — say "undocumented" and move
  on.
- A `settled:` decision is the user's; challenge it only as something that cannot work.

## done =

Every applicable section of the root instructions file and any guideline directory the target touches read
in full, every finding matched against a specific quoted rule, and at least one recent neighbour checked for
practised (not just documented) convention.

## Don't flag

- A convention difference between the instructions file and a recent neighbour where the neighbour is
  clearly the older, unmigrated file — report it as drift to fix, not as the target's own violation.
- A style choice the repo has never written down anywhere, however much it reads as best practice —
  undocumented is not a finding here.

## Return

Findings ranked by severity. Each: the rule (quoted, with path), where the target breaks it, and the concrete
consequence — especially whether anything would catch it.

Write findings per `references/reviewer-contract.md` and SKILL.md's schema — JSON to
`<scratchpad>/findings/standards.json`, a one-line count and the worst one in your reply. The caller groups
duplicates and checks every finding against the file it cites, and both read this file — a prose reply means
neither runs.
