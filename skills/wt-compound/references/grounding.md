# Grounding: verify the claims before they compound

**This is the step that makes the difference between a knowledge store and a rumour mill.**

What you write becomes permanent, trusted knowledge. The next agent will act on its claims **without
re-verifying them** — that is the entire value of writing it down, and it is also the risk. A wrong claim
here does not stay one wrong claim: it is read as established fact, cited by the next document, and compounds
exactly as fast as a right one.

So every factual claim gets checked against reality before the document lands. Not because the claims are
probably wrong — because nobody downstream will check them again.

## Two claim types verify against two different trees

- **Code-behaviour claims** — enum values, defaults, limits, ordering, state transitions, "X calls Y".
  Verify against the **local working tree**, and quote the defining line with `file:line`. The quote is the
  evidence; a path alone is an assertion about a file.
- **Merge-state claims** — "fixed in #1608", "landed", "shipped in". Verify against **remote truth**
  (`gh pr view <n> --json state,mergedAt`). The local checkout may predate the merge, so local reachability
  is the fallback, never the primary. `git fetch` first, best-effort — offline is a degraded check, not a
  failure.

## What to look for, and what each one means

| Symptom | What it usually is | Do this |
|---|---|---|
| Cited path does not exist | Drafted from memory, or a typo | Fix the citation, or drop the claim |
| Path gone, prose says "removed by this fix" | A legitimate historical citation | Keep — but confirm the prose marks it historical |
| Commit SHA reachable from `HEAD` only | A local commit; **the SHA will change on squash merge** | Replace with the PR number |
| SHA exists but is unreachable | Rebased away | Replace with the PR number |
| `Learning 3`, `{{…}}`, `<placeholder>` | Drafting scaffold leaked in | Always fix |
| A count — "six sites", "all N consumers" | Often written before the enumeration finished | **Count what the document actually substantiates**, and restate to match |
| Broken relative link | Wrong target | Fix the path |

A cited SHA is the one most worth re-checking: this repository squash-merges, so a SHA that resolves today
frequently resolves to nothing once the PR lands. **Prefer a PR number to a SHA in anything durable.**

## Verdicts

- **Contradicted** → fix the document from the quoted evidence. The quote is authoritative, not your memory
  of the session.
- **Unverifiable (behaviour)** → soften and attribute — "per this session's conclusion" — or cut it. Do not
  promote a conclusion to a fact because it felt settled at the time.
- **Unverifiable (merge state, offline)** → keep with an as-of qualifier and **say the verification was
  degraded**. A reader can discount a dated claim; they cannot discount one they think was checked.
- **Short** (a count that does not add up) → complete the enumeration or restate the number.

## The rule underneath all of it

**Never record a guess as a finding.** If the cause was not established, write what was observed and say the
cause is unknown. A document that says "we do not know why" is useful and honest; one that names a plausible
cause that was never tested teaches the next person something false, with the full authority of the store
behind it.

Measured in this pack: a fabricated CLI flag was written into a skill beside the words "measured
consequence", survived three sessions, and was believed because the surrounding facts were real. That is the
failure this step exists to prevent, and it is cheap to prevent — one command would have settled it.
