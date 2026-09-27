# WP-120 — Agents exited again after WP-109

## Goal

Record why the pool agents exited on 2026-09-27 at 19:02 +07. Close the gap that let the WP-109 guard miss it,
and make recovery reuse the exited agents instead of stranding them behind new, same-named spawns.

## Root cause (research, about 95% confident)

The trigger is the WP-109 bug again, set off by a session the guard had not reached.

- **The kill.** At 19:02:41.471, **umkmall-worker-05** (session 539874a7, Claude Code 2.1.280) ran
  `pkill -f "tsx src/index.ts" -n` (`~/.claude/projects/-Users-octeumkm-Work-projects-umkmall/539874a7-….jsonl:1024`).
  BSD pkill reads an option placed after the pattern as a second pattern, so `-n` matched every `claude --name …`
  process.
- **What died.** In the same millisecond, 19:02:41.696, five claude pids "Entering exit handler". The unified log
  shows this for 29492, 82700, 82697, 61201 and 90754. The handler running means SIGTERM, not SIGKILL.
- **herdr saw it.** It logged six panes going from Claude to none at 19:02:43–44
  (`~/.config/herdr/herdr-server.log:27296-27301`, `agent changed … previous_agent=Some(Claude) agent=None`).
- **The watchdog saw it.** It recorded six exits at 19:04:09: wt-pack worker-01/02/03 and planner-01, plus
  umkmall-planner-01 and umkmall-planner-06.
- **The guard was not live.** It is in wt-memory plugin 0.4.4 (committed 13:42), but
  `~/.claude/plugins/cache/wt-pack/wt-memory/0.4.4` was first created at **19:37:40**, 35 minutes after the kill.
  Versions 0.4.0–0.4.3 in the cache contain no pkill hook (`grep -c pkill` gives 0; 0.4.4 gives 2). Plugin hooks
  also load at session start, so any session started before 19:37 still runs unguarded today.

## What research corrected

- **The ticket says Resume put the agents in new panes. It didn't; Resume never ran.**
  - The dashboard log has no resume entry.
  - The new panes run new session ids (`w1Q:pA` f5e43f05, `w1Q:pB` 00acfc4c, `w1V:p3` f69168a2). The old ones were
    b59a4fad, 7f4e57d9, ec870191 and dcff5681, and a resume would have kept them.
  - `resumeArgv` can't create a pane: `herdr agent start … --pane <id>` means "Start … in an **existing pane**"
    (`watchdog.mjs:167`, from `herdr agent start --help`).
  - The new panes are fresh wt-handoff spawns. `agents.sh:180` runs `herdr tab create`. `agent-tags.json` records
    handoffs at those times: worker-01 WP-116 at 12:30Z, worker-02 WP-119 at 14:05Z.
- **The ticket says worker-03 is gone. It isn't.** Its pane `w1Q:p8` is still at a shell, and `watchdog.json` still
  holds the open finding `exited|w1Q:p8`. It was simply never respawned.
