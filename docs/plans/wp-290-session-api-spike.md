# WP-290 — can the dashboard drive agent sessions by session id instead of herdr panes?

Point-in-time spike (2026-10-10, Claude Code 2.1.296, macOS). No production code. Experiments used throwaway
`claude` processes (haiku) in a temp dir; each pid was recorded, every process exited, and the temp transcripts were
deleted. No real agent's session or pane was touched. Docs quoted are from code.claude.com at the same date.

## Verdict

Yes, and there is a better channel than the one asked about. A live session, TUI or `-p`, has an **inbox socket**
(a Unix socket per process) that takes the same `{"type":"user",…}` line as stream-json and starts a turn. That
covers "send a message by session id" for the agents we already run in herdr panes, with no new processes.
Receiving events, answering asks and interrupting need a process the dashboard *owns* (stream-json); those cannot
be done to a TUI that a pane owns. Recommendation: **(b) hybrid**, staged, starting with the socket for sends
(see end).

## 1. Stores and resume

- Same store. SDK and CLI both write `~/.claude/projects/<cwd with non-alphanumerics → "-">/<session id>.jsonl`
  (docs: "Claude Code stores sessions under `~/.claude/projects/<encoded-cwd>/*.jsonl`"; `--resume` also takes a
  `.jsonl` path). The session id in a stream-json `system/init` event is the file name.
- Resume of a session another live process holds: **no refusal, no fork, no lock.** Measured: process A (long-lived
  stream-json) held session X; process B ran `claude -p --resume X`. B returned the **same** session id, appended to
  the same file (3 user turns, one `sessionId`), and answered from A's earlier context. A then did not know about
  B's turn ("UNKNOWN"): its in-memory history is stale while the file carries both. Docs agree: "If you resume the
  same session in two terminals without forking, messages from both interleave into one transcript."
  `--fork-session` (or SDK `fork_session`) is the opt-in copy with a new id.
- So a parked agent can be resumed from the dashboard by id, but resuming one a pane still has open clobbers
  nothing and silently diverges. A TUI was not driven directly (no pty harness); the file behaviour is the same and
  the docs describe the interleave for terminals.

## 2. stream-json stdin/stdout

`claude -p --input-format stream-json --output-format stream-json --verbose [--permission-prompt-tool stdio]`
is one long-lived process. Verified end to end:

| Need | Result |
|---|---|
| Several user messages | `{"type":"user","message":{"role":"user","content":"…"}}` per line; 3 turns, context kept. Docs: queued messages "process sequentially, with ability to interrupt". |
| Events out | `system/init` (once per turn; has `session_id`, `plugins`, `tools`, `permissionMode`, `apiKeySource`, `messaging_socket_path`), `system/hook_started`/`hook_response`, `assistant`, `user`, `rate_limit_event`, `result/*` (cost, usage, `permission_denials`), `control_response`. `--include-partial-messages`, `--include-hook-events`, `--replay-user-messages` add more. |
| Interrupt | `{"type":"control_request","request_id":…,"request":{"subtype":"interrupt"}}` mid-turn → `control_response` success, a `[Request interrupted by user]` user event, and a `result/success` ending the turn. The process keeps running. |
| Permission answer | With `--permission-mode default --permission-prompt-tool stdio`, a tool needing approval emits `control_request` `can_use_tool` (`tool_name`, `input`, `permission_suggestions`, `tool_use_id`). Reply `control_response` with `behavior: allow` + `updatedInput`, or `deny` + `message`. |
| AskUserQuestion | Same `can_use_tool` request with `tool_name: AskUserQuestion`, `requires_user_interaction: true` and the `questions` array; answer by returning `updatedInput` with `answers: {<question text>: <label>}`. The model then used the answer. |
| Plugins / hooks | **Load.** `init.plugins` listed `wt-pack@inline` and the user's other plugins; six `SessionStart` hook events fired. Not tested: the `wt-mods` TUI mods (`/wt`, `wt-ask` capture, room delivery) — mods are interface changes and this mode has no TUI, so assume absent; `--bare` skips plugins and hooks entirely. |
| Default mode | The user's settings default to `bypassPermissions`, so with no flag no prompt ever appears; a dashboard-owned process must pass `--permission-mode` itself. |

## 3. Remote Control

App-only. It "registers with the Anthropic API and polls for work" and routes messages "between the web or
mobile client and your local session"; the docs describe no third-party API, and it needs claude.ai subscription
auth ("API keys are not supported"). Not usable from the dashboard. `ListAgents` rows of that kind are those
sessions, not an open API.

