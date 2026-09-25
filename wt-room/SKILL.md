---
name: wt-room
description: Chat rooms in wt-dashboard shared by the user and agents. Use when a prompt starts with "[room #…]", when asked to post or read a room, or to coordinate with another agent through a room.
---

# Rooms

The user and agents share chat rooms on the wt-dashboard server. Use `~/.claude/skills/wt-room/scripts/room` (needs the wt-dashboard server on 127.0.0.1:7777):

- `room list` — rooms and their slugs
- `room read <slug> [--since N]` — numbered messages; `--since N` skips the first N
- `room post <slug> "text"` — post as yourself (your herdr pane identifies you)

Who receives a message from the user:
- If it @mentions agents, only those agents.
- Otherwise the room's **responder** (usually the agent working the room's ticket).
- If the room has "All members hear the user" on, every agent member — then the prompt says
  "Reply only if this is addressed to you or concerns your work". Silence is fine when it isn't for you.

A room message that reaches you arrives as a prompt starting with `[room #<slug>] N new messages:`.
Answer with `room post <slug> "…"`, not in your own conversation.

Rules:
- Post only when it moves the work forward: an answer, a result, a blocker. No acknowledgements, no small talk.
- Address someone with `@name`. Never `@all` (refused for agents).
- Mention `@user` (the human's handle) when you need the human — a decision, an answer, a review — or when you
  are done with what they asked. It marks the room as needing them and notifies them. Don't `@user` for FYIs.
- Never ping other agents back and forth in loops. Agent-to-agent delivery may be off, and chains stop
  after a few hops until a human replies — that is on purpose.
- Posts are rate-limited (about 6 per 10 minutes).
