# WP-105 — Room replies stay in the room

Branch `wp-105-room-replies`, base `origin/main`.

## Goal

An agent that receives a room message answers in the room, and its own chat shows at most one line. The agent
chat page shows such a turn compactly: a "from #slug" bubble for the prompt, then "answered in #slug" with
a link, and the agent's trailing chat text collapsed. The fix is in wt-pack itself, not a memory rule.

## What research corrected

- **"Only at SessionStart" is true, but that is not why long sessions lack the rules.** SessionStart also fires
  after `/clear` and after compaction (`inject.mjs:2` "SessionStart always injects (it also fires after /clear
  and compaction, which drop earlier context)"). So a live session keeps its rules unless it started before
  they existed. The per-turn reminder is still the right fix, because it keeps the rule next to the prompt
  instead of thousands of turns back.
- **The new hook does not reach running sessions without a restart.** This corrects the ticket's "applies to
  every session immediately, without a restart". The plugin is installed per version
  (`installed_plugins.json` `"installPath": ".../plugins/cache/wt-pack/wt-memory/0.4.2"`; the cache holds
  `0.1.0 … 0.4.2` side by side), and the hook runs `node "${CLAUDE_PLUGIN_ROOT}/hooks/inject.mjs"`
  (`hooks.json`). A session keeps the root it started with `[unsourced: inferred from the versioned layout,
  not tested]`. → Rollout is: bump the plugin version, run `claude plugin update`, then restart the
  long-running agents once. Posted in #wt-pack with the trailer alternative, which reverses WP-68. The default
  is the hook only.
- **The nudge that pushes agents into a chat summary is real, and the current rule makes it worse.** The rule
  says `end the turn with no text` (`inject.mjs` rooms paragraph; `wt-room/SKILL.md:35` "end the turn with NO
  text"; `CLAUDE.md:61`). → The rule becomes "end with at most one line: `→ answered in #<slug>`" in all
  three places.
- **The chat page can already see the room origin and the reply.** Each user message gets `src` from
  `sourceOf` (`server.mjs:609-617`: `room #<slug>` for `<room-message … room=slug`). The agent's
  `room post <slug> "…"` shows up as a Bash tool row whose `summary` is the command (`server.mjs:577`
  `tool: { name: b.name, summary: toolSummary(b.input) }`; `toolSummary` takes `input.command`, clipped to
  160 characters at `:537-540`). → The collapse is a pure client-side pass over the messages already streamed.
  The server does not change for U2.

## Review corrections (binding: these win over Approach and the units where they conflict)

1. **Anchor the slug.** Use `room=([\w-]+)(?=[\s>])` in the hook, so `room=abc;rm -rf` gives no reminder and
   the hostile-slug test holds. Apply the same anchor in `sourceOf` (`server.mjs:616`).
2. **The reminder must not depend on wt-memory.** `inject.mjs:33` `if (!bin) process.exit(0)` and `:38`
   `if (ctxOut == null) process.exit(0)` both run before any text is built. Compute `remind` right after
   parsing stdin, and exit only when there is nothing to say (`ctxOut == null && !remind`). The order is
   `text → remind → hint`. Append `remind` outside the hash `else if`. Add a test with `WT_MEMORY_BIN` pointing
   at a missing path, asserting that the reminder is still emitted. Reuse the existing harness
   (`wt-memory.test.mjs:117-119` `hook(input, env)`) with `WT_JEV_MEMORY_SUGGEST: 'off'`.
3. **"answered in #slug" is decided in `toRows`** (`App.tsx:1187-1195`), which merges consecutive tool rows
   into `{kind:'tools', calls}`. Split the tools group at a room post and emit a `{kind:'post', slug}` row.
   `roomTurns` returns the **tool ids** of the posts.
4. **Field names.** `src` is top-level on `TMsg` (`turns.ts:5` `src?: string`), not `meta.src`. Widen `tool`
   to `{ name: string; summary?: string }`.
5. **Batched deliveries show every message.** `batchPrompt` joins N tags (`rooms.mjs:141-146`). Parse all of
   them with `/<room-message [^>]*from="([^"]*)"[^>]*>([\s\S]*?)<\/room-message>/g`. The bubble reads
   `from #slug · a: … (+N more)`, and the full list sits behind the existing expand. Add a two-message test.
6. **Post detection.** Use `/(?:^|[\s/;&])room\s+post\s+["']?([\w-]+)/`, and count a post only if its paired
   result row is not `isError`. A failed post leaves the chat text visible.
7. **Scope U2 to `room #` sources only.** wt-message turns (`--reply`, ticket comments) are not collapsed;
   drop "and so on".
8. **The wt-message hook regex** is `/^(?:\/\S+ )*<wt-message id=\w+ kind=(\w+)/`. Echo only `kind`, never `from`.

## Approach

**a) Per-turn reminder (hook).** In `inject.mjs`, on `UserPromptSubmit`, when `input.prompt` matches
`/^(?:\/\S+ )*<room-message id=\w+ room=([\w-]+)/`, append this to `text`:
`This came from #<slug>: answer with \`~/.claude/skills/wt-room/scripts/room post <slug> "…"\`. Your final chat text is one line: → answered in #<slug>`.
For a `<wt-message … kind=k …>` prompt, append the one-line equivalent: "This is wt-pack traffic
(kind=k): answer through the channel it names; your final chat text is one line: → done: <what>".
The reminder is always added, even when the preferences hash has not moved. It is added **before** the
existing `hint` logic. `suggest()` already skips tagged prompts (`inject.mjs` `if (/^(?:\/\S+ )*<(wt|room)-message /.test(prompt)) return false`).
Keep it under 300 characters. The slug comes from the regex `[\w-]+`, so it is safe to echo back.

