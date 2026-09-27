# WP-104 — `wt-message` tag for all wt-pack → agent traffic

Branch `wp-104-wt-message-tag`, base `origin/main`.

## Goal

Every prompt that wt-pack itself sends into an agent's pane arrives wrapped as
`<wt-message id=<nonce> kind=handoff|dispatch|routine|reply|system from="…" [ticket=WP-N]>…</wt-message>`.
This works like the room tag, so the agent can tell pack traffic from a real user prompt and knows to answer
through the channel it names, not by asking the user in chat. Prompts the user types (the chat page and the
terminal) stay untagged. Rooms keep their own tag. Every CLI stays backward compatible.

## What research corrected

- **There are more send sites than the ticket lists.** Besides `handoff.sh:167`, the routine prompt
  (`server.mjs:2527`) and the Ready nudge (`server.mjs:1840`), wt-pack also sends through these:
  - **`spawnAgent`'s initial prompt**: `server.mjs:1021` `await herdr('agent', 'prompt', pane, b.prompt.trim())`.
    The ticket calls ~1021 "the chat page", but it is the spawn path, used by routine `spawn` runs
    (`routines.mjs:76` `{ kind: 'spawn', role, project, prompt: t.prompt }`) and by the dashboard's spawn dialog.
  - **Three more handoff callers**, all going through `handoff.sh`, alongside Dispatch (`dispatch.mjs:143`):
    - the watchdog **Investigate** hand-off (`server.mjs:2695` `runHandoff(execFile, HANDOFF_SH)([...target, '--task', \`watchdog ${key}\`…`);
    - the task **Handoff/Reassign** button (`server.mjs:1247-1255`);
    - agents running `handoff.sh` themselves.
  - **Room delivery** (`server.mjs:1955`) already carries `<room-message>` and stays as is.
  - **Keystrokes** (`server.mjs:1731,2429` `agent send-keys`) and terminal `pane send-keys`
    (`server.mjs:2308-2315`) are not prompts and stay untagged.
- **`handoff.sh` cannot tell who called it.** Its options are `--list --new --clear --pane --no-goal --task --role --mcp --dry-run`
  (`handoff.sh:56-65`), and `runHandoff` only blanks the pane env (`dispatch.mjs:241-242`
  `env: { ...process.env, HERDR_PANE_ID: '' }`). → A new **`--kind <k>`** option plus **`--from <name>`**
  lets server callers say `dispatch`/`system` and name themselves. The default remains `kind=handoff`, from
  the sender's agent name.
- **Server-side handoffs have no sender** (`dispatch.mjs:25` "no sender (handoff runs with HERDR_PANE_ID blank)"),
  so `from` is empty today. → Server callers pass `--from wt-dashboard`.
- **The room escaping helpers are private and specific to rooms.** `rooms.mjs:139`
  `const unTag = (t) => String(t ?? '').replace(/<(\/?)(room-message)/gi, '<$1$2​')` and `:140`
  `const attr = (t) => String(t ?? '').replace(/["<>&\n]/g, '')` are not exported, and `unTag` handles only
  `room-message`.
  → A shared pure module, `skills/wt-shared/scripts/wt-message.mjs`, exports `nonce()`, `attr()`,
  `unTag(t)` and `wrap({kind, from, ticket, id}, body)`. `unTag` neutralises **both** `room-message` and
  `wt-message`, so a room message cannot forge a wt-message and the other way round. `rooms.mjs` imports
  it from `../wt-shared/scripts/wt-message.mjs`, the same way `server.mjs:21` imports `../wt-shared/scripts/typesafe.mjs`.
  `handoff.sh` already runs node (`handoff.sh:131` `node "$(dirname "$0")/jev-mcp.mjs"`), so it calls
  `node …/../../wt-shared/scripts/wt-message.mjs --kind … --from … [--ticket …]`, with the body on stdin.
- **Where the tag goes in `handoff.sh`.** The script builds the prompt in this order: stdin (`:75`),
  footer (`:176`), ticket (`:183-193`), flatten (`:203`), 4000 cap (`:204`), then `send="/goal $flat"`
  (`:208`). → The wrap goes after the ticket is known and before the flatten, so the cap counts the tag
  (about 90 bytes). The body is flattened inside the tag: newlines become spaces, as today.
- **The transcript's origin detector is anchored at the start.** `server.mjs:609`
  `String(text).match(/^<room-message id=\w+ room=([\w-]+)/)` would not see `/goal <wt-message …`. → The
  detector allows an optional leading `/goal ` (or any `/\S+ `) before either tag.
