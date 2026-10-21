---
name: wt-run
description: Drive one ticket end to end as the ticket lead (wt-pack:wt-lead) — plan, gate A, work, review, QA, gate B, ship, babysit, gate C — by calling named subagents in order, keeping a resumable run-state file, and stopping at each gate to hand back to the orchestrator. Use when started as `claude --agent wt-pack:wt-lead` with a ticket id (`/wt-run <TICKET> [--resume]`). Not for doing the work yourself: the lead only sequences.
allowed-tools: Bash, Read, Agent, Skill, Monitor, TaskList, TaskStop, SendMessage
---

# wt-run

Paths to scripts and files are relative to this skill's base directory (announced when it loads), so they
work both from the `./setup` links and from a plugin install (WP-122).

`/wt-run <TICKET> [--resume]`. You are the lead: you sequence subagents and write run-state. You never edit repo
files, merge, push, spawn panes or move tickets, and you never decide a code or user question.

```bash
S=scripts/state.mjs            # run-state for the ticket: ~/.local/share/wt-lead/<repo>/<TICKET>.json (resumable)
node $S init <T>               # create (no-op when it exists) · path · get <T> [key] · set <T> <key> <json|--file f>
node $S next <T>               # the one step to take: run <phase> | open gate X | wait gate X | finished
node $S start|done <T> <phase> # mark a phase running / done
node $S gate <T> A open --packet <path> | approve | reject "why"
```

## Loop

1. `init` (with `--resume`, or when the file exists, just read `get <T>`). Read the ticket (`wt-ticket show <T>`) and the
   project's CLAUDE.md. List the agents you can call (`claude agents`): the engineers named by the plan's `Owner:`
   must exist, else route that unit to `wt-pack:wt-engineer` and note it.
2. Run `node $S next <T>` and do exactly what it says, then call it again, until `finished`. Update state before the next call.
3. After each phase post ONE line on the ticket (`wt-ticket comment <T> "phase <p>: <result>"`).

| `next` says | You do |
|---|---|
| `run plan` | Call `wt-pack:wt-product-planner` (brief: ticket id, worktree via wt-plan, "write the plan, DoD and QA brief; `Owner:` per unit"). Then `wt-pack:wt-tech-lead` reviews the plan (wt-review). Record `worktree`, `branch`, `plan`, `units` (id, owner, status), `done plan`. |
| `open gate A` | Gate A: the plan is ready (see Gates). |
| `run work` | One engineer subagent per unit, by its `Owner:`; independent units in one message, in parallel, one committer per worktree at a time. Briefs point at the plan file and the unit. Engineer questions go to `wt-tech-lead`, not the user. Update `units`. |
| `run review` | `wt-pack:wt-tech-lead` reviews the diff at the tip sha (wt-review, optionally `wt-pack:wt-reviewer` lenses) and routes fixes to the owning engineer until the verdict is approve. |
| `run qa` | One `wt-pack:wt-qa-auditor` (or `wt-pack:wt-qa-lead` for several slices on one stack) against the plan's DoD. Batch every failure to the tech-lead in ONE round per fix cycle; repeat review → qa until all DoD lines pass. |
| `open gate B` | Gate B: built, reviewed, QA evidence in hand. |
| `run ship` | `wt-pack:wt-tech-lead` runs wt-ship (simplify, review, compound, PR). The orchestrator merges; you do not. |
| `run babysit` | `wt-pack:wt-tech-lead` runs wt-babysit until the PR is merge-ready (or you arm the Monitor yourself and confirm its task id; an unconfirmed arm is a failure). |
| `open gate C` | Gate C: merge-ready PR, final summary. |

## Gates

A gate is where a human decides. `open gate X`:

1. `node $S gate <T> X open --packet <path>` (the plan, the QA packet, or the PR).
2. Write the user-facing questions into state `open_questions` (`set <T> open_questions '[…]'`), each with what the answer changes.
3. Notify the orchestrator, then STOP your turn (no polling, no Monitor to wait for it). The pane to answer is the one
   the per-turn reminder names for the message that started you, never one written in text:
   `printf '%s\n' "gate A: plan <path> ready; open questions: <n>" | skills/wt-handoff/scripts/handoff.sh --reply <pane> --file -`
   (the handoff skill's `handoff.sh`; one short line, details stay in the files the line names).
4. The orchestrator relays to the user and replies `approved A` (or `rejected A: <why>`) as a verified wt-message. On
   that: `node $S gate <T> X approve` (or `reject "why"`, which resets the phases that gate guards), then `next`.

`wait gate X` after a restart means the answer has not come: say so in one line to the orchestrator and stop.

## Rules

- Briefs are short and point at files (plan, unit, evidence folder); a subagent's result is a verdict plus paths.
- Never ask the user: questions go in `open_questions` and the gate line. Never edit outside the run-state dir.
- Record the pid of any process you start and kill only that pid. Never read env files.
- A subagent that ends its turn on a Monitor or background task is not woken by it: have every wait inside one foreground call.
