# WP-327 — Per-pane key: `x-herdr-pane` alone must not prove identity

Source: `docs/plans/wp-326-envelope-trust-audit.md` finding 1 (root) / remedy S1. First link of the chain
WP-327 → 328 → 329 → 330; only WP-327 here.

## Today (read from the tree)
- `skills/wt-dashboard/server.mjs:3094` `roomAuthor(req)`: no session cookie → takes `req.headers['x-herdr-pane']`,
  checks loopback address + `Host: 127.0.0.1:<port>`, `canonicalPane(pane)`, and that a live local agent has that id.
  Nothing else. 17 call sites in server.mjs route through it (`grep -c "roomAuthor(" server.mjs` = 17), including
  `GET /api/deliveries/next`, hello and ack (the routes the ticket's done check names).
- Senders of the header (all `-H "x-herdr-pane: ${HERDR_PANE_ID…}"`): `skills/wt-ticket/scripts/wt-ticket:29`,
  `skills/wt-handoff/scripts/handoff.sh` (lines 98, 159, 165, 175, 198, 428, 452, 589), `skills/wt-ask/scripts/wt-ask:18`,
  `skills/wt-room/scripts/room:16,47,55`, `skills/wt-room/mod/scripts/wt-deliver:22`,
  `skills/wt-agents/scripts/agents.sh:64,126`. handoff.sh's `x-wt-server` (deliver token) branch is a different
  credential and is untouched.
- Panes are started only by `agents.sh spawn` (handoff.sh spawns through it), via
  `herdr agent start "$label" --kind claude --pane "$pane" -- "$@"` (`agents.sh:440`), and it already passes pane env
  with herdr `--env K=V` (`agents.sh:396-398`: PATH shim, `WT_KILL_SHIM_DIR`, `CLAUDE_ENV_FILE`). Every CLI above runs
  inside that claude's Bash, so an env var set there reaches all of them.

## Design
1. **Mint at spawn** (`agents.sh spawn`): `key=$(openssl rand -hex 32)`; resolve the pane's canonical id
   (`herdr pane get "$pane"` → `.result.pane.pane_id`, the same id `canonicalPane()` returns — CLAUDE.md trap: the env
   id may be the stable id); write the key to `~/.local/share/wt-dashboard/pane-keys/<canonical id>` (dir 0700, file
   0600, `umask 077`, write tmp + `mv`); add `--env "WT_PANE_KEY=$key"` beside the existing `--env` args. Never a pane
   token, never `agent-tags.json` (the ticket's rule; pane tokens are readable by every pane via `herdr pane get`).
   A respawn into the same pane overwrites the file, so the old process's key dies with it.
2. **Send** — every sender above adds `${WT_PANE_KEY:+-H "x-wt-pane-key: $WT_PANE_KEY"}` next to its
   `x-herdr-pane` header. Absent var → no header → grace path (below), so no CLI breaks.
3. **Check** — in `roomAuthor`, after the agent lookup: read `pane-keys/<a.id>` (sync read, tiny; ENOENT = no key).
   - file exists: header must equal it (`crypto.timingSafeEqual` on equal-length buffers; length mismatch → refuse)
     else 403 `pane key mismatch`.
   - no file: **grace** — accept as today, remember the pane id in a `Set` for doctor, unless
     `WT_PANE_KEY_STRICT=1` (config env) → 403 `pane has no key; respawn it`.
   Key files whose pane is no longer a live agent are deleted by the existing agent sweep, or lazily
   `[unsourced: no sweep identified; worker picks the nearest existing periodic loop or skips]`.
4. **Doctor** — `GET /api/pane-keys/status` is not needed: `./setup doctor` lists live local agents
   (`herdr agent list` / existing doctor helpers) and warns `N agent pane(s) run without a pane key (grace) — respawn
   them`, counting panes with no file in `pane-keys/`.

Settled (planner, no blocking question; orchestrator may override): grace stays open until `WT_PANE_KEY_STRICT=1`;
closing it by default is a later ticket once every live agent has been respawned.

## Out of scope / residual (record in the note to the orchestrator)
- Same-user processes can read `pane-keys/` and other processes' env; the key stops header forgery by anything that
  only knows a pane id (e.g. a prompt-injected agent guessing ids), not a same-user process that reads files. Later
  links (328+) build on this.
- Headless runs are not panes; untouched.

## Units
- **U1 server** (`skills/wt-dashboard/server.mjs` roomAuthor + `WT_PANE_KEY_STRICT` read from config env like other
  `WT_*`). Tests in the existing route-test file that already stubs agents for roomAuthor
  (`grep -ln "x-herdr-pane" skills/wt-dashboard/*.test.mjs` — use the one covering deliveries): temp `DATA` dir;
  (a) keyed pane + right key → 200 on `GET /api/deliveries/next`, hello, ack; (b) same routes with a claimed foreign
  keyed pane and no/wrong key → 403; (c) unkeyed pane, no header → 200 (grace); (d) same with
  `WT_PANE_KEY_STRICT=1` → 403.
- **U2 agents.sh** mint + `--env`. Extend `skills/wt-agents/scripts/spawn-env.test.mjs` (its herdr shim already
  captures the `agent start` argv): spawn writes a 0600 file under a temp HOME and passes `WT_PANE_KEY=<same key>`;
  the key is not in any `report-metadata --token`.
- **U3 CLIs** — one commit per skill (CLAUDE.md): wt-ticket, wt-handoff, wt-ask, wt-room (room + mod/wt-deliver),
  wt-agents. Each adds the conditional header. Existing CLI tests must stay green.
- **U4 doctor** — `setup` warning line.
- **U5 docs** — `docs/features.md` (security / agent identity section: key, grace, strict flag, doctor) and one
  CLAUDE.md Traps line: a pane's identity is `x-herdr-pane` + `x-wt-pane-key` (`WT_PANE_KEY`, minted by
  `agents.sh spawn`, file in `~/.local/share/wt-dashboard/pane-keys/`); a new CLI that calls a pane route must send
  both, and a pane started outside `agents.sh` has no key (grace only).

## Definition of done
- `npm test` (skills/wt-dashboard) and `node --test skills/wt-agents/scripts/*.test.mjs` pass, with U1 (a)–(d) and
  the U2 test present.
- Live check with a **throwaway** agent only (temp repo, `spike327-` name, removed after): spawn via
  `agents.sh spawn`, `room list` from inside it works (keyed); `curl -H "x-herdr-pane: <its id>"` from another shell
  without the key → 403. Never use or forge a real agent's pane.
- Existing un-keyed live agents keep working (grace): `wt-ticket show WP-327` from this planner pane still succeeds
  after the server restart.
- No merge, no push: reply to the orchestrator with the branch.
- No e2e writing or running.

## QA brief
No UI. QA: on the throwaway agent, (1) `room list` works; (2) the forged curl above returns 403 `pane key mismatch`;
(3) `./setup doctor` shows the grace warning while old agents run; (4) `wt-ticket show` from an old pane still works.
