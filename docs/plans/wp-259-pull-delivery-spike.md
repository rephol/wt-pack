# WP-259 — pull delivery spike: findings

Point-in-time note (2026-10-05). Four throwaway `claude` sessions in temp repos (sonnet/low, bypassPermissions, spawned with
`wt-agents spawn worker`), driven from another worker session with `SendMessage`. All agents and temp repos removed afterwards.
Scripts: `wp-259-pull-spike/` (`stop-hook-pop.sh`, `courier-stop-hook.sh`). Times are wall-clock seconds from the logs the agents wrote.

## Results

| # | Question | Measured | Verdict |
|---|---|---|---|
| 1 | Message to an agent mid-task | Agent running 8 × `sleep 15`. Sent 22:41:49, agent logged it 22:42:04 (next tool-round boundary, i.e. when the running sleep returned). Task A finished all 8 steps afterwards. | Read at the next tool round, task continues, nothing lost. Latency = remaining length of the current tool call. |
| 2a | Stop hook pulls the next message | Project `.claude/settings.json` Stop hook pops `queue.txt`, prints `{"decision":"block","reason":"…"}`. Two queued items ran as two new turns, ~2–4 s apart (22:45:49 → :53 → :57), then the queue was empty and the agent stopped. | **Works in a bypass-permissions agent** (hooks are not permission-gated). Same mechanism `/goal` uses. |
| 2b | MCP tool call to pull | Not run as a delivery path: a tool call needs a turn already running, so it cannot wake an idle agent. | Only useful as the *fetch* inside a turn the wake-up started (`wt-message fetch <id>`); not a trigger. |
| 3 | Courier session as the sender | Courier = a session whose Stop hook waits ≤20 s on a queue file, then blocks the stop with "call SendMessage to X: …". Enqueued 22:46:32, hook fired :33, recipient read it 22:46:56 (~24 s, mostly the courier's own model turn). | Works. The queue is how it learns what to send. Cost: one model turn per message, ~20 s latency, a long-lived session per host. |
| 4a | Long text | 41-line ≈ 4 KB message to a busy agent: agent echoed `N=41` and the last token intact. | No truncation at this size. |
| 4b | Same text twice | Two identical messages sent back to back: one `D-READ` line only. | Identical repeats are dropped at the receiver's inbox, and the sender gets a `[Cross-session delivery notice]` saying so (confirmed; also deferred to the sender's next turn). A wake-up must carry a unique request id. |
| 4c | Burst | D, D, E1, E2, L sent within seconds to a busy agent: all (minus the duplicate) handled in one drain at 22:44:04, in send order. | Burst is batched into one tool round; order kept. |
| 4d | Agent still starting | `SendMessage` right after `spawn` (3 s): already listed as a peer (`idle`), read within ~3 s. | The start window is too short to hit via this path; `spawn` returns only once the session is registered. Not reproduced, not disproved for slower cold starts (plugin install, trust dialog). |
| 5 | `notify_when_idle` | Subscribed on 3 sends. Notices (for the two agents I checked) were **not visible during the sender's turn** (`ReadNotifications` empty) and arrived only after the sender's turn ended, as `[Cross-session idle notice]` carrying the agent's last-message text; they were timestamped at the agent's idle moment (22:43, 22:45), so delivery to the sender is real but deferred until the sender is itself idle. | Reaches the sender, but only at the sender's next turn boundary: fine for an orchestrator that is idle between turns, useless as a signal for a sender mid-task. Not a substitute for the messages-table delivery status. |

## Recommendation for WP-258

1. **Pull is the contract, the Stop hook is the trigger.** A `wt-pack` Stop hook (in `hooks/register.ts`'s shared `turn.complete` chain, not a second Stop hook on the event) asks the dashboard for this agent's next queued message and, if there is one, returns `block` + the text. Verified end-to-end in bypass mode; ~2 s per hop; no courier needed for an agent that is already running a session of ours.
2. **Wake-up is only for a truly idle agent.** After the Stop hook has returned empty the agent is idle and no hook will fire again. Waking it needs a sender: first choice the existing pane nudge (typed `task waiting, id X`, unique id so it is never throttled), which the pull then resolves into the real text. A courier session (`SendMessage`) works but adds a model turn (~20 s), a standing session and a second failure mode; only worth it if pane typing proves unreliable. **Do not build the courier first.**
3. **Busy agent needs nothing special:** the Stop hook runs when its turn ends; typed/`SendMessage` text arrives at the next tool round anyway. Long text (≥4 KB) is fine, but keep the wake-up short and put the body in the table.
4. **Always send a unique id in the wake-up** (throttle drops identical text).
5. **`notify_when_idle` and drop notices reach the sender only after its turn ends.** Use them as a hint; delivery status comes from the messages table (delivered when the Stop hook / fetch hands it to the agent).
6. **Open / not measured:** a 30–40 s hook budget (the courier hook waited up to 20 s without a timeout); a Stop hook that is slow or the dashboard being down must fail open (exit 0 → agent stops normally); an agent whose hooks are not loaded yet (plugin hooks load at session start, WP-120); slow cold start for 4d.
