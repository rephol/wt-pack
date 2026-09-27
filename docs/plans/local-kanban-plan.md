# Local kanban board for agent ticketing

Branch `local-kanban`, base `origin/main` (0156b02). The user approved this in #wt-pack (msgs 241–249).

## Goal

Each project gets a local ticket board in wt-dashboard. Tickets are `<KEY>-N` (wt-pack → `WP-12`), stored on disk
and not in Linear. The user drags cards on the web. Agents use a `wt-ticket` CLI. wt-plan, wt-handoff, wt-ship and
wt-finish take a `WP-N` the same way they take `APP-N`, and move the card. The auditor files findings as Backlog
tickets. The orchestrator schedules only what sits in **Ready**. Linear is unchanged for myapp.

## What research corrected

- **rooms.mjs does not serialize writes.** `rooms.mjs:229 this.lock = Promise.resolve()` is declared but never
  used. What keeps rooms safe is write-then-rename (`rooms.mjs:203-207 atomicWrite`) plus append-only jsonl. A
  ticket file is read-modify-write, so it needs a real per-project promise-chain lock. The lock is safe because the server
  is the only writer (the CLI goes through the API).
- **No project key exists.** A project is the basename of the repo root (`server.mjs:219-228`). The only key map is
  `server.mjs:50 const PROJECT_BY_TEAM = { APP: 'myapp' }`. Keys are new (see Approach).
- **No DnD library is installed** (web deps: astryx, stylex, react-query, react-virtual, xterm, react). Use native
  HTML5 drag and drop. Do not add a dependency.
- **The skills do not parse ticket ids with a regex. Two shell scripts and the server do, and all three are
  APP-only.** Each fails silently for `WP-12`:
  `server.mjs:855 const ticketOf = (s) => (s?.match(/app-(\d+)/i) ? …)` (worktrees :883, PRs :983, agents :364/:904);
  `wt-handoff/scripts/handoff.sh:180-181 … grep -oiE 'app-[0-9]+'`; `wt-shared/scripts/task-state.sh:41 … grep -oiE 'app-[0-9]+'`.
  Only `server.mjs:1038 tagTicket … /^[A-Z]+-\d+/i` is already generic.
- **'Up next' is Linear-only on the server, not a web hook.** `server.mjs:1070 : issue?.mine && ['unstarted','started'].includes(issue.stateType) && !wt && !pr && !ag.length ? 'up_next'`.
  Local tickets must be fed into `deriveTasks` as a source. If they are not, they never appear in Tasks, Overview
  or the switcher.
- **Agents cannot write without a session cookie.** `server.mjs:1644-1649 needsSession` exempts only
  `x-herdr-pane` POSTs to `/api/rooms` and `/api/rooms/<slug>/messages`. A CLI write to `/api/tickets` would get a 403
  unless that function gets an exemption.

## Approach

**Store:** add `wt-dashboard/tickets.mjs` (static import, because `app/scripts/build-sidecar.sh:8` bundles
`server.mjs` with esbuild; a dynamic import would break only the Tauri app). There is one file per project,
`DATA/tickets/<project>.json` (`DATA` = `~/.local/share/wt-dashboard/data`, `server.mjs:44-45`). The file shape is
`{ key, next, tickets: [...] }`. It is written with the existing `atomicWrite` from `rooms.mjs`. Every mutation of a
project goes through `lock(project, fn)`, a `Map<project, Promise>` chain.
`// ponytail: per-project in-process lock; the server is the only writer.`
A corrupt file is quarantined the way `rooms.mjs:239` does it (`rename → .corrupt-<ts>`).

**Ticket:** `{ id, title, body, type: bug|ux|gap|debt|feature, size: S|M|L|null, priority: 0-4 (Linear scale), labels[],
links[], column, assignee: {name,pane}|null, created, updated, history: [{at, author, kind: 'create'|'move'|'comment'|'edit'|'assign', from?, to?, text?}] }`.
Comments are history entries with `kind:'comment'`, so the ticket needs no second list.
Columns are `backlog ready planning building review done blocked`. Moving to `blocked` requires text (the reason).

