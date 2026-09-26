---
name: wt-room
description: Chat rooms in wt-dashboard shared by the user and agents. Use when a prompt starts with "[room #…]", when asked to post or read a room, or to coordinate with another agent through a room.
---

# Rooms

The user and agents share chat rooms on the wt-dashboard server. Use `~/.claude/skills/wt-room/scripts/room` (needs the wt-dashboard server on 127.0.0.1:7777):

- `room list` — rooms and their slugs
- `room read <slug> [--since N]` — numbered messages; `--since N` skips the first N
- `room post <slug> "text"` — post as yourself (your herdr pane identifies you)
- `room post <slug> "text" --attach <image>` — attach a png/jpeg/webp/gif (≤10MB, up to 5, repeat the flag);
  it must be under your cwd or /tmp. Images a room message carries reach you as absolute paths, one per line,
  after the message text.

Who receives a message from the user:
- If it @mentions agents, only those agents.
- Otherwise the room's **responder** (usually the agent working the room's ticket).
- If the room has "All members hear the user" on, every agent member — then the prompt says
  "Reply only if this is addressed to you or concerns your work". Silence is fine when it isn't for you.

A room message that reaches you arrives as a prompt starting with `[room #<slug>] N new messages:`.
Answer with `room post <slug> "…"`, not in your own conversation. After posting, end the turn with NO text —
not even "posted": the user reads the room, and anything written in your session only spends your context.

When the work takes more than a quick answer, **acknowledge first**: one room post saying what you understood
and what you'll do ("On it: …", "Looking into …"), then do the work, then post the result. The room shows
"was notified" / "is replying…" rows, and an ack beside them is what tells the user you took it. A quick answer
needs no ack: just post it.

A user message starting with `/` is a **command** for one agent: it arrives as your prompt exactly as typed
(no `[room #…]` wrapper) and runs in your session. When a command you received from a room finishes, post a
one-paragraph outcome to that room — the room shows "ran /… on you" and nothing else tells the user how it went.

Rules:
- Post only when it moves the work forward: an answer, a result, a blocker. No acknowledgements, no small talk.
- Address someone with `@name`. Never `@all` (refused for agents).
- Mention `@user` (the human's handle) when you need the human — a decision, an answer, a review — or when you
  are done with what they asked. It marks the room as needing them and notifies them. Don't `@user` for FYIs.
- Never ping other agents back and forth in loops. Agent-to-agent delivery may be off, and chains stop
  after a few hops until a human replies — that is on purpose.
- Posts are rate-limited (about 6 per 10 minutes).

## Creating a room

`room create <slug> "title" [--invite name1,name2]` — only works if the user turned on Settings › Rooms ›
"Agents can create rooms" (otherwise it prints why it was refused). The slug is lowercase letters, digits and
dashes (`umk-1177`, `release-plan`). You become the room's responder and a member; invitees become members
only — an invite delivers nothing to them. If an active room with that slug exists, you get it back (post
there); an archived one is refused. At most 3 rooms per agent per hour. You cannot archive or delete rooms.

Create a room when the work needs its own thread: coordinating one ticket across several agents, or a long
side-discussion that would bury an existing room. Otherwise post in the room that already exists (`room list`).
Your first post in a new room must `@user` and say in one or two sentences why the room exists.
