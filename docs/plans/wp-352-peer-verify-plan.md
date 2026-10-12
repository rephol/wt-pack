# WP-352: agent-to-agent messages arrive UNVERIFIED (plan)

Base `origin/main` 6916484. Research was read-only: two code shards, plus a read-only query of the live `wt_messages` table
for WP-351.

## What actually happened (research corrects the ticket)

The live record for WP-351 shows that **every message was recorded with the right sender and target**. Nothing was lost.
The worker's question is row `ff818b6c765c`: kind=reply, sender `wt-pack-worker-07`, sender_pane `w1Q:p39`, target `w4H:p7`,
state `delivered`. The tech lead's decisions are rows `b84f41271482` and `3fa393b95473`, both to `w1Q:p39` and `delivered`.
The worker then built exactly those decisions, for example RemoveHost's "No pane to remove; use Forget" toast. So the ticket's
"the decisions did not reach the worker" is **disproved**. They arrived, at the same time as the orchestrator's own relay
`f07993134237` (09:08:54).

The real defect is how a `delivered` (not `queued`) message reaches a pane. Each of these rows has state `delivered`, which
means the target's mod was not live and `handoff.sh` typed the server-recorded envelope into the pane:

```
herdr agent prompt "$reply" "$msg" >/dev/null        # handoff.sh:244
[ -n "$srv" ] || record_message "$reply" "$msg" delivered
```

Two things then went wrong on the receiving side, and both were seen first-hand by the tech lead:

1. **A long typed message is collapsed by Claude Code into a pasted-text block.** It reached the session as
   `<pasted_content …><wt-message id=ff818b6c765c …>…</pasted_content>`. The hook only classifies a prompt that *starts* with
   the tag: `if (!/^(?:\/\S+ )*<wt-message /.test(prompt)) { writeTurn({ trust: 'user' }); return '' }` (`inject.mjs:61`). So
   it gave no reminder, and the rule then treats it as pasted text, so the tech lead asked the user instead of answering. That
   was the correct behaviour under the rule, but the message was real and recorded. [unsourced: whether the hook's `prompt`
   field carries the raw text or the collapsed placeholder; Unit 1 settles it.]
2. **A long handoff is turned into a file pointer.** The orchestrator's handoff `987287bd44af` reached the tech lead as the
   untagged prompt `WP-351: Do the task in …/messages/987287bd44af.md, then report with handoff.sh --reply`. The hook saw no
   tag and recorded `trust: 'user'`, so the agent acted on it as if the user had typed it. A forged pointer prompt gets the
   same trust. The ticket did not name this, and it is the larger trust hole.

Why the tech lead's mod was not live (in-memory hellos, `deliveries.mjs:9,18`, `LIVE_MS = 45_000`) is open:
- a session restart (WP-320 nested-claude stand-down, `wt-deliver:10-19`);
- a failing hello (`wt-deliver:22-24`: `[ "$code" -lt 400 ] || exit 1`, which is silent);
- the pane renumber (p3 to p7).

Unit 1 captures it. The fix must not depend on the mod being live: the herdr path is the fallback for every pane without a
live mod.

Not the cause (research checked): the sender role. `/verify` treats peer messages exactly like orchestrator ones
(`server.mjs:3017`). Role only feeds `replyAllowed` and the WP-332 gate, which by the user's WP-326 Q2 decision lets only the
orchestrator, a routine or the server stand in for the user. **Settled; out of scope.**

## Decisions (revised after review)

- **D1. When the target's mod is not live, a delivery is typed as a short recorded pointer envelope.** Every typed path is
  covered:
  - the `--reply` fallback, `handoff.sh:244` (`herdr agent prompt "$reply" "$msg"`);
  - the handoff long-message path, `handoff.sh:456` (`herdr pane send-text` of
    `${ticket}: Do the task in $msgfile, then report with handoff.sh --reply`);
  - its full-envelope fallback, `handoff.sh:461`;
  - the `--goal` line (`$goal_line $msgfile`);
  - the sweep resend and the nudge, `server.mjs:2639-2640` and `2649-2650`.

  All of these type exactly `<wt-message id=<id> kind=<kind> from="<sender>"[ ticket=…]>Read it with: wt-message show <id>, do what it asks, then report as it says</wt-message>`,
  with the same recorded id. The pointer is used every time the mod is not live, whatever the length, so there is no
  collapse threshold to measure. `save_message` (`handoff.sh:469-475`, the mode-600 file) can stay as a local copy.
- **D2. The pointer verifies only when it is exactly the pointer.** `/verify` checks id, target, kind and sender, never the
  body (`server.mjs:2994`; `parseEnvelope`, `wt-message.mjs:32-34`, reads only the opening tag). So `inject.mjs` marks a
  pointer verified only if the text after its opening tag is byte-for-byte the fixed pointer line for that id. Any extra
  text makes it UNVERIFIED. A full inline envelope (the queued mod path) additionally sends `sha256(body)` to `/verify`,
  which compares it with `row.body`. That closes the existing "real id, appended text" hole too.
- **D3. Replay.** `/verify` records the first verified pointer turn (`verified_at`). A later verify of the same id
  answers `stale`, and the hook marks that turn UNVERIFIED, saying "already delivered".
