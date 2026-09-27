# WP-109: Agents' Claude sessions exited silently (root cause + watchdog check)

## Goal
Agent sessions stop dying because of a mis-ordered `pkill` in test cleanup. A pool agent whose Claude process does
exit (for any reason) raises an Inbox item. That item has a **Resume** action that restarts the exact session in
the same pane, with the agent's name and MCP flags.

## Root cause (established by research, read-only)
worker-01's WP-107 test cleanup ran this command (transcript `b59a4fad`, 06:11:04Z):
`pkill -f "node server.mjs" -U $(id -u) -n`.

BSD `pkill`/`pgrep` stop parsing options at the first operand. So `-U`, `501` and `-n` became extra **patterns**.
Because the command used `-f`, `-n` matched `--name` in every `claude --name <label>` process. That flag is added at
`skills/wt-agents/scripts/agents.sh:185` (`set -- --name "$label"`). Each of those sessions got SIGTERM, ran its exit
handler, and printed "Resume this session with…". A no-kill reproduction confirms it:
`pgrep -lf zzznomatch -U $(id -u) -n` lists every `claude --name wt-pack-worker-*`.

The timeline supports it:
- 06:11:05.095–.110: the unified log shows 9 claude exit handlers within 15 ms.
- 06:11:07: `herdr-server.log` has `agent changed … agent=None` for 8 panes at once.

Some sessions survived, for two reasons:
- **worker-01** was the caller, and pkill skips itself and its ancestors.
- **The umkmall agents** have no `--name` on their command line. This one is inferred.

## What research corrected
- **The suspects the ticket named are cleared.**
  - `agents.sh rm --force` and `herdr workspace close` hit only the demo pane and workspace (herdr `tab.close` for pane 130, `workspace.close` for w10).
  - The WP-107 `GH_TOKEN`/mcp-mode change is unrelated.
  - The watchdog, routines, a service restart and `setup doctor` did not run in the window (the last `routine_runs` entry was hours earlier; service pid 94069 was steady).
- **The new worker-02 in w1Q:p9 was spawned by the dashboard's dispatch reconcile.** It is not a stray.
  - `board_events` 60–61 at 06:12:05 recorded `returned WP-108 "wt-pack-worker-02 is gone"`, then `dispatch WP-108 → wt-pack-worker-02`.
  - The pane has `spawned_by=wt-agents` (`agents.sh:178`).
  - This is intended behaviour. It does mean a Resume must check that the ticket was not already re-dispatched.
- **The ticket's "resume by exact session id" requires a stored session id.** herdr drops the agent record when claude exits, so a pane that is already at the shell has no session to read. The watchdog must **remember** `{pane, name, session, cwd, role}` for each live pool agent, while it is alive. The session id is read today at `server.mjs:432` (`a.agent_session.value`).

## Approach
1. **Prevent the root cause.**
   - Add a trap line to CLAUDE.md.
   - Add a worker rule in wt-memory: `~/.config/wt-memory/roles/<role-id>.md` holds the rules for agents whose herdr `role` token is that id (`skills/wt-memory/SKILL.md:11`). Use `wt-memory remember … --scope role` in the worker role.
   - Add a small PreToolUse Bash guard in the wt-memory plugin, which every pack agent already loads. `skills/wt-memory/claude-plugin/hooks/hooks.json` today registers only `SessionStart` and `UserPromptSubmit` (`inject.mjs`). The guard is `claude-plugin/hooks/pkill-guard.mjs`. It denies a `pkill`/`pgrep` command in which an option appears after the pattern, and its message says to put options first or kill by pid. Bump the plugin version, as WP-105 did, so `claude plugin update` picks it up. Rejected: mirroring `eval-plan.sh`, which is wired by hand in `~/.claude/settings.json:38` and so is not shipped by the repo.
   - Prose alone was the rejected alternative: the same mistake would recur in the next test cleanup.