**Keys:** a board's key is set when the board is created, and stored in its file. The default is the uppercase
initials of the project name split on `-`/`_`: `wt-pack → WP`. A one-letter result uses the first 3 letters instead.
Keys are **letters only, 2–5 chars**, because `server.mjs:1038 /^[A-Z]+-\d+/i` and `rooms.mjs:143 /^[A-Z]+-\d+$/`
reject digits. A key listed in `PROJECT_BY_TEAM` (Linear) or used by another board is refused, and the next letter
of the name is added (`myapp → APP` is taken → `MYAPPX`). Creating a board and picking its key happens under one
global lock (`lock('__keys__')`) that re-reads every board's key, so two concurrent first creates cannot get the same key. `settled:` the key is derived and not
user-configurable in v1. Rejected: a settings field, because the only live project needs `WP` and gets it by
default. `[unsourced]` Only wt-pack is expected to use this board soon.

**Identity and auth:** reuse `roomAuthor` (`server.mjs:1695-1711`). A session cookie means the author is the user. An
`x-herdr-pane` header over 127.0.0.1 means an agent, whose pane is resolved through `canonicalPane`. Extend
`needsSession` to exempt `x-herdr-pane` requests with POST/PATCH to `^/api/tickets(/…)?$`. Host/Origin
already applies to every route (`server.mjs:2027-2030`), so it needs no change. GETs need no session (same as rooms).
The exemption only checks that the header is present (`server.mjs:1646`). The pane is actually verified inside
`roomAuthor` (`:1708 throw … 403`), so **every ticket mutation handler calls `const author = await roomAuthor(req)`
first, before it reads or writes anything**. The history records `author.name`. For the user that is the profile
name (`:1698 { kind: 'user', name: p.name }`), not the literal "user".

**API** (the contract both builders code against):
- `GET /api/tickets?project=<p>[&column=][&format=text]` → `{ key, tickets }`, or text rows `WP-12 [ready] (bug,M,P2) title @assignee`
- `GET /api/tickets/<ID>[?format=text]`
- `POST /api/tickets` `{ project, title, body?, type?, size?, priority?, labels?, links?, column? = 'backlog' }` → ticket
- `PATCH /api/tickets/<ID>` `{ title?, body?, type?, size?, priority?, labels?, links?, column?, assignee? }`. A column or assignee change
  appends a history entry. `assignee:'me'` resolves to the caller's agent, and gives 400 for the user.
- `POST /api/tickets/<ID>/comments` `{ text }`
- `POST /api/tickets/<ID>/claim` sets assignee = caller, and returns 409 if another agent holds the ticket and the
  request has no `force` flag.
- The project is resolved from the id prefix by scanning the board keys. An unknown prefix gives 404. Validation is
  at the boundary: title 1–200 chars, body ≤20k, labels ≤20×40, links ≤20 http(s) URLs, enums checked, and unknown
  fields dropped.

**deriveTasks:** `overview()` passes the local tickets alongside `issues`, as issue-shaped objects
`{ identifier, title, url: null, priority, mine: column==='ready', stateType: column==='ready' ? 'unstarted' : 'backlog', local: true, project, column }`.
Ready tickets then land in **Up next** through the existing rule at :1070, with "Plan it" wired up.
`project` comes from the ticket, not `PROJECT_BY_TEAM`. Each task carries `column` and `local`.
All local tickets are passed in, and inside the loop the plan adds
`if (issue?.local && ['backlog','done'].includes(issue.column) && !wt && !pr && !ag.length) continue`. Without it,
every identifier becomes a task (`:1041-1042`, falling to `'queued'`), and Tasks would fill up with backlog. The project
edit at `:1088` becomes `project: agent?.project ?? issue?.project ?? (issue ? PROJECT_BY_TEAM[…] ?? … : REPO_PROJECT)`.
Without it, a WP ticket's project would resolve to `'wp'`, and "Plan it" (`tasks.tsx:91`) would spawn a planner in a
project that does not exist. `settled:` the kanban column is not derived from task state. Agents and skills set it
explicitly. Rejected: a server-side auto-move, because it would fight user drags. The Overview tiles keep
counting task states.