- **Why the old names came back.** `agents.sh:114-117` numbers only from live names
  (`herdr agent list | jq -r '.result.agents[].name'`), and herdr drops exited agents from that list. So spawns
  restarted at 01. Now `resumeBlock` (`watchdog.mjs:161`) refuses Resume on three old panes: "`… is already running
  in pane …`".
- **Suspects ruled out:**
  - herdr restart: the log runs straight through.
  - Dashboard restart: none.
  - Claude Code update: 2.1.283 has been installed since Sep 26.
  - WP-118 plugin reinstall: 19:37, after the kill.
  - Jetsam or crash: no memorystatus lines and no crash reports.
  - Sleep: the display went off at 19:41.
  - The watchdog: it never kills.

## Approach

The kill came from a guard that existed in git but wasn't loaded in the sessions that mattered. Two fixes follow:
make "unguarded session" visible, and stop spawns from taking the names of exited agents.

**Settled decisions** (headless, no user available):
- *Surface stale sessions; don't force restarts.* The watchdog adds a `stale-hooks` check. It flags a pool agent
  whose claude process started before the installed wt-memory version was installed: the birth time
  (`stat -f %B` / `birthtimeMs`) of that version's `installPath` from `~/.claude/plugins/installed_plugins.json`.
  Review corrected the first draft, which used "newest cache dir mtime": directory mtime only moves when entries
  are added or removed, and the 19:37 reinstall touched 0.4.3's directory as well. `./setup doctor` prints the same thing as one line.
  - Rejected: auto-restarting agents, which would kill work in flight.
  - Rejected: a user-level `settings.json` hook. [unsourced: whether settings hooks hot-reload in running
    sessions.] If they don't, it has the same start-time gap and adds a second copy of the guard.
- *Spawning reuses the exited agent's number.* `agents.sh spawn` numbers from live names **plus** names held by
  remembered exited panes in `~/.local/share/wt-dashboard/data/watchdog.json` (`lastSeen` entries with a
  `goneAt`). A new spawn then never takes an exited agent's name, and that agent's Resume stays possible.
  - Rejected: making spawn resume the exited pane itself. That changes wt-handoff's contract (it would hand work
    to an old session's context) and belongs to the user's Resume button.
- *Umkmall agents are not touched.* This change only adds visibility.

## Implementation units

### U1 — spawn numbering skips exited names (wt-agents)
- In the numbering in `skills/wt-agents/scripts/agents.sh` (`:114-117`), also read the `lastSeen[*].name` of
  entries with `goneAt` from `${WT_DASHBOARD_DATA:-~/.local/share/wt-dashboard/data}/watchdog.json` when that file
  exists, using `jq`. A missing or unreadable file changes nothing.
- Test in `skills/wt-agents/scripts/spawn-env.test.mjs`, which already stubs herdr and sets `WT_DASHBOARD_DATA`.
  The herdr stub lists no live agents. With watchdog.json holding an exited `<slug>-worker-02`, the spawn is
  named `-03`. Without the file, it is `-01`.
- **Verify:** `node --test skills/wt-agents/scripts/*.test.mjs`.

### U2 — `stale-hooks` watchdog check (wt-dashboard)
- In `watchdog.mjs` `CHECKS` (`:6`), add `{ id: 'stale-hooks', label: 'Pool agent started before the installed wt-memory guard', … }`.
- Give the check a `unit`/`threshold` that makes sense in the settings UI (e.g. unit `min`, threshold 0), and add an
  `on('stale-hooks')` branch in `evaluate` modelled on the exited branch (`watchdog.mjs:97`), fed from a new
  `stale` field in `watchdogSnapshot()` (`server.mjs:2710`).
- Add a pure `staleAgents(agents, pidStart, guardAt)` that returns the agents whose process start is earlier
  than `guardAt`.
- In `server.mjs`, compute `guardAt` (installPath birth time, as above) and each pool agent's process start. herdr
  gives no pid (review checked `herdr agent list`: agent, agent_session, pane_id, … with no pid), so run one
  `LC_ALL=C ps -axo pid=,lstart=,command=` and match rows on `--name <name>`.
- The finding's text says: "restart to load the pkill guard".
- Test in `watchdog.test.mjs`: an agent started before `guardAt` is flagged, one started after isn't, and no cache
  directory means no finding.
- No web change: `web/src/watchdog.tsx` renders the checks the server sends from `CHECKS`.
- **Verify:** `npm test` in `skills/wt-dashboard`, `npx tsc --noEmit -p web`, then one service restart. The live
  panes started before 19:37 should appear as stale-hooks findings. Check this with agent-browser (`--session`
  set to your agent name).

### U3 — doctor line + docs (setup, docs, CLAUDE.md)
- `./setup doctor` uses its existing non-failing `opt` line when any running `claude` process started before the
  installed wt-memory version's `installPath` birth time: "N sessions predate the pkill guard — restart them".
- `docs/features.md`: add the `stale-hooks` check under the watchdog and Observability section, and add the
  numbering rule under "Agents, roles and spawn".
- `CLAUDE.md` Traps: extend the WP-109 line with "plugin hooks load at session start: a guard shipped in git
  protects nothing until the plugin cache has it AND the session restarted (WP-120)".
- **Verify:** `./setup doctor` prints the new line.

## Files

- `skills/wt-agents/scripts/agents.sh`, `skills/wt-agents/scripts/spawn-env.test.mjs`
- `skills/wt-dashboard/watchdog.mjs`, `skills/wt-dashboard/watchdog.test.mjs`, `skills/wt-dashboard/server.mjs`
- `setup`, `docs/features.md`, `CLAUDE.md`

## Definition of Done

The transcript shows each command's output:

1. `node --test skills/wt-agents/scripts/*.test.mjs` passes, and includes the exited-name numbering test.
2. `npm test` in `skills/wt-dashboard` passes, including the `staleAgents` tests. `tsc` is clean.
3. After one service restart, the Observability panel or Inbox lists the agents started before 19:37:40 as
   stale-hooks findings (agent-browser screenshot).
4. `./setup doctor` shows the stale-sessions line.
5. CLAUDE.md Traps and features.md are updated, with one commit per skill touched.
6. The root cause is on the WP-120 ticket as a comment (already posted by the planner; `wt-ticket show WP-120`).

## Risks and deferred

- **Not fixed at the source.** A session started before 19:37, including the umkmall workers, can still
  `pkill … -n` until it restarts. The fix makes that visible; it doesn't prevent it. The user decides the
  restarts. Tests never restart real agents.
- **The orphan panes stay.** `w1Q:p2`, `w1Q:p8`, `w1Q:p9` and `w1V:p2` remain at shells. Three of them can't be
  resumed while a same-named agent is live. Closing them is the user's call; this plan doesn't close panes.
- `settings.json` hooks hot-reloading was left unverifiable by review; the rejection stands on duplication alone.
- `lstart` parsing is locale-sensitive. Run `ps` with `LC_ALL=C`.