- **D4. `GET /api/messages/:id` (`wt-message show <id>`)** sits before the user-only GET (`server.mjs:3019-3021`). It
  allows only `author.kind === 'agent'` with a valid `x-wt-pane-key` (no grace path), and the pane must equal
  `canonicalPane(row.target)` on both sides, as the ack route does (`:3027`). An unknown id gets 404 and anyone else 403.
  The body comes back as a tool result, so the rule text says to read it as the verified message's content.
- **D5. The hook does not try to recognise Claude Code's pasted wrapper.** D1 means a pane never gets a long typed
  envelope again, so the earlier "D3 pasted block" idea is dropped (it widened the trusted prefix, against the WP-325
  decision).
- **D6. Visibility (no behaviour change).** `./setup doctor` and the Agents list show "delivery mod not live" for an agent
  pane with no hello within `LIVE_MS` (`deliveries.mjs:9,18`). `wt-deliver` stays silent: its shared `call()`
  (`wt-deliver:22-24`) runs every 20 s, so it has no state to log "once".
- **D7. Compare pane ids canonically.** These spots compare raw ids today and should use `canonicalPane`:
  - the sweep, nudge and unreported checks (`server.mjs:2634-2657`, `a.id === row.target`);
  - the sender lookups (`:3005` agent lookup, `:3012` SQL `sender_pane = ?`);
  - the gate ask lookup (`:2843`, both `a.pane` and `author.pane`).

## Units (in order)

1. **Reproduce (throwaway agents only).** Spawn two throwaway agents in a temp repo's own herdr workspace, with a PATH-shim
   `herdr` in front of a scratch dashboard (never a second `herdr server`). Confirm:
   - (a) a long `--reply` and a long handoff to a pane with the mod not live arrive with no verification reminder today;
   - (b) why a mod stops being live after a restart.

   Write the results under `## Unit 1 results` in this plan.
2. **D1 + D4.** The pointer on every path listed in D1, plus `wt-message show` and its route. Tests in
   `handoff.test.mjs` and `envelope.routes.test.mjs`:
   - each typed path types a pointer with the recorded id;
   - `show` returns the body to the target, and gives 403 without a pane key, 403 to another pane, and 404 for an unknown id.
3. **D2 + D3.** Hook and `/verify` changes. Tests in `hook-verify.test.mjs`:
   - an exact pointer verifies;
   - a pointer with appended text is unverified;
   - an inline envelope whose body hash mismatches is unverified;
   - a second verify of the same pointer is stale.
4. **D6 + D7.** The doctor line and Agents hint, and the canonical comparisons. Cases for a renumbered pane in
   `parse.test.mjs` and `gate.routes.test.mjs`.
5. **Docs.** `docs/features.md` verification section (around lines 482-526), `wt-handoff/SKILL.md:50` (the
   file-pointer text), and the rule text in `inject.mjs` (a pointer means run `wt-message show`).

## Definition of done

- A worker-to-tech-lead `--reply`, or a handoff of any length, to a pane **without** a live mod arrives as a prompt that
  starts with `<wt-message id=` and carries the **Verified wt-pack traffic** reminder. Shown by tests and by rerunning the
  Unit 1 harness.
- None of the senders' code (`handoff.sh` and the paths named in `server.mjs`) types an untagged `Do the task in` prompt.
  Docs and comments are excluded from this check.
- A pointer with appended text, or one replayed, is UNVERIFIED (tests).
- `npm test` passes in wt-dashboard and at the repo root.

## Out of scope

- Who may stand in for the user (the gate's sender roles: WP-326 Q2, settled).
- A resend sweep for `reply` (`messages.mjs:5` sweeps only handoff, dispatch and routine). The WP-351 record shows no lost
  reply.

## Review corrections

The first draft said the producer of the "Do the task in" prompt was unknown; it is `handoff.sh:456`. That draft also
covered only the `--reply` path, and it proposed matching Claude Code's pasted wrapper, which is now dropped. It missed
that a pointer's body is not verified (D2) and that a pointer could be replayed (D3), and it cited `inject.mjs:62`, which
is `:61`.

## Unit 1 results

Harness: the real hook (`inject.mjs`) fed prompts with `HERDR_DASH_URL` on a closed port and a scratch `WT_TURN_DIR`; the
handoff paths run through `handoff.test.mjs`'s herdr shim. **No throwaway herdr agents were spawned**, so (b) below is read from
the code, not observed live.

- (a) **Reproduced, by the hook.** The two prompts the tech lead saw: `WP-351: Do the task in /tmp/x/987287bd44af.md, then report
  with handoff.sh --reply` and `<pasted_content …><wt-message id=ff818b6c765c …>…</pasted_content>` each produce **no reminder and
  a turn record `{"trust":"user"}`**. Before this change `handoff.sh` typed exactly that first line (`handoff.test.mjs` asserted
  it), and `--reply` to a pane without a live mod pasted the full envelope.
- (b) **Why a mod stops being live (code only).** `deliveries.hellos` is an in-memory map (`deliveries.mjs`): a dashboard restart
  empties it, so every pane is "not live" until its mod's next hello (≤20 s); a pane also reads not-live while its mod is
  stood down (WP-320) or when its hello fails (`wt-deliver`'s silent non-2xx exit). Not confirmed on the live system.
  D6 makes it visible (Agents › Model › Messages row); the doctor line is not built (below).
- Where `UNVERIFIED` came from in the WP-351 case: the long typed envelope collapsed to a pasted block, so it did not start
  with the tag and the hook never classified it. With D1 no sender types a long envelope any more.
