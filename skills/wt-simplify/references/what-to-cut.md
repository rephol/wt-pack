# What to cut

Three dimensions. They find different things, so run all three over the diff rather than making one pass and
calling it done.

**Readable and explicit beats compact. Fewer lines is not the goal**, and net lines removed is not the
measure of a good pass.

---

## Reuse — this already exists

The expensive category, because the reimplementation looks correct.

- **A helper that already existed.** Search by behaviour, not just by name — a repo usually calls this thing
  something you would not guess. Prefer the existing one even when yours is nicer: two helpers for one job
  *is* the cost.
- **A standard-library or runtime primitive.** Only when behaviour-equivalent for the inputs actually in
  play. Skip any swap with locale, sort-stability, precision or serialization differences.
- **A guarantee the platform, framework or a downstream layer already provides**, hand-maintained here. Name
  the provider. Remove only what that guarantee directly owns, and keep every value transformation that
  happens before it.

## Quality — this is awkward

- **The same pattern three times.** Two is a coincidence. Read all three before extracting: they are often
  not the same thing, and a helper that flattens a real difference is a defect, not a cleanup.
- **Redundant state** — state duplicating other state, a cached value that could be derived, an effect or
  observer that could be a direct call.
- **Parameter sprawl** — a new parameter bolted on where restructuring the existing ones was the change.
- **Stringly-typed code** where a constant, union or branded type already exists in the codebase.
- **Leaky abstractions** — internals exposed, or an existing boundary broken to get at something.
- **Conditionals nested three or more deep.**
- **Comments that restate the code, narrate the change, or preserve task history.** Keep the ones carrying a
  non-obvious constraint or invariant — those are the expensive ones to lose.
- **Conversation-bound vocabulary.** Names that made sense during the session — `newHandler`, `v2Thing`,
  `parsed2` — and mean nothing to a reader. Rename toward the codebase's established terms; preserve precise
  domain terms exactly.
- **Scaffolding a later unit made dead.** A type, flag, intermediate shape or branch unit 1 needed and unit 4
  removed the need for. It still compiles and is still tested, which is why nobody notices. Ask of each new
  symbol: who calls this *now*?
- **A shape forced by an approach that changed mid-run** — an indirection with one implementation, a
  parameter every caller passes the same value for, a wrapper that no longer wraps. Reads as design, is
  residue.

## Efficiency — this wastes work

- **Redundant work** — recomputation, repeated file reads, duplicate calls, N+1 patterns.
- **Missed concurrency** — independent operations run in sequence. (The same rule this pack applies to its
  own tool calls.)
- **Hot-path bloat** — new blocking work added to startup, per-request or per-render paths.
- **Existence checks before acting** — `if exists then open` is a race; operate and handle the error.
- **Unbounded growth and missing cleanup** — a map that only ever gains keys, a listener never removed, an
  object URL never revoked.
- **Overly broad operations** — reading a whole file for one field, loading every row to filter for one.

---

## Dead code, carefully

Verify project-wide non-use with real analysis or a structural search, and account for re-exports, dynamic
imports and framework-conventional exports. **If uncertain, skip it.**

Two traps worth naming:

- **A branch made reachable by removing a guard is not dead code.** It is newly live, and deleting it changes
  behaviour.
- **Compatibility scaffolding for a shape that only ever existed inside this unshipped branch** is fair to
  remove — but only after confirming nothing deployed, persisted, public, external or on a dependent branch
  consumes it, and only when every caller update fits inside the diff you are allowed to touch.

## Not this step's work

- **Renaming for taste.** Adds review surface, finds no defect. (Conversation-bound names are a different
  thing — those are genuinely unreadable.)
- **Restructuring a file the change barely touched.** The diff is the scope.
- **Anything that changes behaviour**, including "obviously equivalent" rewrites of a guard.
- **A duplication or separation the plan settled deliberately.** It stays.
- **Performance work beyond the list above.** Different question, different evidence, different review.
- **Adding an abstraction because a second case might come.** Two is not three.
