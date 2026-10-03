# WP-210: Mod for native wt-message/room delivery (pull queue + `$.prompt.submit`, not `session.receive`)

Base: `origin/main` @ 702676d (WP-206's wt-ask-mod present). Branch `wp-210-session-receive-mod`.

## What research found: the ticket's mechanism does not fit
Read from this build's mod API (`plugin-authoring/types/claude-code.d.ts`, Claude Code 2.1.288):
- `session.receive` is a hook on deliveries the **engine's bridge** already routes: "one inbound delivery,
  sanitized, before it is queued (a relay's event, a peer's message, a message for an agent)" (`:10647`). Its
  `origin.kind` values are `'bridge' | 'task-notification' | 'scheduled-trigger' | 'peer-send-message' |
  'projects-relay' | 'slack-ping' | 'unclassified'`, or `'peer' | 'coordinator'` (another session's model,
  or the agent-team mailbox) (`:10685-10740`). A hook can only pass a delivery on, rewrite it, or consume it
  (`consumed: string` → "not queued, not written to the transcript", `:10760-10766`). **It cannot originate a
  delivery.**
- The sender side, `$.session.send({ to: { sessionId } | { agentId } | name, text })`, is a call made from
  *inside* a Claude Code session ("the model's SendMessage tool's own call and delivery", `:2673-2685`).
  wt-pack's senders are not sessions: they are `handoff.sh` (a shell script), the dashboard server (Node),
  dispatch, and routines. None of them can call `$.session.send`. The only same-user file channel is the
  agent-team mailbox ("read from the team's inbox file … any same-user process", `isVerified: false`), and
  that requires the agents to be members of a Claude agent team. wt-pack's herdr pools are not teams.
  Using it would be an undocumented dependency on another feature's file format. **Rejected.**
- **What does fit:** `$.prompt.submit({ text })` is "the same call the engine makes for a typed prompt; a turn
  of its own, once the session is idle", with `e.origin = { kind: 'plugin', name }` (`:2733-2744`). Paired
  with a **pull** from a per-pane queue, the mod knows exactly when a message entered the conversation. That is
  the delivered-state the ticket wants (WP-200), and it involves no pasted keystrokes.
- So the plan **replaces "session.receive" with: queue in the dashboard → mod pulls → `$.prompt.submit` →
  ack**. `session.receive` is still used for one small job: tagging a peer's `SendMessage` from another
  wt-pack agent (optional, see U4).

## Settled decisions (headless: stated assumptions)
1. **Queue:** a new `deliveries` table in `data/wt.db`: `id, pane, kind, body (the full <wt-message>…
   text), status (queued|delivered|pasted|failed), created, delivered_at`. The routes are:
   - `POST /api/deliveries` (from the server's own senders and from `handoff.sh` through a loopback call with
     the session or pane header the room CLI uses)
   - `GET /api/deliveries/next?pane=` (pane-auth: the pane may only read its own)
   - `POST /api/deliveries/:id/ack`
2. **Who sends through the queue:** one function in the server, `deliver(pane, text)`. It already exists for asks
   (`asks.mjs` "deliver(pane, text): sends a kind=reply wt-message … wired to handoff.sh --reply") and is
   used by room delivery, dispatch and asks. It enqueues when the pane's mod is **live** (decision 3), and
   otherwise uses today's herdr paste. `handoff.sh` does the same check before pasting (`curl` the
   liveness endpoint; any failure → paste). Everything that sends funnels through these two places, so
   there is no per-caller guard (the WP-147/157 lesson: find every write path; the worker greps for
   `agent prompt` / `pane send-text` across `skills/` and routes each one through them).
3. **Liveness:** the mod `POST`s `/api/deliveries/hello?pane=` on `session.start` and every 20 s
   (`$.clock`). The server treats a pane as mod-live if hello is younger than 45 s. Safe-mode, a crash, or the
   mod not loaded → no hello → paste fallback.
