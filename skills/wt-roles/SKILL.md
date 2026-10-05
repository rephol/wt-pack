---
name: wt-roles
description: Create, check and tune a project's own role instructions — per-role override files and named personas (e.g. a frontend worker, a QA reviewer) kept in the repo at .wt-pack/roles/. Use when asked to "create a role", "add a persona", "add a QA persona", "change how the worker behaves in this project", or when a role keeps getting the same project-specific correction. Not for personal preferences across projects (that is wt-memory).
---

# wt-roles

Paths to scripts and files are relative to this skill's base directory (announced when it loads), so they
work both from the `./setup` links and from a plugin install (WP-122).

A **project role** is a markdown file in the repo — `<main checkout>/.wt-pack/roles/<name>.md` — that is
injected into the matching agent's session, after the global, role and project preferences wt-memory already
injects. It is versioned with the code: reviewed, branched and committed like code.

```
wt-roles list                                        what is in effect here (kind, base, size, status)
wt-roles new <name> [--base <role>] [--from-default] write a starting file
wt-roles check                                       validate every file (exit 1 on an error)
wt-roles team list|check|new <name> [--template solo|standard|full] [--user]   team files: members (persona xN) + stage→persona map (WP-237)
```
All take `--cwd <dir>` (default: here). The CLI is `scripts/wt-roles` in this skill's directory (it is not on
`PATH`). A worktree reads and writes its repo's **main checkout**.

## Pick the right layer first

| You want… | Use |
|---|---|
| a rule for *you*, in every project | `wt-memory remember --scope global` |
| a rule for every agent in *this repo* | `wt-memory remember --scope project` (personal) or a repo override file |
| every worker/reviewer/… in this repo to behave differently | an **override**: `worker.md`, `reviewer.md` … |
| a *kind* of worker (frontend, QA, migrations) with its own model, tools and routing | a **persona**: `frontend-worker.md` |

An **override** is named after a base role (`orchestrator`, `planner`, `worker`, `auditor`, `reviewer`) and
applies to every agent of that role. A **persona** has any other name, declares `base:`, and applies only to
agents spawned as it. A persona's agent gets both: the base override first, then the persona file.

## File format

```markdown
---
base: worker                 # personas only; one of the five base roles
model: sonnet                # haiku|sonnet|opus (a session is never started below sonnet)
effort: low                  # low|medium|high
mcp: [figma]                 # extra MCP servers, names from wt-agents/mcp/catalog.json
skills: [impeccable]         # hints, shown to the agent as a line; not enforced
labels: [ui, frontend]       # Dispatch: a Ready ticket with one of these labels goes to this persona
---
Free-form instructions, written to the agent ("You are…", "Always…", "Never…").
```
Frontmatter is flat `key: value` lines plus `[a, b]` lists (no YAML features). Unknown keys are a `check`
warning. Persona names: lowercase letters, digits and `-`, ≤ 24 chars, not a base role name.

## Writing the body

- Say what is **specific to this repo** and not derivable from reading it: commands, conventions, traps, who
  owns what. Skip what the code, CLAUDE.md or the tests already state.
- Imperative and checkable ("run `npm run lint` before committing"), not aspirational ("write good code").
- One persona = one job. If you need "and" in its description, make two.
- **Cap: 6 KB** of body. Beyond it the injection is cut at a line and says so; `check` warns first.
- Put the rule where it applies: an override for all workers; a persona only for what differs.

## Personas in practice

- `wt-agents spawn frontend-worker` starts it in the `<repo>-workers` pool (it is still a worker: idle
  retirement, DND, pairing and Dispatch see it) with `persona=frontend-worker`, and the file's model, effort
  and MCP servers (explicit flags win).
- Dispatch hands a Ready ticket to the first persona (filename order) with any `labels` entry equal to one of
  the ticket's labels (case-insensitive) and whose `base` matches the ticket's role (Dispatch only ever picks
  `worker` or `planner`; `--persona` by hand also takes `reviewer`). Matching is strict: a plain worker is never given a persona ticket,
  and a persona agent never gets a plain ticket. No match = today's behaviour.
- `wt-handoff --persona <name>` does the same by hand. A spawn name with no valid file is just an ordinary new
  role name with its own pool, so a typo does not warn: check `wt-roles list` first.

## Workflow

1. `wt-roles new <name> --base <role>` (or `--from-default` to start from the pack's example for that base).
2. Edit the body; keep it short.
3. `wt-roles check` until it is clean.
4. **Commit it** like code. The CLI and the dashboard write into the repo's **main checkout** (not your
   worktree), so commit from there (`git -C <main checkout> add .wt-pack/roles && git -C <main checkout> commit`).
   Agents read the main checkout, so a role takes effect as soon as the file is saved there, and a file edited
   only in a worktree never leaks to other agents.

Skeleton: `template.md`. Worked examples: `examples/worker-override.md`, `examples/frontend-worker.md`.
Example overrides per base role, which `--from-default` copies: `defaults/`. Nothing is copied into a repo by
installing the pack: with no files present, agent behaviour is unchanged.