What *is* documented and usable is **cross-session messaging** (2.1.224+): "Claude Code binds an inbox socket for
each session" (`/status` → `Peer address`, `CLAUDE_CODE_MESSAGING_SOCKET` in hooks; also in `init` for `-p`).
Measured against a throwaway `-p` session: an unrelated same-user node process connected to
`/tmp/cc-socks/<pid>.sock`, wrote one stream-json user line, and the session ran a turn and answered. The line
shape is not in the docs; it appears in the binary's own help text (`echo '{"type":"user","message":{…}}' | socat -
UNIX-CONNECT:…`). Gate: `crossSessionInbound`.

- Receiving session in a prompting mode (`--permission-mode default`): delivered.
- Receiving session in `bypassPermissions` (every pack agent): **held** (`system/peer_message_hold`) and dropped
  after `dialogExpiry` (5 min). Delivered with `crossSessionInbound: "accept"` (settings or `--settings`).
- Not covered: `claude --bare` binds no socket. The line format is undocumented, so a version bump can break it.
- `claude agents --json` lists live **interactive** sessions too (`pid, cwd, kind, sessionId, name, status`; 18 here,
  all `interactive`), so session id → pid → socket path is derivable. The docs call `agents --json` "the supported
  way to read session state from outside Claude Code".
- Background sessions (`claude --bg`, agent view, a supervisor process) add `claude attach|logs|stop|respawn` and
  `claude --resume <id> "prompt"` (sends to a running background session). `--bg` needs a trusted workspace
  ("Workspace not trusted" in a script) and was not run end to end here.

## 4. Auth and the "No Claude API in the dashboard" rule

Measured: the stream-json runs reported `apiKeySource: "none"` and ran on the machine's Claude Code login, with
no key. Policy, from Legal and compliance: "**Developers** building products or services that interact with Claude's
capabilities, including those using the Agent SDK, should use API key authentication … Anthropic does not permit
third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro,
or Max plan credentials on behalf of their users … developers may not collect, store, or intermediate Claude.ai
credentials or session tokens". And the carve-out: it does not prevent "an end user from signing in to the unmodified
Claude Code binary with their own Claude subscription". The SDK overview adds: "Anthropic does not allow third party
developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent
SDK."

Against the rule: the Agent SDK is "a library that runs the Claude Code binary", and the docs steer SDK products to
API-key auth, i.e. a Claude API dependency the dashboard rule forbids. A dashboard that spawns the
**unmodified `claude` binary** under the user's own login (stream-json) or writes into its sockets never touches a
credential and calls no API itself, which fits the rule's intent; it is the SDK-with-key and any "dashboard offers
login for others" shape that does not. This is a reading of the docs, not legal advice: a single-user local tool is
the carve-out's case, a multi-user hosted dashboard is not.

## 5. Recommendation: (b) hybrid, smallest step first

- (a) Dashboard-owned stream-json processes: full control (events, asks, interrupt) but the dashboard becomes a
  process supervisor and loses the herdr pane view, the TUI, mods and the per-pane tokens everything is keyed on.
  Largest change. Worth it only for headless roles.
- (c) Stay on herdr + mods: works, but sends are typed keystrokes into a pane (breaks on a dialog or a busy
  composer — see the WP-259 pull-delivery spike).
- **(b)**: keep herdr for live agents; add the inbox socket as the *send* path where `crossSessionInbound` is
  accepted, and resume-by-id for parked agents (`claude -p --resume <id>`; never while a pane still has it open, or
  use `--fork-session`). Events/asks/interrupt stay with the pane (dashboard already reads them from herdr and the
  `wt-ask` capture).

Main risks: the socket line format is undocumented and version-dependent; bypass-mode agents hold messages unless
`crossSessionInbound: accept` ships with the plugin's settings; same-user sockets are not authenticated per
sender; a resumed-while-open session diverges silently; `-p` processes need a cap on parked-agent resumes (cost).

Smallest next ticket: a `wt-send <session-id|pane> "text"` helper in wt-shared: resolve pid via
`claude agents --json`, post one stream-json line to `/tmp/cc-socks/<pid>.sock`, fall back to the current pane nudge
when the socket is absent or the message is held; plus `crossSessionInbound: "accept"` in the plugin's agent
spawn flags (`--settings`) and a test with a throwaway `-p` session.