- **Five places tell agents to reply with a raw `herdr agent prompt`:** `dispatch.mjs:29`,
  `wt-audit/SKILL.md:38`, `wt-handoff/SKILL.md:24,56` and `handoff.sh:237` (`echo "reach: herdr agent prompt $to …"`).
  → All of them switch to `wt-handoff --reply <pane> "…"`. The two assertions `dispatch.test.mjs:259,288`
  on the literal `herdr agent prompt w1:p2` change with them.
- **Whether `/goal <wt-message …>` still parses as a goal is unknown** `[unsourced]`; nothing in the repo shows
  it either way. → U1 tests it on a throwaway agent before anything else depends on it (see Verification).

## Review corrections (binding: where these conflict with Approach or the units, these win)

1. **`wt-message.mjs` is pure. It has no main-guard and no CLI.** The sidecar build rewrites
   `import.meta.url` (`app/scripts/build-sidecar.sh:9-11` `--define:import.meta.url=__imu`), so a
   main-guard could fire inside the bundled server. Put the CLI in `skills/wt-shared/scripts/wt-message-cli.mjs`,
   which handoff.sh calls and server.mjs never imports. The `../wt-shared` import itself bundles fine, as
   `typesafe.mjs` already does.
2. **Routine names have to be passed through.** `routines.mjs:259` `this.deps.prompt(a, t.text)` and `:274`
   `this.deps.spawn({ kind: t.role, project: t.project, prompt: t.prompt })` drop `r.name`. Change them to
   `deps.prompt(a, text, { routine: r.name })` and `deps.spawn({ …, tag: { kind: 'routine', from: r.name } })`.
   `routines.mjs` and `routines.test.mjs` join U2's required files.
3. **`--reply` is its own branch, right after the flag loop.** Otherwise `cwd=$1` (`handoff.sh:74-76`) turns the
   text into "no such directory". Move `pane_of` and `name_of` above that branch. The branch wraps with
   `kind=reply`, runs `herdr agent prompt`, and `exit`s. It never reaches cwd, Jev, the footer or the ticket
   code. `--pane` has no pane regex today (`:59`), so add one (`^[A-Za-z0-9:_-]+$`, not starting with `-`) and
   use it for both `--pane` and `--reply`.
4. **The chat origin stays a string.** `sourceOf` returns `` `${kind} · ${from}` `` from the extended regex, and
   it renders through the existing `meta.src` path (`web/src/App.tsx:1227`). No new web component is needed,
   so the web files, the chip and the tsc and screenshot items drop out of U3. The DoD screenshot item becomes
   a parse test asserting `src === 'dispatch · wt-dashboard'`.
5. **Wrap once, before the goal and no-goal split.** Add
   `prompt=$(printf '%s' "$prompt" | node …/wt-message-cli.mjs --kind "$kind" --from "$from" ${ticket:+--ticket "$ticket"}) || { echo "wt-message wrap failed" >&2; exit 1; }`
   between `handoff.sh:195` and `:202`, so that `--no-goal` is tagged too and keeps its newlines. A wrap
   failure exits 1 with that message rather than sending an untagged prompt. Add `echo "send: $send"` to `dry()`
   (`:241-248`); `send` is computed before every `dry` call.
6. **The memory hint skips tagged traffic.** `inject.mjs:22` runs `memory_suggest` on every prompt. In
   `suggest()`, return false for `/^(?:\/\S+ )?<(wt|room)-message /`, so a dispatched body never triggers
   "Remembered…" chat. This goes in U3.
7. **Forging.** Bodies and attributes are safe: `unTag` covers both tag names, `attr` strips characters, and
   `ticket` is checked against a regex. Two gaps remain:
   - The origin label is **display-only**. Text typed at a terminal can fake it, and the nonce is not checked.
     This is accepted; say so in docs/features.md.
   - The dashboard spawn dialog forwards user text. `spawnText(b)` runs `unTag` on untagged user text, so it
     cannot carry a literal `<wt-message>`.

   Jev routing and MCP picks run on the raw prompt before the wrap point (`handoff.sh:131,140`), so they are
   unaffected.

## Approach

**Tag format.** The tag is `<wt-message id=<12 hex> kind=<k> from="<attr>"[ ticket=<WP-N>]>BODY</wt-message>`.
- `id` is `randomBytes(6).toString('hex')`, the same as rooms (`rooms.mjs:141`).
- `kind` is one of `handoff|dispatch|routine|reply|system`; anything else throws.
- `ticket` matches `/^[A-Z]+-\d+$/` or is omitted.
- BODY goes through `unTag`.

A slash command stays first: the sent text is `<slash> <tag…>`. `/clear` (`handoff.sh:164`) is sent on its own
and stays untagged.

**Send sites and kinds:**