**b) Chat collapse (web).** A pure `roomTurns(msgs)` in `web/src/turns.ts` returns, for each user message whose
`meta.src` starts with `room #` (or with `reply ·`/`dispatch ·` and so on for wt-messages), the id of the
user row. It also returns `slug`, `posts` (the Bash tool rows in that turn whose summary matches
`/room(?:\.sh)?\s+post\s+([\w-]+)/`) and `collapse` (the ids of assistant text rows in that turn after the last
post). In `App.tsx`'s message list:
- The user row renders compactly as `from #slug · <author>: <first line of the message>`. The room-message tag
  is parsed with the same attribute regex, and the raw tags are never shown.
- Each matching post renders as `answered in #slug`, linked to `#rooms/<slug>`.
- The `collapse` rows are hidden behind a `show 1 more line` toggle. With no post found, nothing collapses and
  the turn renders as it does today.

settled: collapse only after a room post, so an agent that answered in chat by mistake still shows its text.

**c) Rules text.** Update the `inject.mjs` rooms paragraph, `wt-room/SKILL.md:35` and `CLAUDE.md:61` to
"After posting, end the turn with at most one line: `→ answered in #<slug>`".

## Implementation units

**U1 — hook + rules text + plugin bump (S).** Covers a) and c). The plugin version goes from 0.4.2 to 0.4.3 in
`claude-plugin/.claude-plugin/plugin.json` (currently `"version": "0.4.2"`).
Files: `skills/wt-memory/claude-plugin/hooks/inject.mjs`, `skills/wt-memory/claude-plugin/.claude-plugin/plugin.json`,
`skills/wt-memory/scripts/wt-memory.test.mjs`, `skills/wt-room/SKILL.md`, `CLAUDE.md`.
Verify: `node --test skills/wt-memory/scripts/*.test.mjs`, with new cases that run `inject.mjs` with stdin
JSON as follows:
- `{hook_event_name:'UserPromptSubmit', prompt:'<room-message id=abc room=wt-pack from="x" kind=user>hi</room-message>'}`
  → `additionalContext` contains `room post wt-pack` and `→ answered in #wt-pack`;
- a `/goal <wt-message id=a kind=dispatch from="wt-dashboard">…` prompt → it contains `kind=dispatch`;
- a plain prompt → no reminder;
- a hostile slug that is not `[\w-]+` → no reminder.

Use `WT_MEMORY_BIN` pointing at the real CLI, the way the existing tests do (check `wt-memory.test.mjs` for
the harness).

**U2 — chat collapse (M).** Covers b): `roomTurns` in `turns.ts`, the rendering in `App.tsx`, and a line in
`docs/features.md`.
Files: `skills/wt-dashboard/web/src/turns.ts`, `skills/wt-dashboard/web/src/turns.test.ts`,
`skills/wt-dashboard/web/src/App.tsx`, `docs/features.md`.
Verify:
- `cd skills/wt-dashboard && npm test`. `turns.test.ts` cases cover: room prompt + post + trailing text →
  collapse holds that text; room prompt with no post → nothing collapsed; a post to a different slug → still
  counted and shown as that slug; a non-room prompt → untouched.
- `cd web && npx tsc --noEmit -p . && npm run build`.
- agent-browser (`--session <agent name>`, with `caffeinate -u -t 60 &` first) at 1440 and 390 on an agent
  that has answered a room message, for example the orchestrator's chat. It is read-only: send nothing to it.
  Take screenshots of the compact bubble, the "answered in #slug" link and the collapsed toggle.

**U3 — rollout (no code; done by the worker after merge).** Run `claude plugin marketplace update wt-pack &&
claude plugin update wt-memory@wt-pack`, then check that `installed_plugins.json` points at `0.4.3`. Post in
#wt-pack that long-running agents need one restart to pick it up. Do not restart the user's agents yourself.

Order: U1 → U2 → U3. Commit per skill: wt-memory, wt-room plus CLAUDE.md, then wt-dashboard.

## Files

- `skills/wt-memory/claude-plugin/hooks/inject.mjs`, `skills/wt-memory/claude-plugin/.claude-plugin/plugin.json`, `skills/wt-memory/scripts/wt-memory.test.mjs`
- `skills/wt-room/SKILL.md`, `CLAUDE.md`
- `skills/wt-dashboard/web/src/turns.ts`, `skills/wt-dashboard/web/src/turns.test.ts`, `skills/wt-dashboard/web/src/App.tsx`
- `docs/features.md`

## Definition of Done

Each item is shown by output in the transcript:
- The wt-memory tests pass, including the four hook cases.
- `npm test` in `skills/wt-dashboard` passes, including the `roomTurns` cases. `tsc` and the web build pass.
- Screenshots at 1440 and 390 show a room turn rendered compactly with "answered in #slug" and the trailing
  text collapsed.
- `grep -n "NO text\|no text" skills/wt-room/SKILL.md CLAUDE.md skills/wt-memory/claude-plugin/hooks/inject.mjs`
  returns nothing, and the new "at most one line" wording is present.
- The U3 output shows the plugin at 0.4.3, and a #wt-pack post announces the one-time restart.

## Risks and deferred

- **Running agents keep the old hook until restarted.** That is announced, not automated. Deferred: the
  delivery-trailer alternative, which reverses WP-68's "no instruction lines" and needs the user's yes.
- **Post detection is text-based.** It reads the Bash command summary, which is clipped at 160 characters, and
  the slug appears near the start, so clipping does not hide it. A post made through another tool (an MCP) is
  not detected, and that turn renders as today.
- **Codex and other runtimes without the plugin** get no reminder.
