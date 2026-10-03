---
name: wt-ask
description: Ask the user a question from an agent pane, as a room chip and Inbox card in wt-dashboard. Use when you need the user's input from a room, handoff or dispatch context — not your own chat session, which already has the native question tool. Needs wt-dashboard (the full ./setup install, not the plugin alone).
---

# wt-ask

Paths to scripts and files are relative to this skill's base directory (announced when it loads), so they
work both from the `./setup` links and from a plugin install (WP-122).

Posts a question to the user as a room chip and Inbox card (WP-164's 'A'). The user answers it from either;
the answer comes back to you as a `<wt-message kind="reply" from="user">` through `handoff.sh --reply`, the
same as any other reply.

**WP-206:** with `wt-ask-mod@wt-pack` enabled (`./setup install`), a herdr agent's native `AskUserQuestion` is
already routed to the dashboard and blocks until it is answered — don't call `wt-ask` by hand for that. In a room,
handoff or dispatch context where you must not block, `wt-ask` below is still the fire-and-forget way. The mod's own
building blocks: `--wait <id> [--timeout S]` (print the answer JSON; exit 3 on resolved/timeout), `--ping`,
`--no-deliver` (skip the reply message) and `--json -` (questions on stdin).

**Which tool to use (WP-164 decision 4):** in your own chat session — the dashboard's agent chat page or the
terminal, unmarked — use your native question tool (`AskUserQuestion` and similar). It already renders as a
mirrored picker card there ('B'). Use `wt-ask` only from a room, handoff or dispatch context, where there is
no session UI the user is looking at right now.

```
wt-ask "<question>" --option A --option B [--recommend A] [--multi] [--header H] [--ticket WP-N] [--room slug]
wt-ask --json <file> [--ticket WP-N] [--room slug]
wt-ask --resolve <id>
```

- `--option` (repeatable): 1-4 questions total need `--json` for more than one; the plain form asks one.
- `--recommend <label>`: marks that option as recommended; must match an `--option` label.
- `--multi`: the question allows more than one option.
- `--header H`: short tab label (defaults to the question, truncated). Keep it under a few words.
- `--json <file>`: for 1-4 questions in one card — `{"questions":[{question,header,options:[{label,description?}],multiSelect?,recommended?},...]}`.
  Sent as the request body verbatim; add `--ticket`/`--room` on the command line, not inside the file.
- `--ticket WP-N`: attaches the ticket. When `--room` is not also given, the room defaults to the ticket's
  room (its id lowercased, e.g. `WP-164` → `wp-164` — the same slug `wt-dashboard`'s `ticketSlug()` uses for a
  ticket's own room). With neither `--ticket` nor `--room`, the ask has no room and shows only in the Inbox.
- `--resolve <id>`: closes the ask without an answer (e.g. the question no longer applies). Only the pane
  that asked it may resolve it.

Prints the ask id on success. Identity is `$HERDR_PANE_ID` (the server rejects unknown panes), same as
`wt-room`'s `room` CLI. Exit codes: 0 ok, 1 API error, 2 usage.

## Example

```
id=$(wt-ask "Which environment?" --option staging --option prod --recommend staging --ticket WP-164)
```

The user answers from the `wp-164` room's chip or the Inbox; your next `<wt-message kind="reply">` carries it.
