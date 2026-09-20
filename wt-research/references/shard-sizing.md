# Shard sizing

## Floor

Two. Surface and blindspot, always, however small the change. The temptation on a one-file ticket is to run a
single agent with both questions — that is exactly the merge the blindspot shard exists to prevent, and a
small change is where an unnamed second caller hides best.

## Ceiling

Four. Past that, shards start overlapping surfaces no matter how the brief is written, and the consolidation
cost exceeds what the extra shard returns.

## Splitting the blindspot sweep

Only when the change crosses three or more packages, and only with **disjoint roots stated in each brief**
(`packages/**`, `apps/main-website/**`, `apps/api/**`). Two shards reading the same file is the failure this
whole scheme is built to avoid: it doubles the cost and returns one answer.

## The dependency shard

Dispatch when the change depends on what an installed library actually does. Its reading surface is
`node_modules` — the shipped types and dist, not the published docs and not memory. Version-specific behaviour
is where plans go quietly wrong, and the docs describe a version you may not have.

Skip it when the change touches only first-party code. It has nothing to read.

## What the blindspot shard should be pointed at

The indirection layers, because that is where the expensive misses live — files that act on the change
without mentioning it:

- **Config that filters or scans.** Content globs, include sets, ignore lists, task `inputs`. A file can be
  seen by one tool and invisible to another, and nothing errors.
- **A second copy of the same list.** A constant restated in another component, a client mirroring a server
  allowlist. The compiler links neither.
- **Alias and shim files.** An overlay, a barrel, a compatibility map. These reference by path, so a rename
  breaks them silently from a file the diff never opens.
- **Allowlists and enumerated assertions in tests.** A hardcoded list of names is a lockstep nobody declared.
- **Config that exists at two levels.** A root override and a package override of the same task; which one
  wins is not visible from either file alone.

## Anti-pattern

Sizing by ticket size. A four-file ticket can have a five-file blast radius, and a twenty-file refactor can be
mechanical. Size by **how many distinct reading surfaces the change has**, which is what the shard split
already encodes.