4. **Slash commands:** handoff sends `/goal <wt-message…>` on purpose so the worker's goal hook arms.
   Whether `$.prompt.submit` with text starting `/` runs the command is **[unsourced: test it first in U2; the
   types say only "the same call the engine makes for a typed prompt"]**. If it does not run the command, the
   mod keeps `/goal` traffic on the paste path (`kind=handoff|dispatch` that begin with `/goal`). It enqueues
   only plain wt-messages: `reply`, `system`, `routine`, and room-messages. This keeps the reliable,
   no-keystroke path for the common traffic without breaking goal arming. Decide from the U2 result and
   record it in the plan's commit message.
5. **Busy session:** the mod pulls only while idle (after `turn.end`, and on a 3 s `$.clock` tick when no turn
   runs). It submits one delivery, acks it `delivered` on the `prompt.submit` result, and pulls the next
   after that turn ends. This preserves order, with no interleaving into a running turn.
6. **HTTP from the mod:** use `$.process.run({ argv: ['curl', …] })` to loopback, mirroring wt-ask-mod
   (WP-206 shells out to `wt-ask`). `$.http.fetch` exists, but whether it allows `127.0.0.1` is **[unsourced]**,
   so don't depend on it.
7. **Packaging:** like WP-206, its own plugin `wt-deliver-mod` inside `skills/wt-room` (rooms are its main
   traffic), registered in `.claude-plugin/marketplace.json` and enabled by `./setup`. A respawn is needed to
   load it, the same as WP-206 found. That is out of scope for the ticket's "ship in wt-pack@wt-pack" wording:
   a separate plugin can be disabled alone, which matters for a mod that injects prompts.

## Units
1. **Server queue + liveness** (wt-dashboard): table, routes, `deliver()` choosing queue vs paste, and the
   delivered state exposed to the WP-200 UI **[unsourced: what WP-200 shows; the worker reads its ticket]**.
   Tests: enqueue only when hello is fresh; another pane's `next` → 403; ack transitions; stale hello →
   paste is called.
2. **Probe** (no ship): a scratch mod in the dev-mods folder that runs `$.prompt.submit({ text: '/goal
   test' })` in a throwaway session. Record whether `/goal` armed. This settles decision 4. Delete it after.
3. **The mod** (`skills/wt-room/mod/`): `session.start` hello and timer, the idle pull loop, `prompt.submit`,
   and ack. A `register.test.ts` run with `claude plugin test`: a queued item is submitted once and acked;
   a busy turn defers it; a curl failure → no submit and a retry next tick.
4. **(Optional) `session.receive` tag:** a peer `SendMessage` whose `origin.plugin` is `wt-deliver-mod` is
   passed through unchanged. Skip this unless U3 needs it.
5. **handoff.sh:** a liveness check, enqueue for plain kinds per decision 4, else paste. Tests in
   `handoff.test.mjs` with a stub server: live → POST and no `herdr` paste call; dead → paste.
6. **Docs:** `docs/features.md` (delivery states, fallback, respawn).

## Definition of done
Each item is checkable from a transcript:
- `cd skills/wt-dashboard && npm test`, `node --test skills/wt-handoff/scripts/*.test.mjs`,
  `claude plugin validate skills/wt-room/mod`, and `claude plugin test skills/wt-room/mod` all pass.
- The U2 probe result is stated in the commit message (whether `/goal` via `prompt.submit` arms the goal or
  not).
- A live check with a **throwaway agent** spawned after install:
  - `room post <tmp-room> "@<agent> ping"` → the delivery row goes `queued → delivered`
    (`sqlite3 … select status`), and the agent's transcript shows the message as a plugin-origin prompt with
    no pasted text in `herdr pane read`
  - disable the mod and respawn → the same post is pasted (`status=pasted`)

  Clean up afterwards.
- `./setup doctor` reports `wt-deliver-mod` enabled.

## Order
1 → 2 → 3 → 5 → 6, with 4 only if needed. Commit per skill.

## Risks
- Double delivery if both paths fire. `deliver()` picks exactly one per message, and the queue row is the
  record.
- Prompt injection: queued text is wt-pack traffic already wrapped as `<wt-message>`, and the mod submits it
  verbatim. It never unwraps. The plugin-origin name tells the model it was not typed by the user.
