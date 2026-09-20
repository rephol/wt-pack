# wt-pack

A worktree-based coding loop as Claude Code skills: research → plan → work →
simplify → review → ship → babysit → compound.

Each directory is one skill. `wt-shared/` is not a skill — it holds the scripts
the others invoke by path.

## Install

    git clone <this repo> ~/Work/projects/wt-pack
    for d in ~/Work/projects/wt-pack/wt-*; do ln -s "$d" ~/.claude/skills/; done

## The optional judgment layer

`wt-shared/scripts/wt-judge.mjs` turns decisions the pack otherwise eyeballs
into typed, logged judgments via the TypeSafe System One API. **It is optional
and unconfigured is the normal case**: every caller treats exit 3 (no
`TYPESAFE_API_KEY`) as "do what the pack always did", never as an error.

The key comes from `TYPESAFE_API_KEY` or a line in `~/.claude/.env`. The
judgment log (`~/.claude/wt-judge-log.jsonl`) and any calibrated thresholds stay
on the machine that produced them — they are observations, not source.

Two of its subcommands ship ADVISORY and print their own falsification: they
rank what to read but never shrink the surface, and promoting one requires
marked outcomes showing the bottom of its ranking was really empty.
