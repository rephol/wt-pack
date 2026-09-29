# Performance lens

Triggered when the target touches a polling interval, a render loop, work done per tick, or an unbounded
read.

The worked example: a tray icon rebuilt on every 4-second tick regardless of whether anything changed
(WP-146). Nothing about that code was wrong in isolation — it was correct on every tick, and the defect was
purely in how often "every tick" runs real work.

## Look for

- **Work repeated every tick that only needs to run on change.** A rebuild, a re-render, a re-fetch gated on
  a timer instead of on the thing actually changing. Ask what would make this tick a no-op, and whether the
  code takes that path.
- **A polling interval with no justification for its value.** Not "too fast" in the abstract — check what the
  interval costs (a network call, a DB query, a full re-render) against what changes that fast in practice.
- **An unbounded read.** A file, log, or query with no limit, page size, or cutoff — correct at today's data
  size, silently worse as it grows.
- **N+1 inside a loop the diff adds or touches.** A query or call made per item where a batched form exists
  or is easy to add.
- **A render or effect with a dependency list broader than what it actually reads**, causing it to re-run on
  unrelated state changes.
- **Work done synchronously that blocks a loop or a caller for no reason** — a computation that could be
  deferred, batched, or moved off the hot path but currently sits directly in it.

## Rules

- Quantify before flagging: name the interval, the data size, or the call count that makes it a real cost —
  "this could be slow" without a number is not a finding.
- Verify the code actually runs on the path claimed; a cold-start-only computation is not a hot-path finding.
- A `settled:` decision is the user's; challenge it only as something that cannot work.

## done =

Every changed timer, loop, render path and unbounded read in the target checked against what actually
triggers it, with a concrete cost (call count, data size, or frequency) attached to each finding rather than
a general "could be slow."

## Don't flag

- A poll or rebuild interval that already gates on a cheap comparison before doing real work (a hash check,
  a dirty flag) — the tick itself is not the cost; verify what runs inside it before flagging the interval.
- An unbounded read over data this codebase's own scale makes bounded in practice (a config file, a fixed
  small list) — unbounded is only a finding where the size can actually grow.

## Return

Findings ranked by severity. Each: the hot path, the concrete cost, and what triggers it.

Write findings per `references/reviewer-contract.md` and SKILL.md's schema — JSON to
`<scratchpad>/findings/performance.json`, a one-line count and the worst one in your reply. The caller groups
duplicates and checks every finding against the file it cites, and both read this file — a prose reply means
neither runs.
