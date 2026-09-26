# WP-90 — Board: search tickets (UI + `wt-ticket search`)

Branch `wp-90-ticket-search`, base `origin/main`.

## Goal

People can find a ticket by text. The board header gets a search field that filters cards live, and the CLI gets
`wt-ticket search <text>`. Both match the same fields in the same way, case-insensitively: the id, title,
body, labels and comments.

## What research corrected

- **SQL LIKE and FTS5 are the wrong tools here.** A ticket is one JSON blob per row. `tickets.mjs:114` reads
  `SELECT json FROM tickets WHERE project = ? ORDER BY seq`, and there are no columns for title, body or
  comments. A `LIKE` over `json` would match key names and author names (`"author":"jev"`, `"column"`). FTS5
  would need a new synced table plus a migration, which is a lot for a store holding 92 tickets today
  (`SELECT count(*) FROM tickets` → 92). → The server filters in JS after the existing `SELECT`, using a
  pure matcher. This is marked `ponytail:` with its ceiling: move to FTS5 if boards reach thousands of
  tickets.
- **Comments are history entries, not a separate field.** They are stored as
  `t.history.push({ … kind: 'comment', text })` (`tickets.mjs:170,226`), and a move note is a `move` entry
  with `text`. → The matcher reads `history` entries of kind `comment` plus any `move` entry that has text
  (which is how a blocked note reads). It skips `edit`/`assign` entries, whose text is field names.
- **The board already fetches every ticket and refetches every 4 s**
  (`board.tsx:79` `api<BoardT>(\`/api/tickets?project=…\`), refetchInterval: 4000`). → The UI filters on the
  client with the same matcher. It makes no `?q=` request per keystroke. The `?q=` endpoint serves the CLI.
- **Board state lives in the URL query, not the hash.** The page is `#board`, and the project is `?project=`,
  written with `history.replaceState` (`App.tsx:360-362`). → The search goes in `?q=` using the same
  `replaceState`, so it never adds history entries.
- **There is no `/` shortcut, and the app's key handler ignores typing targets** (`App.tsx:416`
  `const typing = el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)`). → The board
  registers its own `/` handler with the same typing guard.

## Review corrections (binding — these win over Approach and the units where they conflict)

1. **Filter once, and use the result everywhere.** `const fcols = useMemo(() => group(tickets.filter((t) => ticketMatches(t, query))), [q.data, query])`.
   Use `fcols` in the drop-target math (`board.tsx:136` `const ids = cols[c].filter((t) => t.id !== draggedId)`),
   in card rendering and ghost placement (`board.tsx:183`), in the `BoardColumn` counts, and in the phone
   column picker (`board.tsx:207`, `cols[c].length`). Otherwise the drag ghost lands in the wrong place and the
   phone shows unfiltered counts. The header badge (`board.tsx:215` `String(tickets.length)`) stays the total,
   because `N matches` sits beside it.
2. **Declare the hooks before Board's early returns** (`board.tsx:113-116`: 'all', error and loading):
   `query` state, the input ref, the `/` effect and URL sync all go next to the existing `hashchange`
   effect. Only the JSX goes in the Toolbar.
3. **The `/` guard** matches App's: it skips typing targets and `el.closest('dialog')` (`App.tsx:420`), and it
   skips while the ticket drawer is open (`openId`). There is no existing `/` binding: `switcher.tsx:99` takes
   only Cmd/Ctrl+K.
4. **Browser-check URL:** `/?project=wt-pack&q=<term>#board`, not `#board?project=…`, which would put the
   query inside the hash. `?q` survives a project switch, because `App.tsx:359` edits only `project`. That is
   intended.
5. **`wt-ticket` help range:** `usage()` prints `sed -n '3,14p'` (`wt-ticket:18`). Adding the `search` line
   means changing it to `'3,15p'`.
6. **CLI shape:** `search` copies `list`'s `--column`/`--project` parsing (`wt-ticket:55-60`), requires a
   non-empty `<text>` (`[ $# -ge 1 ] || usage`), and appends
   `&q=$(node -e 'console.log(encodeURIComponent(process.argv[1]))' "$text")`.
7. **tsc does not check the parity test:** `web/tsconfig.app.json` has `"exclude": ["src/**/*.test.ts"]`, so the
   `../../tickets.mjs` import runs only under node, which is fine. `mine` composes with `q`
   (`server.mjs:1787-1789` filters after `list`).

## Approach

**One matcher, two copies, and a parity test.** The server copy is `ticketMatches(t, q)`, exported from
`tickets.mjs`. The web copy is `ticketMatches` in `web/src/boardData.ts`. The web cannot import
`tickets.mjs`, because it opens `node:sqlite`. The rule is:
- lowercase `q`, split it on whitespace, and require **every** term to be a substring of the haystack;
- the haystack is `id`, `title`, `body` (optional: `body?: string`), `labels.join(' ')` (`labels?: string[]`, per `boardData.ts` `Ticket`), and the `text` of every history entry of kind
  `comment` or `move` that has text, all lowercased and joined with `\n`;
- an empty `q` matches everything.

A parity test in `web/src/boardData.test.ts` imports both copies (`../../tickets.mjs`, the same way
`notifyGate.test.ts:68` does with `await import('../../inbox.mjs')`; `tickets.mjs` opens the DB lazily, per `tickets.mjs:87` `get db() { … } // lazy: server.mjs is imported by tests`). It runs one fixture table through both and asserts identical
results. settled: two small copies plus a parity test, rather than a shared `.mjs` imported across the Vite
root, which would need tsc and vite configuration changes for about 8 lines.

