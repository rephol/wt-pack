# wt-pack

A worktree-based coding loop as Claude Code skills: research → plan → work →
simplify → review → ship → babysit → compound.

Each directory under `skills/` is one skill. `skills/wt-shared/` is not a skill — it holds the scripts
the others invoke by path.

What every feature does, where it lives and its defaults: [docs/features.md](docs/features.md).

## Install

The repo is private, so log in to GitHub first (`gh auth login`), then:

    gh repo clone rephol/wt-pack ~/Work/projects/wt-pack && ~/Work/projects/wt-pack/setup

`setup` links every `wt-*` skill into `~/.claude/skills`, installs the wt-memory plugin, builds the
dashboard and runs it under launchd (macOS), then prints a doctor report. It asks once before installing
missing Homebrew packages (`--yes` skips the question) and never repoints an install that belongs to
another checkout. Re-running it changes nothing. Also:

    ./setup doctor       # what is missing, one line each; exit 1 while a required check fails
    ./setup secrets      # optional TypeSafe key (Linear: dashboard Settings › Integrations)
    ./setup uninstall    # service, plugin, links; keeps data and keys (--purge deletes dashboard data/config)

Inside Claude Code, "set up wt-pack" runs the `wt-setup` skill, which drives the same script. Linux works
without launchd, Keychain or the Tauri app (doctor lists what to do by hand).

## The optional judgment layer

`skills/wt-shared/scripts/wt-judge.mjs` turns decisions the pack otherwise eyeballs
into typed, logged judgments via the TypeSafe System One API. **It is optional
and unconfigured is the normal case**: every caller treats exit 3 (no
`TYPESAFE_API_KEY`) as "do what the pack always did", never as an error.

The key comes from `TYPESAFE_API_KEY` or a line in `~/.claude/.env`. The
judgment log (`~/.claude/wt-judge-log.jsonl`) and any calibrated thresholds stay
on the machine that produced them — they are observations, not source.

Two of its subcommands ship ADVISORY and print their own falsification: they
rank what to read but never shrink the surface, and promoting one requires
marked outcomes showing the bottom of its ranking was really empty.