**Id recognition:** replace the three APP-only regexes with one rule. A ticket id is `<KEY>-<N>` where KEY is `APP`
or a known board key.
- Server `ticketOf`: build the regex from `['APP', ...boardKeys]`, anchored as `(^|[/_-])(key)-(\d+)(?=\D|$)`, case-insensitive.
- Shell (`handoff.sh`, `task-state.sh`): the pattern is built from known keys only:
  `keys=$(~/.claude/skills/wt-ticket/scripts/wt-ticket keys 2>/dev/null)` (one per line, which prints nothing if the
  server is down), `pat="(app|$(echo $keys | tr ' ' '|'))-[0-9]+"`. A generic `[a-z]+-N` was rejected because a task
  that mentions `utf-8` or `node-20` would win over the real branch id. That wrong id drives the label, the token and the move.

**Ticket rooms:** `rooms.mjs:499 syncTickets(tasks)` must skip `task.local`, because local tickets live on the board
and not in `#wp-12` rooms. `[unsourced]` The user did not ask for per-ticket rooms here.

**Web:** add a `Queue | Board` switch on the Tasks page (hash `#tasks/board`). `pageFromHash` (`App.tsx:320-321`) changes
its `h === 'tasks'` to `startsWith('tasks')`. Add `taskViewFromHash()` next to `roomFromHash`, and set it in the hashchange
handler (`App.tsx:337 const on = () => { setPage(...); setRoomSlug(...) ... }`). The toggle writes `location.hash`. It avoids a new nav page (`App.tsx:245/449` closed lists).
- Board = the board for the sidebar project (reuse the project scope used by the quick switcher). Its query is
  `['tickets', project]`, invalidated after each mutation and refetched every 4s (like overview, `App.tsx:343`).
- Desktop ≥ 768px: 7 columns scroll horizontally. Cards are `draggable` and columns handle `onDragOver/onDrop` →
  PATCH column with an optimistic update. A card shows the id, title, type chip, size, priority and the assignee.
- 390px: a column switcher (a segmented/select with counts) and one list below it. Cards have no DnD there, and are
  moved from the drawer.
- Card detail = Astryx `Dialog` on desktop, `BottomSheet` on phone (both already used: `settings.tsx:9`,
  `switcher.tsx:6`). It holds editable fields, a "Move to" select, an assignee, and the history/comments with author
  and time. A comment box. A "New ticket" button in the Backlog column header. No `window.confirm`
  (`noNativeDialogs.test.ts` fails on it).
- The Up next section keeps Linear rows. Local Ready tickets also show there (through deriveTasks) with a `WP-12`
  id chip. `settled:` "replaces Up next" means the board is where local tickets are managed. Linear rows stay.

