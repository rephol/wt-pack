# Handoff

## The prompt

Copy this verbatim. Substitute the three angle-bracketed values and change **nothing else**.

```
Use wt-work to implement <plan-path> to its Definition of Done.

Work in <worktree> on <branch>. Do not cd to the main checkout.

Then wt-ship.
```

Emit it in your reply and best-effort copy it to the clipboard. It is three lines: an invocation, a location,
the tail. It reads the same for every plan.

**Write it by substitution, not by composition.** A composed draft named an acceptance criterion and dropped
`wt-ship`, and had to be corrected in the next message. Copying cannot drift; composing does.

Before you send it, check each of these — any yes means cut:

- Does it name a specific command, a file inside the change, a unit id, or an acceptance criterion?
- Does it explain *why* any step exists?
- Does it carry a findings path? The findings were absorbed into the plan in step 5, so the plan already
  holds its evidence inline. A scratchpad path the implementer's session cannot read is worse than nothing —
  it reads as evidence and resolves to a missing file.
- Did `wt-ship` become more than one line? The order inside it (simplify → review → compound → draft PR)
  lives in that skill, where a paraphrase cannot drop the middle steps.
- Does anything follow `wt-ship`? Nothing may — not `wt-babysit`, not `wt-finish`. `wt-ship` offers both at
  the right moment, to the user, who decides.

## What goes in your message instead

Everything the implementer benefits from that is not an instruction goes in the chat reply beside the prompt,
where the user reads it and decides:

- what research corrected about the ticket, and what review corrected about the plan — plainly, as the record
  that stops the next reader re-deriving the same mistake
- the failure shapes the plan cares about, without spelling out the fixes
- the tie-break rule when the plan has already been wrong: a review finding wins on facts about the code, the
  plan wins on settled decisions
- environment state the implementer would misread as their own breakage (a fresh `npm install`, a known-red
  suite)
- anything left stale — most often the ticket, which will not know what research and review discovered

## Handing it to a worker

**When `herdr` is on PATH, always offer** — one line naming the worker and the worktree — **and wait for a
yes.** Spawning an agent that starts writing code is the user's call, never an inference from how the ticket
was phrased. On anything other than a yes, print the prompt and stop. The exception is a standing instruction
to hand off automatically.

Workers live in their own herdr workspace, `<repo>-workers`, so handed-off work never lands among your own
tabs and finished workers are recycled instead of piling up. List the free ones — idle **or done**, sitting
in the repo's **main checkout**; a worker parked inside a worktree is work already in flight:

```bash
~/.claude/skills/wt-plan/scripts/handoff.sh --list <worktree>   # pane-id, worker name, cwd
```

Put that list in the question. With candidates, ask **which worker, and whether to clear it**, and carry a
recommendation rather than leaving it open:

- **A reused worker taking a plan it has not seen → recommend clearing.** Its thread cannot bear on this
  ticket, and an unrelated context is not paid once — every turn of the next run re-processes it.
- **A worker already on this ticket → recommend keeping it.** That context is the whole reason to pick that
  worker, and clearing it buys a re-read of research you have already paid for.

Clearing is not free either: a `SessionStart` memory hook re-injects project context immediately after, so
`/clear` drops the thread rather than emptying the window. With no candidates, the only question is whether
to spawn one.

```bash
printf '%s\n' "$PROMPT" | ~/.claude/skills/wt-plan/scripts/handoff.sh \
  [--pane <id> [--clear] | --new] <worktree>
```

`--pane` prompts that worker; `--clear` sends `/clear` first; `--new` skips reuse and spawns the next worker
(`<repo>-worker-NN`, opened in the worktree) through `agents.sh`, which owns the numbering and the naming. With neither it takes the first free worker itself, so pass one
once the user has chosen. It prints `reused <pane>` or `created <name> <pane>`, or exits non-zero having done
nothing — **on a non-zero exit, print the prompt as usual.** The clipboard path is the fallback, never
something to retry into.

### The prompt is sent as a `/goal`

A plain prompt stops at the end of its first turn, which for a multi-step plan means it stops half-done in a
tab nobody is watching. `/goal` adds an evaluator that runs after every turn and re-prompts until the
condition holds — that is what carries a handoff through `wt-ship` unattended. The condition **is** the
directive, so it is one message, not a prompt followed by a goal.

Three constraints the script handles, worth knowing because each fails silently:

- **One line, because of the transport.** `herdr agent prompt` types into the worker's pane, so a newline is
  Enter: a three-line prompt submits `/goal <first line>` and types the rest as separate turns. Claude Code
  itself accepts a multi-line `/goal` when a human pastes one — this constraint is herdr's, not the
  command's. The script flattens the prompt, so write it normally.
- **4,000 characters**, checked before sending rather than letting the command be rejected mid-handoff.
- **The evaluator reads only the conversation.** It cannot run commands or read files, so it judges from what
  the worker surfaces. "Definition of Done met, then wt-ship" works because the worker says so in the
  transcript.

Pass `--no-goal` only when the work genuinely is one turn.

What a goal does **not** promise: the evaluator can judge a condition impossible and clear it, and Claude Code
stops the loop if several turns pass with no tool use. Both land the worker idle, mid-plan, with the plan
still committed in the worktree as the source of truth. So report what was sent and that it may still need a
nudge — re-prompting resumes it fine.

### Talking to a running worker

It is a peer session: `ListAgents`, then `SendMessage` by name to ask how it is going or to correct course,
and it can answer you. That channel carries **text only** — a slash command sent that way arrives as a
message and does nothing, so anything slash-shaped has to go through the pane.

The prompt text belongs in your reply either way, because that is the record of what was handed off.

## Managing the pools

`scripts/agents.sh` owns the two pools — `<repo>-workers` and `<repo>-planners` — so spawning and naming
have one definition:

```bash
agents.sh list [worker|planner]        # name, pane, status, cwd
agents.sh spawn worker [cwd]           # worker starts in the worktree
agents.sh spawn planner [cwd]          # planner starts in the MAIN checkout — its first job is to make a worktree
agents.sh rm <name|pane> [--force]     # closes the tab
```

**Every agent is named, and the name needs its own step.** `herdr agent start <NAME>` names only what it
actually *starts*; when it instead DETECTS a claude already running in that pane — the path a
timeout-and-retry takes — it reports success and the name never lands. Four of this pool's six workers were
unnamed for exactly that reason, findable only through their tab label. `agents.sh` always follows a start
with an explicit `agent rename`, and backfills any unnamed agent in the pool from its tab label on every
call, so `rm <name>` works on agents that predate it.

**`rm` refuses a `working` agent** unless given `--force`. A turn in flight is discarded with it, and until
the worker commits, its work exists only in that pane.
