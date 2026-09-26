---
name: wt-ticket
description: The local ticket board in wt-dashboard — per-project kanban tickets with ids like WP-12, stored on disk instead of Linear. Use to file, list, show, move, comment on, claim or assign a local ticket; when a ticket id's prefix is a local board key (not UMK); when the auditor files findings; or when the orchestrator picks the next work. Linear (UMK-N) is unchanged.
---

# wt-ticket

Every project gets a board in wt-dashboard (Tasks → Board). Tickets are `<KEY>-N`: the key is derived from the
project name (`wt-pack` → `WP`) when the board is first used. The user drags cards on the web; agents use the CLI:

`T=~/.claude/skills/wt-ticket/scripts/wt-ticket` (needs the wt-dashboard server on 127.0.0.1:7777; your herdr pane identifies you)

- `$T new "<title>" [--type bug|ux|gap|debt|feature] [--size S|M|L] [--priority 0-4] [--label l]... [--link url]... [--body text] [--column c]`
  — priority is Linear's scale: 0 none (the default; rows omit it), 1 urgent, 2 high, 3 medium, 4 low. The project defaults to the repo you are in (`--project p` to override); new tickets land in `backlog`. Jev may fill type/size/priority you left unset (undoable in the dashboard) and flag likely duplicates; fields you set are never changed
- `$T list [--column c] [--mine]` · `$T show <ID>` · `$T keys`
- `$T triage <ID>|--column c` — run Jev triage on existing tickets (fills only fields still unset and never edited; undoable)
- `$T move <ID> <column> [--note "…"]` — columns `backlog ready planning building review done blocked`; `blocked` needs `--note` (the reason)
- `$T comment <ID> "text"` · `$T claim <ID> [--force]` · `$T assign <ID> <agent|me|none>`
- `--json` on any command prints the API body. Exit 0 ok, 1 API error or server down, 2 usage.

Pipeline integrations call it as `$T … || true`: a board failure never blocks a pipeline step.

| Step | Move |
|---|---|
| wt-plan starts a `<KEY>-N` | `planning` + `claim` |
| wt-handoff to a worker | `building` + `assign <worker>` |
| wt-ship: PR opened | `review` (merge-direct projects like wt-pack: `done` on merge) |
| wt-finish | `done` |
| wt-work blocked | `blocked --note "<reason>"` |
| wt-audit finding | `new … --column backlog` |

## Orchestrator rule

**Schedule only tickets in Ready.** The user moves a card to Ready to say "do this next"; Backlog is a proposal,
not an instruction. Take one with `$T claim <ID>` before planning it (`wt-plan <ID>`), so two orchestrators never
pick the same card. Do not move cards into Ready yourself.
