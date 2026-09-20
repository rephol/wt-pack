# Discoverability, vocabulary, and stale neighbours

**A knowledge store compounds value only when agents can find it.** A learning nobody retrieves is worth the
same as one nobody wrote, and costs more — it makes the store look fuller than it is.

Three checks, after the document is written.

## 1. Would anyone find this?

Read the repository's root instruction file — `CLAUDE.md`, `AGENTS.md`, or whichever is substantive when one
is a shim that includes the other. Ask whether an agent starting work in this area would learn:

- that a searchable store of documented solutions exists,
- roughly where it lives,
- that it is worth searching **before** starting, not after being surprised.

If all three are already true, do nothing. If they are not, **ask before editing an instruction file** — it
is the most-read file in the repo and it is the user's. Propose one line, in their file's voice.

The other half of findability is the title, and that is decided when the document is written: **name the
failure, not the incident.** Someone searching arrives with a symptom, never with your ticket number.

## 2. Does a word need defining?

Many repositories keep a vocabulary file — `CONCEPTS.md` or similar — for words that mean something specific
here. Two kinds of term belong in it, and only one of them arrives by itself:

- **Accretion** — a term this learning had to explain because its meaning was not obvious. Friction surfaced
  it. This reliably catches *peripheral* terms.
- **Seeding** — the **core domain nouns** of the area you just worked in. These never arrive by accretion,
  precisely because they are stable: the nouns a system is built around rarely break, so they rarely appear
  in a learning, yet they are exactly what a newcomer needs first. Without seeding, a glossary fills with
  obscure mechanics and never names what the project is about.

Scope it to the area you actually investigated. Do not trawl the repo, and do not define a term you did not
verify against code. Be opinionated: where the team uses several words for one concept, pick one and record
the others as aliases rather than preserving every word anyone ever used.

## 3. Did this just make a neighbour wrong?

A new learning sometimes invalidates an older one. **This is not a routine follow-up** — most runs have no
stale neighbour, and going looking for one is how a targeted step turns into a documentation review.

Worth acting on when:

- an existing document recommends what this work just showed to be wrong,
- this supersedes an older documented solution outright,
- a rename, migration or dependency upgrade in this change invalidated its citations.

Not worth acting on when no related document was found, when the overlap is superficial, or when confirming
it would need a broad historical sweep on weak evidence.

**Capture the new learning first, always.** A stale neighbour is maintenance; the thing in your hands right
now is perishable. If there is one obvious candidate, fix it with a narrow scope. If there are several, say
so and let the user choose rather than expanding this run into a sweep.
