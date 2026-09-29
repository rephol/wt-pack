# Agent-native lens

Triggered when the target changes SKILL.md prose, a prompt, handoff or wt-message text, or MCP tool
descriptions — anything whose reader is an agent, not a human running the code.

An agent reads this the way it reads everything: once, linearly, without the chance to ask a clarifying
question mid-task. A human reader who hits ambiguous prose slows down and re-reads; an agent picks the first
plausible interpretation and keeps going.

## Look for

- **An instruction an agent will plausibly misread.** Two valid readings of the same sentence, a step that
  assumes context the agent was never given, an example whose specifics do not match the rule it illustrates.
- **A script path that is not sibling-relative.** CLAUDE.md is explicit: never write the setup-install home
  path (the tilde-expanded `.claude/skills` link) into scripts, sent strings or SKILL prose — a skill
  installed via the plugin path has no such directory. Grep the changed prose for that literal string, per
  `skills/wt-shared/scripts/paths.test.mjs`'s own pattern.
- **Ambiguity between a user message and wt-message traffic.** Prose telling an agent how to tell the two
  apart that is itself ambiguous, or a new message kind introduced without saying which channel answers it.
- **A lockstep copy this change should have updated and did not.** The same trigger table, schema or list
  restated in a second file — this pack warns about exactly this (`wt-ship/SKILL.md:68-71` on the sizing
  table). A prompt that duplicates another file's content is a second copy with nothing to fail when it
  drifts.
- **An instruction that only works if read in a specific order**, when nothing enforces that order — a step
  that references "the file list above" inside a section an agent could plausibly jump to directly.
- **A tool or MCP description that promises behaviour the implementation does not have**, or omits a
  precondition the implementation actually requires.

## Rules

- Read the changed prose as a first-time agent would — do not fill gaps with context only a human author has.
- Grep beyond the changed file for a lockstep copy; a prompt's drift risk is invisible from the file alone.
- A `settled:` decision is the user's; challenge it only as something that cannot work.

## done =

Every changed instruction, prompt or tool description read as a first-time agent reader would, a grep run for
the setup-install home path and for any lockstep copy elsewhere in the pack, and every message-kind or
channel reference checked against how the pack actually routes it.

## Don't flag

- A skill's own README-style background section that a human maintainer reads but an agent never executes —
  ambiguity there does not reach agent behaviour the way ambiguity in an instruction step does.
- An example that simplifies the general rule for readability, when the general rule itself is stated
  precisely elsewhere in the same file — the example is illustration, not the contract.

## Return

Findings ranked by severity. Each: the instruction, the plausible misreading or drift, and the concrete
consequence for an agent following it.

Write findings per `references/reviewer-contract.md` and SKILL.md's schema — JSON to
`<scratchpad>/findings/agent-native.json`, a one-line count and the worst one in your reply. The caller groups
duplicates and checks every finding against the file it cites, and both read this file — a prose reply means
neither runs.