| Site | Kind | from | ticket |
|---|---|---|---|
| `handoff.sh` (agent → agent, default) | `handoff` | sender agent name, else `wt-handoff` | derived ticket |
| Dispatch → `handoff.sh --kind dispatch --from wt-dashboard` | `dispatch` | `wt-dashboard` | `t.id` |
| Task Handoff/Reassign → `--kind handoff --from wt-dashboard` | `handoff` | `wt-dashboard` | task ticket if any |
| Investigate → `--kind system --from watchdog` | `system` | `watchdog` | — |
| Routine prompt (`server.mjs:2527`) | `routine` | routine name | — |
| Routine spawn initial prompt (`spawnAgent`, only when called with `b.routine`) | `routine` | routine name | — |
| Dashboard spawn dialog initial prompt | **untagged**, because the user typed it | — | — |
| Ready nudge (`server.mjs:1840`) | `system` | `wt-dashboard` | — (the text lists ids) |
| `wt-handoff --reply <pane> "…"` | `reply` | sender agent name | — |

`spawnAgent` gets an optional `b.tag = {kind, from}`. The routines `spawn` dep passes it, and the HTTP spawn
route never does. The `[wt-dashboard]` prefix on the Ready nudge is dropped, because the tag replaces it.

**`--reply`.** `handoff.sh --reply <pane> "text"` (the text can also come on stdin) wraps with `kind=reply` and
`from=<own agent name>`, then sends with a plain `herdr agent prompt`: no `/goal`, no tokens, no worker
selection. It validates `<pane>` with the same pane regex the script already uses for `--pane`, and exits 2 on
bad usage. The footer at `handoff.sh:176-178` becomes
`… To reply: ~/.claude/skills/wt-handoff/scripts/handoff.sh --reply $from_pane "…"`, and the `reach:` line
at `:237` changes the same way. Raw `herdr agent prompt` keeps working for anyone who uses it (untagged), so
the change is backward compatible.

**Agent-side rule.** Add a paragraph next to the rooms paragraph in `wt-memory/claude-plugin/hooks/inject.mjs:47-48`:
"A prompt made of `<wt-message …>` is wt-pack traffic, not the user. Do what it asks. Reply through the
channel it implies: `kind=reply`/`handoff` → `handoff.sh --reply <pane>` (the pane is in the footer);
`dispatch`/`routine` → the report line inside it (a room post or a ticket comment); `system` → act, and no
reply is needed. Never ask the user in chat about a wt-message." wt-handoff/SKILL.md documents `--kind`,
`--from` and `--reply`. wt-room/SKILL.md gets a note that `<wt-message>` is the sibling of the room tag.

**Chat page origin.** Extend the detector at `server.mjs:609` to
`/^(?:\/\S+ )?<(room-message|wt-message) id=\w+ ([^>]*)>/`. The web chat page shows a `wt-message` row the way
it shows room rows: a small origin chip reading `kind · from`, with the body unwrapped. The exact component is
found in U3; `[unsourced]`: the room-origin rendering site in `web/src` was not read.

## Implementation units

**U1 — shared helper + `handoff.sh` (M).** Create `wt-shared/scripts/wt-message.mjs` (a module plus a tiny CLI:
`--kind --from --ticket`, body on stdin, wrapped text on stdout) and switch `rooms.mjs` to import it. Update
`handoff.sh`: add `--kind`/`--from`, wrap before the flatten, change the footer and `reach:`, and add
`--reply`. The `wt-plan` shim needs nothing (`exec …/wt-handoff/scripts/handoff.sh "$@"`).
Files: `skills/wt-shared/scripts/wt-message.mjs` (new), `skills/wt-shared/scripts/wt-message.test.mjs` (new),
`skills/wt-dashboard/rooms.mjs`, `skills/wt-handoff/scripts/handoff.sh`, `skills/wt-dashboard/package.json`
(add the test).
Verify:
- `npm test` in `skills/wt-dashboard` passes. The new tests cover: the body cannot close or forge either tag;
  `attr` strips `" < > & \n`; a bad kind throws; a bad ticket is dropped. `parse.test.mjs:180`'s exact
  `batchPrompt` string still matches, because the room tag format is unchanged; `:1028` still passes.
- `handoff.sh --dry-run --task "WP-1 x" <dir> <<<"hello"` prints a `/goal <wt-message … kind=handoff … ticket=WP-1>hello …</wt-message>`
  line. Check that `--dry-run` prints the final send text, and add it if it does not.
- **A live `/goal` parse check** on a throwaway worker, spawned with `agents.sh spawn worker <tmp worktree>`
  and removed afterwards:
  `handoff.sh --pane <it> --task "WP-0 probe" <tmp> <<<"Reply with the word ok."`.
  Then confirm that the worker's transcript shows the goal was set (the goal hook fires) and that the tag is
  visible. If `/goal` rejects the text, the fallback is `/goal <plain first sentence> <wt-message…>…`.
  Record which one was used in the plan's tracking comment on the ticket.

