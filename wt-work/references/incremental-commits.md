# Incremental commits

After each unit, decide whether to commit.

| Commit when | Don't when |
|---|---|
| A logical unit is complete | It is a small part of a larger unit |
| Tests pass and progress is meaningful | Tests are failing |
| About to switch context (backend → frontend) | It is scaffolding with no behaviour |
| About to attempt something risky or uncertain | The message would be "WIP" |

**Heuristic:** can you write a message describing a complete, valuable change? If yes, commit. If it would be
"WIP" or "partial X", wait.

The plan's units are the starting guide for commit boundaries — adapt from what you find. A unit may need
several commits if it is larger than expected; small related units may land together. Use each unit's goal to
inform the message.

## Workflow

```bash
# 1. verify tests pass, using the project's own test command
# 2. stage only the files belonging to this logical unit — never `git add .`
git add <files for this unit>
git commit -m "type(scope): what this unit does" -- <those same files>
```

Follow the repository's commit conventions; many lint the subject line. Incremental commits carry clean
conventional messages and no attribution footers.

**Resolve conflicts immediately** if rebasing or merging mid-run. Small focused commits are what makes that
cheap, which is most of the reason for committing this way.

## Why this is not just tidiness

`wt-ship` reads the whole diff once, for simplification and review together. A diff made of coherent commits
is reviewable; one giant commit forces the reviewer to reconstruct the units, and findings land on the wrong
thing.