2. **Detection.** Add a watchdog check `exited` to `CHECKS` (`watchdog.mjs:6-17`), labelled "Pool agent's Claude session exited for", in min, with threshold 1. `evaluate` fires when a remembered pool agent's pane still exists but herdr reports no Claude agent in it. It stays pure: the server feeds `snap.exited: [{ pane, name, session, since }]`.
3. **Memory of live agents.** On each watchdog tick (`server.mjs:2684-2722`), the server records every pool agent that has a session id. Pool agents are those whose herdr name matches `<repo>-(worker|planner|orchestrator|auditor)-NN`, or that carry a role pane token. The record `{name, session, cwd, role}` is keyed by pane and goes in `watchdog.json` as `lastSeen`. Entries whose pane is gone are pruned.
4. **Resume action.** Add `POST /api/watchdog/resume {key}` next to `investigate` (`server.mjs:2733`). It:
   1. re-checks that the pane still has no agent (409 otherwise);
   2. refuses when the agent's ticket card is now assigned to a different pane or agent, which is the WP-108 case;
   3. runs `herdr agent start <name> --kind claude --pane <pane> -- --resume <session> --name <name> $(agents.sh mcp-args <role> <cwd>)`. This is the same call spawn makes (`agents.sh:186`), and `mcp-args` is at `agents.sh:7,145`.

   It always uses `execFile` with argv, never a shell. It is loopback- and session-guarded like the other watchdog POSTs. The Inbox item and the Watchdog page show a Resume button that calls it.
   - Rejected: `claude --resume <name>`, which opens a picker when names repeat (ticket).
   - Rejected: auto-resume, because the user or dispatch may have replaced the agent on purpose.

## Review corrections (applied; these override the text above where they conflict)
- **MCP flags.** `agents.sh mcp-args` cannot be spliced into the command. It prints server *names* (`jq -c '.mcpServers | keys'`) and then `rm -f "$mcp_file"` (~142-145). Add an `agents.sh mcp-file <role> <cwd> <label>` mode that writes `~/.cache/wt-agents/mcp-<label>.json`, keeps it, and prints `--strict-mcp-config --mcp-config <path>` (empty in full mode). Resume uses that mode. The spawn `herdr agent start` is at ~187.
- **Reassignment and name checks go by pane, not by name.** Dispatch put WP-108 back on the **same name**. The assignee is `{name, pane}` (`server.mjs:1950`), so the 409 compares the ticket's assignee pane with the dead pane. There is a second 409 when `<name>` is live in another pane: herdr names are global, and `agent start` would fail with `agent_name_taken`.
- **`lastSeen` records the ticket.** Each record is `{name, session, cwd, role, ticket}`, keyed by the **stable** pane id (resolve it with `herdr pane get`; see the CLAUDE.md trap). The ticket comes from the `task` token or `ticketOf(cwd)` (`server.mjs:380,1858`).
- **Pool membership uses the existing field.** `agents()` sets `pool: role.id` (`server.mjs:456`), and that replaces the name regex. Only `m.local` agents have a session (`:432`), so remote agents are never remembered.
- **Pane liveness needs a pane list.** `agents()` comes from `herdr agent list` (`:412`), so a pane whose Claude exited drops out of it. Add `herdr pane list`, which the metadata refresh already runs (`:365`), to `watchdogSnapshot` as `panes`. A remembered pane that is in `panes` but has no agent fires the check. A remembered pane missing from `panes` is pruned.
- **UI.** `inboxOps` passes `check` in `target` (`{ watchdog: key, check }`). The Resume button goes in `web/src/inbox.tsx` and `web/src/watchdog.tsx`.
- **Hook denial.** The hook prints `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"…"}}`. The version to bump is in `skills/wt-memory/claude-plugin/.claude-plugin/plugin.json` (0.4.3 → 0.4.4).
- Files add: skills/wt-agents/scripts/agents.sh (mcp-file mode, its own commit), web/src/inbox.tsx, web/src/watchdog.tsx.

