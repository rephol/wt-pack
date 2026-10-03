# WP-206: Mod that captures AskUserQuestion natively into wt-ask

Base: `origin/main` @ 6330998. Branch `wp-206-ask-capture-mod`.

## What research found (evidence)
- **The mod API can answer a tool call itself.** In the build's types (`plugin-authoring/types/claude-code.d.ts`,
  Claude Code 2.1.288), `ToolCallResult` is either `{ deny: string }` ("Refuses the call: the model receives the
  text as an error result") or a result object whose field "The tool's output: from core the tool's record …;
  from a hook, its own" (`:11997-12012`). A `tool.call` hook on `{ tool: 'AskUserQuestion' }` that returns
  without calling `next` therefore answers the call, and calling `next(e)` falls through to the native dialog.
  That is exactly the ticket's fallback. The exact result record shape for AskUserQuestion (its `answers` map)
  is **[unsourced]**. The worker reads `claude-code-tools/index.d.ts` once the mod has loaded and copies the
  core record shape, so the model sees the same thing it gets from the dialog.
- The mod runtime has no Node and no fetch listed. Host work goes through `$.process.run` ("runs a host command
  by argv") and `$.fs` (`reference.md:135`). So the mod shells out to `wt-ask`, which already does the HTTP
  call and the pane identity.
- **Load timing (the ticket's open question):** a mod in a plugin folder that the session watches reloads on
  save (`reference.md:68-69`: "saving a file reloads the hooks module"). An installed marketplace plugin
  (`wt-pack@wt-pack`) is not described as watched. That matches CLAUDE.md's WP-120 trap ("Plugin hooks load at
  session start … until the plugin cache has it AND the session restarted"). **Assume respawn is needed** for
  running agents, and verify it in the live check.
- **wt-ask today is fire-and-forget.** Its usage line is
  `wt-ask "<question>" --option A … | --json <file> … | --resolve <id>` (`skills/wt-ask/scripts/wt-ask`
  header). The answer goes back to the pane as a `kind=reply` wt-message (`wt-dashboard/asks.mjs:52-53`
  "deliver(pane, text): sends a kind=reply wt-message to the pane"). The API has `POST /api/asks`,
  `GET /api/asks?room=&open=1`, answer, and resolve (`server.mjs:2399-2400`), but no way for a caller to
  *wait* for one ask's answer. A blocking mod needs that. A typed-in wt-message reply would arrive as a new
  user turn, not as the tool's result.
- The root plugin's `hooks/hooks.json` holds command hooks under `"hooks"` (SessionStart, UserPromptSubmit,
  PreToolUse Bash). A mod's hooks.json is `{ "modules": ["./register.tsx"] }`. Whether one file may carry both
  keys is **[unsourced]**, so the mod ships as its **own plugin** (see decision 1).

## Settled decisions (headless: stated assumptions)
1. **Packaging:** a new plugin dir `skills/wt-ask/mod/` (`.claude-plugin/plugin.json`,
   `hooks/hooks.json` `{ "modules": ["./register.ts"] }`, `hooks/register.ts`), added as a second plugin
   `wt-ask-mod` in `.claude-plugin/marketplace.json`. `./setup install` enables it, and doctor reports it.
   Keeping it separate means a broken mod can't take down wt-memory's hooks, and it can be disabled alone.
   If the worker verifies that a combined hooks.json is valid, it may fold the mod into the root plugin
   instead and record that choice.
2. **When the mod captures:** only in a herdr agent pane that wt-pack spawned, meaning `HERDR_PANE_ID` is
   set, the pane has a `role` token, and `wt-ask --ping` exits 0 (dashboard reachable, pane known). In the
   user's own interactive session (no herdr pane) it calls `next(e)`, which keeps the native dialog. That
   matches WP-164's rule: "the user's own session uses the native tool".
3. **Waiting:** add `wt-ask --wait <id> [--timeout S]` and `--json-out`. It polls a new `GET /api/asks/:id`
   (pane-authenticated, own asks only) every 2 s and prints the answer JSON on `answered`. It exits 3 on
   `resolved`/timeout. The hook runs `wt-ask --json <tmpfile> --no-deliver` (a new flag: the server skips the
   wt-message delivery for this ask, since the answer returns through the tool result) then `--wait`.
4. **Timeout and fallback:** on an unreachable dashboard, or any `wt-ask` error, call `next(e)` (native
   dialog). On a wait timeout (default 30 min, `options.timeoutMin` from `userConfig`), resolve the ask and
   return `{ deny: "No answer from the user within N min (asked via wt-dashboard); continue without it or
   ask again." }`. Never hang the turn forever.
5. **The scrape path stays for now.** The pane-scrape picker path (`parsePicker`/`answerPlan`, WP-164/165/203)
   still handles agents without the mod (not yet respawned, plugin-only installs). With the mod on, no native
   picker appears, so the scrape path idles. Removing it is a follow-up ticket filed at merge, not part of
   this ticket. **That deliberately overrides the ticket's word "replacing"**: until every agent has
   respawned, removing it would break question answering.

## Units
1. **Server and CLI** (wt-dashboard + wt-ask):
   - `GET /api/asks/:id` (pane-auth, own asks)
   - `noDeliver` on create
   - `wt-ask --wait/--ping/--no-deliver`

   Tests: in `asks.test.mjs`, a `noDeliver` ask calls no `deliver`, and GET by another pane returns 403. In
   `wt-ask.test.mjs` (async `execFile`, per the CLAUDE.md WP-164 trap), `--wait` returns on answer and exits 3
   on resolve or timeout.
2. **The mod** (`skills/wt-ask/mod`): `register.ts` with the `tool.call` hook per decisions 2–4, plus
   `$.ui.status('asked in wt-dashboard…')` while waiting. A `register.test.ts` run by `claude plugin test`:
   a reachable stub returns the answer as the tool result; an unreachable one calls `next`; a timeout denies.
   `claude plugin validate skills/wt-ask/mod` and `tsc -p skills/wt-ask/mod` are clean.
3. **Install:** marketplace entry, `setup` enable plus a doctor line, and the
   `paths.test.mjs` rule (no `~/.claude/skills` in the mod).
4. **Docs:** `docs/features.md` (the mod, the fallback, and that a respawn is needed). The wt-ask SKILL.md notes
   that agents don't need to call `wt-ask` by hand for a native question any more.

## Definition of done
Each item is checkable from a transcript:
- `cd skills/wt-dashboard && npm test` and `node --test skills/wt-ask/scripts/*.test.mjs` pass.
- `claude plugin validate skills/wt-ask/mod`, `claude plugin test skills/wt-ask/mod` and
  `tsc -p skills/wt-ask/mod` pass.
- A live check with a **throwaway agent** spawned after install. Prompt it to call AskUserQuestion with 2
  questions, then:
  - a chip and Inbox card appear, but no native picker (`herdr pane read` shows the "asked in wt-dashboard"
    status, not `Enter to select`)
  - answering in the dashboard makes the agent's transcript show the tool result with both answers
  - killing the dashboard and asking again shows the native picker
  - an already-running agent from before install keeps using the native picker until respawned, which
    records the load-timing answer

  Clean up afterwards.
- `./setup doctor` reports the mod as enabled.

## Order
1 → 2 → 3 → 4. Commit per skill (`wt-dashboard`, `wt-ask`, setup/marketplace, docs).

## Risks
- If the mod's result shape differs from core's, the model may misread the answer. Copy core's record type
  exactly, and assert it in the test.
- A long `--wait` inside `$.process.run`: check that the API allows a long-running command (a timeout
  parameter) **[unsourced]**. If it caps the time, loop short waits in the hook.