**Server.** `list(project, column, q)` applies `ticketMatches` after the column filter. `GET /api/tickets`
passes `url.searchParams.get('q')`. `?format=text` output is unchanged (one row per ticket), and `mine`
still composes with it.

**CLI.** `wt-ticket search <text> [--column c] [--project p]` calls
`GET /api/tickets?project=…&q=<urlencoded>&format=text` and exits 0 even when nothing matches (empty
output). It also gets a usage line in the header comment, and `--json` works as it does for `list`. The text
is URL-encoded with node, which the script already requires (the header says "bash + curl + node (for JSON)").

**UI.** Changes in `Board` (`web/src/board.tsx`), in the Toolbar `endContent` next to `{automation}`
(`board.tsx:216`):
- desktop (`!phone`): an always-visible search input about 220 px wide, with placeholder `Search  /`;
- phone: an icon button that expands to a full-width input row below the toolbar, and collapses on clear
  when the input is empty. This keeps WP-64's one-row header.
- While a query is set, a `N matches` badge sits beside the input (it replaces nothing), and a clear
  button (✕) empties the query.
- Filtering: `tickets` shown per column become `tickets.filter((t) => ticketMatches(t, query))`. Columns
  keep their headers with filtered counts. Dragging is still allowed.
- `/` focuses the input when the target is not a typing target, and calls `preventDefault` so the `/` is
  not typed. `Esc` inside the input clears the query, then blurs.
- The URL: the initial value is `new URLSearchParams(location.search).get('q') ?? ''`. On change, run
  `replaceState` with `q` set, or deleted when empty. Changing the project keeps `q`.
- The 'All projects' picker (`BoardPicker`) is out of scope: search applies inside one board.

**Docs.** `docs/features.md` gets a short Search entry in the Board section, and the `wt-ticket` line there
lists `search`.

## Implementation units

**U1 — matcher, server, CLI (S).** `ticketMatches` in `tickets.mjs`; `list(…, q)`; the route passes `q`;
`wt-ticket search`.
Files: `skills/wt-dashboard/tickets.mjs`, `skills/wt-dashboard/server.mjs`, `skills/wt-dashboard/tickets.test.mjs`,
`skills/wt-ticket/scripts/wt-ticket`, `skills/wt-ticket/SKILL.md` (command list).
Verify: `cd skills/wt-dashboard && npm test`, with new `tickets.test.mjs` cases:
- matches on the id (`wp-3` finds `WP-3`), title, body, a label, and a comment's text;
- does not match an author name or a history `edit` entry;
- multi-word AND;
- `list(p, 'ready', 'foo')` combines the column and the query.

Then, against the live server after deploy, or a scratch HERDR_DASH_URL: `wt-ticket search dispatch` prints
rows, and `wt-ticket search zzzz-nothing; echo $?` prints nothing and `0`.

**U2 — web search UI + parity test + docs (S).** `ticketMatches` in `boardData.ts`; the parity test; the
Board header field, phone expander, count, clear, `/`, Esc and URL sync; `docs/features.md`.
Files: `skills/wt-dashboard/web/src/boardData.ts`, `skills/wt-dashboard/web/src/boardData.test.ts`,
`skills/wt-dashboard/web/src/board.tsx`, `docs/features.md`.
Verify: `cd skills/wt-dashboard/web && npx tsc --noEmit -p . && npm run build`, plus `cd skills/wt-dashboard && npm test`, which also runs the web tests: `package.json:10` `node --experimental-strip-types --test web/src/*.test.ts`. `web/` has no test script of its own. This is web-only, so no restart is needed. Then use agent-browser with `--session <agent name>` (run `caffeinate -u -t 60 &` first) on
`/?project=wt-pack#board`, at 1440 and at 390:
- type a term and see the count and the filtered cards;
- press `/` from the page body and see the input focused;
- reload with `?q=` in the URL and see the query restored;
- press the clear button and see all cards;
- on 390, confirm the icon expands the field and the header stays one row.

Take screenshots of both widths.

Order: U1 → U2 (the parity test imports U1's matcher). A server restart is needed once, for U1.

## Files

- `skills/wt-dashboard/tickets.mjs`, `skills/wt-dashboard/tickets.test.mjs`, `skills/wt-dashboard/server.mjs`
- `skills/wt-ticket/scripts/wt-ticket`, `skills/wt-ticket/SKILL.md`
- `skills/wt-dashboard/web/src/boardData.ts`, `skills/wt-dashboard/web/src/boardData.test.ts`, `skills/wt-dashboard/web/src/board.tsx`
- `docs/features.md`

## Definition of Done

Each item is shown by output in the transcript:
- `npm test` in `skills/wt-dashboard` passes, including the named matcher and `list` cases.
- In `web`, `npx tsc --noEmit -p .` and `npm run build` pass. The parity test passes as part of the dashboard `npm test` above.
- `wt-ticket search <term>` output is pasted, with at least one hit, plus an empty result with exit status 0.
- Screenshots at 1440 and 390 show a query, the `N matches` count and filtered columns. The phone
  screenshot shows the expanded field.
- `grep -n "search" docs/features.md skills/wt-ticket/SKILL.md` shows the new lines.

## Risks and deferred

- **JS filtering is O(tickets × text).** That is fine at hundreds of tickets. FTS5 is deferred until a board
  grows to thousands (the `ponytail:` comment at the filter says so).
- **The two matcher copies can drift.** The parity test is the guard.
- **Cross-board search** (All projects) is deferred.