**CLI:** not on PATH. `setup:45` only links skill dirs, and existing callers use full paths
(`wt-audit/SKILL.md:43 ~/.claude/skills/wt-room/scripts/room post …`). So every integration calls
`~/.claude/skills/wt-ticket/scripts/wt-ticket`. Scripts guard with `[ -x "$T" ] || echo "wt-ticket missing" >&2`
before running `|| true`, so a missing CLI is visible and does not stay silent. Add a new skill dir `wt-ticket/` with `SKILL.md` + `scripts/wt-ticket`. `setup:45` links only
`wt-*/` dirs that have a SKILL.md. The CLI is bash + curl, shaped like `wt-room/scripts/room:13`
(`-H "x-herdr-pane: ${HERDR_PANE_ID:-}"`). Commands:
`new "<title>" [--type --size --priority --label --link --body --column] [--project <p>]` (the default project is the
basename of the git common dir of the cwd, which matches the server's rule),
`list [--column c] [--mine]`, `show <ID>`, `move <ID> <column> [--note "…"]`, `comment <ID> "…"`, `claim <ID> [--force]`,
`assign <ID> <agent|me|none>`, `keys` (the known board keys, one per line, from `GET /api/tickets/keys`), and `--json` on every command (the raw API body; the default is `format=text`).
Exit codes: 0 ok, 1 API error (body printed), 2 usage. If the server is down, print "wt-dashboard not reachable"
and exit 1. Integrations then treat a failure as non-fatal.

**Integrations** (skill text + the two scripts). Every call is `$T … || true` (the full path, as above), so a board failure never blocks the pipeline:
- wt-plan step 1: a `<KEY>-N` that is not APP is resolved with `wt-ticket show <ID>` (the body is the ticket), then
  `wt-ticket move <ID> planning` + `claim`. The branch name starts with the lowercase id (`wp-12-<slug>`).
- wt-handoff (`handoff.sh`): after a successful send, if the ticket is local, run `wt-ticket move <ID> building` + `assign <ID> <worker>`.
- wt-ship: after the PR opens / the merge to main, run `move <ID> review` with a PR comment. wt-pack has no PR (merge-direct), so it
  goes straight to `done` on merge.
- wt-finish: `move <ID> done`, if it was not already done.
- wt-work blocked: `move <ID> blocked --note "<reason>"`.
- wt-audit: each finding becomes `wt-ticket new … --column backlog --type … --size …`, then ONE room post listing the new ids.
- Orchestrator rule (CLAUDE.md "Working here" + wt-ticket SKILL.md): schedule only Ready tickets. Take one with `claim`.

## Implementation units

Two builders. **A:** U1 → U2 → U3 → U5. **B:** U4. B starts right away against the API contract above,
and merges after U1.

**U1 — tickets store + API** (builder A)
Files: `wt-dashboard/tickets.mjs` (new), `wt-dashboard/tickets.test.mjs` (new), `wt-dashboard/server.mjs` (routes in the
dispatch chain near :2038, `needsSession`, reuse `roomAuthor`), `wt-dashboard/package.json` (add `tickets.test.mjs` to the
explicit test list, because `package.json:9` enumerates the files).
Verify: tests cover create/sequential ids, a PATCH with an unknown pane → 403 with the file unchanged, two concurrent first-board
creates → distinct keys, 20 concurrent `create` calls → 20 distinct ids and a valid file, move
appends history, blocked without a note → 400, claim conflict 409, key derivation (`wt-pack→WP`, a Linear key refused,
collision suffix), corrupt file quarantined, and `needsSession` exempting pane PATCH but not a no-pane PATCH.

**U2 — wt-ticket CLI** (A)
Files: `wt-ticket/SKILL.md`, `wt-ticket/scripts/wt-ticket` (new). The SKILL.md holds the orchestrator Ready rule.
Verify: run against a dev server on a spare port with `WT_DASHBOARD_DATA=<tmp>` (the CLI honours `HERDR_DASH_URL` like `room`),
because the launchd service does not have the new routes until the final restart. Run `./setup` (or doctor) and check that it links `~/.claude/skills/wt-ticket`. Against the running server
from a throwaway herdr pane in a temp repo: new → list → move → comment → claim, with `--json` parsing through `jq`.
Delete the temp board file afterwards.

**U3 — task integration** (A)
Files: `wt-dashboard/server.mjs` (`ticketOf` built from keys, `deriveTasks` input + `local`/`column`, overview wiring),
`wt-dashboard/rooms.mjs` (`syncTickets` skips local), `wt-dashboard/parse.test.mjs` (new cases next to :671).
Verify: parse tests show a Ready local ticket → `up_next` with the right project, a `wp-12-x` worktree joins WP-12,
a Backlog ticket with no signal is absent, and syncTickets ignores local tasks.

**U4 — web board** (builder B)
Files: `wt-dashboard/web/src/board.tsx` (new), `wt-dashboard/web/src/boardData.ts` + `boardData.test.ts` (new: grouping,
column order, and the optimistic move reducer), `wt-dashboard/web/src/tasks.tsx` (Queue|Board switch, WP chip on up_next),
`wt-dashboard/web/src/App.tsx` (hash `tasks/board`).
Verify: `cd web && npx tsc --noEmit -p . && npm run build`, `npm test`. agent-browser against the dev server on the spare port (after U1 merges) at 1440: drag a card from Backlog
to Ready and see it persist after a reload; open the drawer and comment; the history shows the profile name. At 390: switch
columns, move from the drawer, no horizontal page scroll. Screenshots go to #wt-pack.

**U5 — skill integrations + docs** (A, after U2)
Files: `wt-plan/SKILL.md`, `wt-handoff/scripts/handoff.sh`, `wt-handoff/SKILL.md`, `wt-shared/scripts/task-state.sh`,
`wt-ship/SKILL.md`, `wt-finish/SKILL.md`, `wt-work/SKILL.md`, `wt-audit/SKILL.md`, `CLAUDE.md` (skill map row + Ready rule).
Verify: `handoff.sh --dry-run` with a `wp-12-x` branch shows `ticket=WP-12` and the move. `task-state.sh` extracts WP-12
from the label. The APP paths are unchanged (run the same dry run with `app-759`). One commit per skill.

## Files

wt-dashboard/tickets.mjs · wt-dashboard/tickets.test.mjs · wt-dashboard/server.mjs · wt-dashboard/rooms.mjs ·
wt-dashboard/parse.test.mjs · wt-dashboard/package.json · wt-dashboard/web/src/board.tsx · wt-dashboard/web/src/boardData.ts ·
wt-dashboard/web/src/boardData.test.ts · wt-dashboard/web/src/tasks.tsx · wt-dashboard/web/src/App.tsx ·
wt-ticket/SKILL.md · wt-ticket/scripts/wt-ticket · wt-plan/SKILL.md · wt-handoff/scripts/handoff.sh · wt-handoff/SKILL.md ·
wt-shared/scripts/task-state.sh · wt-ship/SKILL.md · wt-finish/SKILL.md · wt-work/SKILL.md · wt-audit/SKILL.md · CLAUDE.md

## Definition of Done

- `cd wt-dashboard && npm test` passes and includes `tickets.test.mjs`. `cd web && npx tsc --noEmit -p .` is clean.
  `npm run build` succeeds.
- `curl` without a cookie or pane header: `PATCH /api/tickets/WP-1` → 403. With a pane header from a non-loopback Host → 403.
- `wt-ticket new/list/show/move/comment/claim/assign` each work with `--json` from a repo other than wt-pack, and
  the history records the agent's name.
- The board in the browser (agent-browser, 1440 + 390) supports drag/move, the drawer, comments and persistence, and
  the screenshots are posted.
- A Ready WP ticket appears in Tasks → Up next with "Plan it" enabled. Linear APP rows are still there.
- The handoff dry run shows the WP-12 token + move. The APP dry run is unchanged.
- wt-audit SKILL.md files findings with `wt-ticket new --column backlog`.
- The server is restarted once, at the end, via `npm run service:restart`.

## Risks and deferred

- Deferred: tickets in the quick switcher (`switcherData.ts:2` has fixed sections), keys configurable from
  settings, board filters/search, archiving Done, and a Linear sync.
- If the server is down, the shell `keys` lookup is empty, so only APP is recognised. The integrations then no-op, which is fine because the board is down too.
- Overview "In review" still counts task states, not the Review column. The auditor's finding #2 is separate work.
- A dropped drag on touch devices: phone uses the drawer "Move to", so it is not needed.
