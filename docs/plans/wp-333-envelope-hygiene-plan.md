# WP-333 — Envelope hygiene (+ verify-card cap)

Source: `docs/plans/wp-326-envelope-trust-audit.md` S7 (finding 8 hoist, finding 12), plus the orchestrator's ticket
comment (2026-10-11 14:26): `GET /api/messages/:id/verify` raises one Inbox card per unknown id, so a pane can flood
the Inbox with random ids — cap per pane per time window. Only WP-333.

## Today (read from the tree)
- `skills/wt-shared/scripts/wt-message.mjs`
  - `:9` `attr = t.replace(/["<>&\n]/g, '')` — `\r`, U+2028/2029, any length pass (finding 12).
  - `:11` `unTag = t.replace(/<(\/?)(room-message|wt-message)/gi, '<$1$2​')` — misses `< wt-message`
    (whitespace), fullwidth `＜` (U+FF1C), and a zero-width char inside the name (`wt​-message`).
  - `:18-21` `wrap` hoists **any** leading `/cmd` ahead of the envelope (finding 8). WP-328 already stops a pane caller
    from hoisting anything but `/goal` on the deliveries route (server side), but every server-side `wrap` caller still
    hoists anything.
  - `:27-29` `parseEnvelope` (WP-329), the single classifier.
- `skills/wt-dashboard/rooms.mjs` `batchPrompt`: replyTo is inlined as `(replying to <name>: "<text>") ` inside the body
  of a `kind=user`/`agent` tag, so the quoted text reads as that author's words; context lines are
  `<author name>: <text>` under `from="dashboard"`, so a name like `user` or `dashboard` is indistinguishable.
- `skills/wt-dashboard/server.mjs:2945` the verify route's Inbox card key `unverified|<pane>|<id>` — dedupes per id
  only.

## Design
1. **Hoist allowlist** in `wrap`: hoist only `/goal` and `/wt-[a-z0-9-]+`; any other leading `/x` stays in the body
   (prefix the body with U+200B so the receiver's harness does not run it — same trick WP-328 used). `wrap` gains an
   option `{hoist: true|false}` default **false**; set `true` only at server call sites that need it (Dispatch's
   `/wt-*` prompts, routines, handoff.sh `--goal` via the server) — worker greps every `wrap(` caller and lists the ones
   it turns on in the commit message.
2. **attr allowlist**: `String(t).replace(/[^\w .@#:-]/g, '').slice(0, 40)`. Check every `from=` producer still fits
   (agent names ≤32 per herdr; routine names — cap is fine, they are labels).
3. **unTag lookalikes**: normalise before matching — match `[<＜]\s*\/?\s*(?:room|wt)[\s​-‍⁠﻿]*-[\s​-‍⁠﻿]*message`
   case-insensitive and replace the `<`/`＜` with `‹` (U+2039) so no variant can open or close a tag. Keep `parseEnvelope`
   anchored and unchanged otherwise.
4. **Room author markers** (`rooms.mjs`): replyTo becomes `[quote from <attr(name)>, <kind>]: "<unTag(text ≤200)>"` —
   a server-set marker naming the quoted author and their real kind; context lines become
   `[<kind>] <attr(name)>: <text>` with `kind` from `m.author.kind` (server-set), so an agent named `user` reads
   `[agent] user: …`.
5. **Verify-card cap** (server.mjs verify route): at most **3** unverified cards per pane per **10 min**; beyond that,
   no new card, but one summary card per pane per window keyed `unverified-flood|<pane>|<window>` ("<agent> sent N
   unverified messages") updated with the count. In-memory `Map<pane, {start, n}>`
   `// ponytail: in-memory window; resets on restart — fine for a flood guard`.

## Units (one commit per skill)
- **U1 wt-shared** — 1-3 + tests in the existing wt-message test file: `/rm -rf` not hoisted, `/goal` and `/wt-audit`
  hoisted only with `hoist:true`; attr strips `\r`, U+2028, quotes, caps at 40; unTag neutralises `< wt-message`,
  `＜wt-message`, `<wt​-message`, `</ wt-message>`; `parseEnvelope` still parses real envelopes.
- **U2 wt-dashboard** — `hoist:true` at the needed call sites; 4 in rooms.mjs; 5 in the verify route. Tests: rooms batch
  with an agent named `user` and a replyTo → markers present; Dispatch prompt with `/wt-…` still hoisted; 20 forged
  verify calls from one pane → 3 cards + 1 summary card; a second pane still gets its own cards.
- **U3 docs/features.md** — wt-message section: hoist allowlist, attr limits, room markers, card cap.

## Hand-off and reporting
The worker reports the branch **directly to the orchestrator**: `handoff.sh --reply w1M:p2 "WP-333 done: branch … tip …"`
(the orchestrator asked for this so the reply comes from the card's assignee). No merge, no push.

## Definition of done
- wt-shared tests and `npm test` (skills/wt-dashboard) pass with U1/U2 cases.
- Throwaway data only (temp DATA / throwaway server); no real agents messaged.
- No e2e writing or running.

## QA brief
No dashboard layout change except the summary card. QA on a throwaway server: forge 20 verify calls from one throwaway
pane → Inbox shows 3 cards + one "sent N unverified messages" card, readable at 412x700 and iPhone 13; a room delivery
to a throwaway agent from a user named "dashboard" shows the `[user]` marker.