## Implementation units
**U1: guard + rules (wt-memory plugin, root docs).**
- Add `skills/wt-memory/claude-plugin/hooks/pkill-guard.mjs`, reading the hook JSON on stdin, with `skills/wt-memory/scripts/pkill-guard.test.mjs`:
  - denies `pkill -f "x" -U 1 -n`;
  - allows `pkill -U 1 -n -f "x"`, `kill 123`, and `echo pkill`.
- Register it under `PreToolUse` with matcher `Bash` in `hooks.json`, and bump the plugin version.
- Add a CLAUDE.md Traps line: "BSD pkill/pgrep: options after the pattern become patterns; `-f … -n` SIGTERMs every `claude --name` agent (WP-109). Kill by recorded pid."
- Add the wt-memory worker rule.

**U2: watchdog check (wt-dashboard).**
- `watchdog.mjs`: add the `exited` check to `CHECKS`, have `evaluate` read `snap.exited`, and include the pane and session in the finding.
- `server.mjs`: `lastSeen` bookkeeping in `watchdogSnapshot`/`runWatchdogOnce`.
- Tests in `watchdog.test.mjs`:
  - it fires when a remembered pane has no agent;
  - it does not fire when the pane is gone (pruned), when the agent is back, or for non-pool panes (umkmall).
- Settings for the check come through `cleanWatchdogSettings` automatically.

**U3: Resume action (wt-dashboard + web).**
- `POST /api/watchdog/resume`, plus the button on the watchdog Inbox item and the Watchdog page (no native dialogs).
- Tests: the argv built for herdr contains `--resume <id> --name <name>` and the mcp args. It returns 409 when the pane is running again or the ticket was reassigned. Put the argv builder in `watchdog.mjs` (pure) and test it there.

**U4: docs.** Update `docs/features.md` for the Watchdog "Session exited" check and Resume.

## Files
- skills/wt-memory/claude-plugin/hooks/pkill-guard.mjs (new), skills/wt-memory/claude-plugin/hooks/hooks.json, the plugin manifest version, skills/wt-memory/scripts/pkill-guard.test.mjs (new)
- CLAUDE.md
- skills/wt-dashboard/watchdog.mjs, watchdog.test.mjs, server.mjs, package.json (only if a new test file is added), web/src (the watchdog/inbox components that render `target.watchdog`)
- docs/features.md

## Verification
- `node --test skills/wt-memory/scripts/*.test.mjs`
- `cd skills/wt-dashboard && npm test`, then `cd web && npx tsc --noEmit -p . && npm run build`.
- Live check with a **throwaway** agent only:
  1. `agents.sh spawn worker <tmp repo>`.
  2. Record its pid, then `kill <pid>` (never pkill).
  3. Within about 2 ticks, confirm an Inbox item appears.
  4. Click Resume and confirm the same session id comes back in the same pane.
  5. `agents.sh rm` the throwaway.

  Never touch umkmall panes. For the browser check, use agent-browser `--session <agent name>`.

## Definition of Done
- The hook test proves that the exact incident command is denied and that correctly ordered commands pass.
- The CLAUDE.md trap line and the wt-memory rule exist.
- `watchdog.test.mjs` covers the fire and no-fire cases above, and the resume argv/409 tests pass. `npm test` and tsc pass.
- The live throwaway check shows the Inbox item and a successful Resume with the same session id. It is reported in the transcript with the pane and session ids.
- `docs/features.md` is updated. There is one commit per skill touched.

## Risks and deferred
- An agent that was never seen alive by the watchdog cannot be resumed from the Inbox, because it has no stored session. Examples are exits during a server restart, or before the first tick. The finding still fires if a role token exists, but Resume is disabled with the reason shown.
- The guard parses shell loosely. A deliberately obfuscated command passes, which is accepted: it guards against accidents.
- Deferred: auto-resume, and resuming the agents killed on 2026-09-27. Those were already resumed by hand; WP-108 was re-dispatched.
