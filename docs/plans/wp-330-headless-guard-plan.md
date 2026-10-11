# WP-330 — Headless gate

Source: `docs/plans/wp-326-envelope-trust-audit.md` remedy S4 (findings 2, 3). Builds on WP-327 (pane key), WP-328
(server-built envelopes), WP-329 (hook verifies against the store). Only WP-330.

## Today (read from the tree, `skills/wt-dashboard/server.mjs` `headlessApi` ~3085-3118, `headless.mjs`)
- Writes: `roomAuthor(req)`; a non-user may only `POST /api/headless` (spawn) and `POST /:id/message`; stop/interrupt
  also for the run's `spawner` or an orchestrator-role pane (WP-317, `:3095-3098`).
- Spawn: `h.spawn({...b, spawner: who.kind === 'agent' ? who.pane : null})` — `permissionMode` comes from the body for
  any caller, so a pane can spawn `bypassPermissions` (finding 2, verified in the audit). `cwd` only has to be an
  existing directory.
- Message: `h.message(id, b.text)` for **any** pane → `userLine(text)` (`headless.mjs:414`) — the run reads raw text as
  its user (finding 3). No sender record, no ownership check.
- handoff.sh `hl_post` (`:184`) posts a locally wrapped envelope (`--reply` to a headless sender, `--pane <run>`);
  `agents.sh` `--headless` paths use `/api/headless` too (`agents.sh:62-65`).
- Headless env already carries `WT_HEADLESS_ID: id` (`headless.mjs:161`), but no `HERDR_PANE_ID`, so WP-329's hook
  `verify()` (`inject.mjs:35`, pane-authenticated `GET /api/messages/:id/verify`) marks **every** message into a run
  UNVERIFIED today.

## Design
1. **Spawn cap** (server): `who.kind === 'agent'` → `permissionMode` must be absent or `default`, else 403
   `an agent spawns headless runs in default mode only (WP-330)`. The user (session cookie) unchanged. Note: absent
   means "the user's Claude Code settings decide" (WP-300) — that may itself be bypass if the user's settings say so;
   for an agent spawn pass `default` explicitly so the cap holds (`req_permission_mode = 'default'`).
2. **cwd under a project root**: agent spawns only; `realpath(cwd)` must be inside one of `projectRoots()` values
   (or their `.claude/worktrees/*`), else 403. User spawns unchanged.
3. **Message gate**: `POST /:id/message` from a pane allowed only if `run.spawner === who.pane` or the caller is an
   orchestrator-role pane (reuse the `me.tags?.role || me.pool` check from `:3098` — lift it into one helper used by
   stop/interrupt and message). Else 403. The user unchanged (raw text: the user *is* the user).
4. **Server wraps** a pane's message: body `{text}` is the plain text; server builds
   `wrap({kind:'handoff', from: who.name}, text)` (wrap unTags), records `messages.record({id, sender: who.name,
   sender_pane: who.pane, target: run.id, kind:'handoff', body})`, then `h.message(id, wrapped)`. A pane-sent `text`
   that already parses as an envelope (`parseEnvelope`) is unwrapped? **No** — refuse 400 `send plain text (WP-330)`,
   as WP-328 did for deliveries. An agent spawn's first `prompt` gets the same wrap + record.
5. **Verification inside a run** (so wrapped messages are not all UNVERIFIED): mint a per-run key at spawn
   (`randomBytes(32)`, stored in a new `headless_runs.run_key` column, never returned by GET routes), pass it as
   `WT_RUN_KEY` beside `WT_HEADLESS_ID`. `roomAuthor` (or the verify route only — prefer the narrow change: the verify
   route) accepts `x-wt-headless: <id>` + `x-wt-run-key` (timingSafeEqual) as identity `target = run id`. `inject.mjs`
   `verify()` sends those headers when `WT_HEADLESS_ID` is set and `HERDR_PANE_ID` is not.
6. **CLIs**: handoff.sh `hl_post` sends plain text for a pane caller (drop the local wrap for headless; keep it only
   when `deliver_token` is set — server-run, which keeps today's raw/wrapped path). agents.sh `--headless` spawn from a
   pane: don't send a permissionMode other than default (check what it sends today; if it forwards a flag, map
   non-default to an error message before the call).

## Units (one commit per skill)
- **U1 wt-dashboard** — 1-5 server side. Tests in `headless.routes.test.mjs` (fake claude, WP-327 keyed-pane fixture):
  (a) **pane spawn with `bypassPermissions` → 403**, with `acceptEdits` → 403, with none → run stored with
  `default`; user spawn with bypass → OK; (b) pane spawn cwd outside every project root → 403; (c) **other pane
  message → 403**; (d) **spawner message → 200** and the fake claude's stdin got a `<wt-message … kind=handoff
  from="<spawner name>">` line and one `wt_messages` row target = run id; (e) **orchestrator pane message → 200**;
  (f) user message → raw text, no wrap; (g) pane-sent pre-wrapped text → 400; (h) verify route with right/ wrong
  run key → verified / 403; `run_key` absent from `GET /api/headless/:id`.
- **U2 wt-memory** — `inject.mjs` verify headers for a headless run + test with a stub server (async execFile).
- **U3 wt-handoff** — `hl_post` plain text; `handoff.test.mjs` `--reply` to a headless sender posts `{text: plain}`.
- **U4 wt-agents** — only if agents.sh forwards a permission mode for `--headless`; `spawn-env`/`mcp` tests green.
- **U5 docs/features.md** — Headless section: agent spawns are default-mode and project-rooted; who may message a run;
  messages arrive as verified handoffs.

## Definition of done
- `npm test` (skills/wt-dashboard), `node --test skills/wt-memory/scripts/*.test.mjs`,
  `node --test skills/wt-handoff/scripts/handoff.test.mjs` pass with U1 (a)-(h).
- WP-317 paths still work by test: `agents.sh send/--reuse/stop`, `handoff.sh --pane <run>` and `--reply <run>` from
  the spawner pane.
- Throwaway runs only (fake claude / throwaway server); never real agents. No merge, no push: reply with the branch.
  Merge order note for the orchestrator: server before hook (a new hook against an old server = UNVERIFIED).
- No e2e writing or running.

## QA brief
Dashboard → New agent → Headless: the user can still pick Bypass permissions and start (unchanged). From a throwaway
pane: `agents.sh spawn worker --headless` with bypass is refused with the WP-330 message; a `handoff.sh --pane <run>`
from the spawner arrives in the run's Conversation as a wt-message from that pane's name; the same from another
throwaway pane is refused. Check the refusal toast/text fits at 412x700 and iPhone 13.