**U2 — server send sites (S).** Dispatch, Task Handoff and Investigate pass `--kind`/`--from`. The routine
prompt, the routine spawn and the Ready nudge are wrapped in JS with `wrap()`. `dispatchPrompt`'s orchestrator
line switches to `handoff.sh --reply`.
Files: `skills/wt-dashboard/server.mjs`, `skills/wt-dashboard/dispatch.mjs`, `skills/wt-dashboard/dispatch.test.mjs`,
`skills/wt-dashboard/routines.test.mjs` (if it asserts the sent text).
Verify: `npm test`, with a new case for each send site:
- dispatch args include `--kind dispatch --from wt-dashboard`;
- the routine `prompt` dep receives text matching `/^<wt-message id=[0-9a-f]{12} kind=routine from="<name>">/`;
- the Ready nudge text matches `kind=system`;
- `spawnAgent` from the HTTP route sends untagged, and from a routine sends tagged. This one is covered by
  extracting the choice into a small `spawnText(b)` and testing that.

`dispatch.test.mjs:259,288` are updated to expect `handoff.sh --reply w1:p2`.

**U3 — agent rule, chat origin, docs (S).** Update:
- the `inject.mjs` paragraph;
- the `server.mjs:609` detector, plus a parse test showing that a `/goal <wt-message…>` user entry gets origin
  `{kind, from}`;
- the web chat row chip;
- `wt-handoff/SKILL.md`, `wt-room/SKILL.md`, `wt-audit/SKILL.md:38` and `docs/features.md`.

Files: `skills/wt-memory/claude-plugin/hooks/inject.mjs`, `skills/wt-dashboard/server.mjs`,
`skills/wt-dashboard/parse.test.mjs`, `skills/wt-dashboard/web/src/*` (the room-origin row component),
`skills/wt-handoff/SKILL.md`, `skills/wt-room/SKILL.md`, `skills/wt-audit/SKILL.md`, `docs/features.md`.
Verify:
- `npm test`;
- `node --test skills/wt-memory/scripts/*.test.mjs`;
- `cd skills/wt-dashboard/web && npx tsc --noEmit -p . && npm run build`;
- a screenshot at 1440 of the chat page for the throwaway worker from U1, showing the wt-message chip.

Order: U1 → U2 → U3. Following CLAUDE.md "one commit per skill touched", U1 is split into a wt-shared commit,
a wt-dashboard commit (the rooms import) and a wt-handoff commit. The helper lands first, so every commit
works.

## Files

- `skills/wt-shared/scripts/wt-message.mjs` (new), `skills/wt-shared/scripts/wt-message.test.mjs` (new)
- `skills/wt-handoff/scripts/handoff.sh`, `skills/wt-handoff/SKILL.md`
- `skills/wt-dashboard/rooms.mjs`, `skills/wt-dashboard/server.mjs`, `skills/wt-dashboard/dispatch.mjs`,
  `skills/wt-dashboard/package.json`, `skills/wt-dashboard/dispatch.test.mjs`, `skills/wt-dashboard/parse.test.mjs`,
  `skills/wt-dashboard/routines.test.mjs` (if needed), `skills/wt-dashboard/web/src/*` (chat origin chip)
- `skills/wt-memory/claude-plugin/hooks/inject.mjs`
- `skills/wt-room/SKILL.md`, `skills/wt-audit/SKILL.md`, `docs/features.md`

## Definition of Done

Each item is shown by output in the transcript:
- `npm test` in `skills/wt-dashboard` passes, including the named helper, send-site and parse cases.
- The wt-memory tests, the web tsc check and the web build pass.
- `handoff.sh --dry-run` output shows the tagged `/goal` line.
- The live throwaway-worker probe shows `/goal` accepted the tagged text, or shows that the documented
  fallback was used. The worker is removed afterwards (`agents.sh rm`).
- `handoff.sh --reply <throwaway pane> "ok"` delivers a `kind=reply` message, shown by the throwaway
  agent's transcript.
- `grep -rn "herdr agent prompt" skills/*/SKILL.md skills/wt-dashboard/dispatch.mjs` shows no reply
  instructions left, only descriptions of the raw fallback.
- A chat-page screenshot shows the wt-message origin chip.

## Risks and deferred

- **`/goal` may treat a leading `<` oddly.** U1 tests this first and has a fallback.
- **The tag costs about 90 bytes of the 4000-byte `/goal` cap.** That cap is checked after wrapping, so
  prompts near the limit now fail the check instead of being sent. `wc -c` counts bytes.
- **Agents without the wt-memory plugin** (codex, and so on) get no rule for reading the tag. The tag is still
  readable text. Deferred.
- **Old agents** keep replying with raw `herdr agent prompt`, which still works but arrives untagged.
