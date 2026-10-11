# WP-321 spike: native ListAgents/SendMessage as a transport

**Verdict: NO-GO as a replacement, GO as an optional second lane (later).** Keep herdr prompt injection + wt-deliver as the primary transport.

Evidence: claude 2.1.296; two throwaway headless sessions in a temp dir, `HERDR_*` stripped. No real agent was messaged or listed.

## Findings
| Question | Result |
|---|---|
| Exists in `-p`/SDK? | Yes. `ListAgents` and `SendMessage` are in the headless `init` tools list. |
| Reach | A bare name resolves to a live session on this machine (also Remote Control, cloud, Desktop). Headless `-p --name wp321-b` (stream-json input) accepted a send: `success:true, msg_id`, "in that session's inbox, not yet read by its Claude". |
| Ack | Only "reached the inbox". The tool description says it does not mean read. Silence from Remote Control or cloud sessions means nothing. No receipt we can hang `handoff_ack` on. |
| Timing | Messages enqueue and drain at the receiver's *next tool round*. Per the tool text, this does not wake a session that is idle at the prompt. That is the core gap: herdr `agent prompt` injects a turn. |
| Envelope / trust | Delivered wrapped as `<cross-session-message from="...">`. Our `<wt-message ...>` would sit nested inside it. A peer message, not a user turn, so the CLAUDE.md rule "a `<wt-message>` is wt-pack traffic" would need a new rule. A session in a different permission mode holds messages for user approval and may let them expire. |
| Discovery | Rows are `name [ref]` plus busy/idle. No role/pair/DND/task tokens, no cwd/session-id contract (not verified: I did not call ListAgents, to honour the no-real-agents rule). herdr `agent list` + pane tokens stay the source of truth for candidates. Mixed with ~150 offline Remote Control sessions. |
| Scope / security | Reach is cross-project, same machine plus remote, with no allowlist we control. A peer can inject text into any session that accepts it, which is a wider prompt-injection surface than a pane-id-scoped dashboard POST. |
| Dashboard drive | Only from inside a Claude session (it is a model tool), so the dashboard server cannot call it. Headless runs (WP-317) already get next-user-message delivery via `hl_post`, which is better. |

## Not verified
Whether B's Claude ever consumed the message once idle. My stream-json probe session ended or ignored it, so drain-on-idle is taken from the tool text only. Not tested: interactive herdr panes (needs spawning a scratch pane), Remote Control.

## Migration sketch (if revisited)
- `handoff.sh --reply`/send: after `herdr agent prompt`, optionally *also* `SendMessage` is impossible from bash. It is a model tool. So the script cannot use it; only an agent's own turn (or a wt MCP tool `handoff`) could. This alone makes a full swap a no-go for handoff.sh.
- `wt-deliver`: unchanged; it is what makes delivery wake an idle pane.
- `agents.sh`: unchanged; tokens and spawn are herdr-only.
- Possible later: a `wt` MCP tool that wraps SendMessage for agent-to-agent *notify_when_idle* subscriptions (replaces polling for "worker done"). Gate by `wt-agents list` names so only pack agents are addressed.

Related: WP-317, WP-320, WP-292.
