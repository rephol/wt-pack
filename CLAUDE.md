# wt-pack

A pack of Claude Code skills for running herdr agents on a ticket pipeline, plus the wt-dashboard control
room. Each `skills/<name>` dir is one skill of ONE plugin, `wt-pack` (WP-213): `./setup` (install, doctor,
secrets, uninstall) loads the checkout as it via `CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json`, and the
plugin-only install is `wt-pack@wt-pack` from the marketplace. Scripts refer to each other sibling-relatively (`../wt-shared/…`), so skills move together.
Branch `main`, remote `origin` = github.com/rephol/wt-pack; commits are authored as rephol via
repo-local git config — **push after committing** (`git push`).
User-facing feature reference: `docs/features.md` — a user-visible change updates it in the same merge.
Role rules (orchestrator, planner, worker, auditor, reviewer) live in wt-memory, not here.

## Layout
- `skills/wt-*` — the skills; `.claude-plugin/marketplace.json` — local marketplace `wt-pack` (serves the root
  plugin; also setup's marker for a wt-pack checkout); `setup` — installer;
  `docs/` — features, handoff, `plans/` (point-in-time, not rewritten). Root `.claude-plugin/plugin.json` +
  `hooks/hooks.json` + `hooks/register.ts` — THE plugin (every skill, wt-memory hooks/MCP, and the mods: `skills/wt-mods`
  /wt + routing, `skills/wt-ask` ask capture, `skills/wt-room/mod` delivery; one module registers them all). No skill has
  its own `.claude-plugin`. Never
  write `~/.claude/skills/…` in scripts, sent strings or SKILL prose (`wt-shared/scripts/paths.test.mjs`).

## Build and test
- wt-dashboard (`skills/wt-dashboard`): `npm test` (server + web unit tests).
- Web (`skills/wt-dashboard/web`): `npx tsc --noEmit -p tsconfig.app.json` (`-p .` checks nothing: the root tsconfig is `files: []` + references); web-only change: `npm run build` (no restart).
- wt-memory: `node --test skills/wt-memory/scripts/*.test.mjs`; wt-agents: `node --test skills/wt-agents/scripts/mcp.test.mjs`.
- Pack health: `./setup doctor`.

## Conventions
- **No draft PRs:** after code review (wt-review / wt-ship), merge to main directly, then push.
- **Browser checks:** use the `agent-browser` skill first; other browser tooling only when it is not installed.
  Always `--session <your agent name>`. Screenshots hang while the Mac's display sleeps (WP-1): run
  `caffeinate -u -t 60 &` first. If `agent-browser screenshot` still hangs, fall back to
  `node skills/wt-shared/scripts/screenshot.mjs --session <name> [--size 390x844] [--url <url>] <out.png>` (CDP).
- **One commit per skill touched.** Commit only your own paths (`git commit <paths>`), never `-a`.
- Commits use the rephol noreply identity (repo-local git config); `./setup doctor` flags any other.
- Keep every CLI backward compatible. Extending skills for dashboard needs is allowed.

## Skill map
| Skill | What / where to look |
|---|---|
| wt-agents | herdr pools, `spawn <role>`, `list --json`, pane tokens |
| wt-handoff | `--task`, sender/target tokens, reply footer (`skills/wt-plan/scripts/handoff.sh` is a shim) |
| wt-plan · wt-work · wt-review · wt-pr · wt-ship · wt-simplify · wt-compound · wt-research | ticket pipeline |
| wt-finish | retire worktree; clears `task` token |
| wt-babysit | watch PR to merge-ready |
| wt-watch-prs | reviewer loop over a repo's open PRs (`dispatch \| review <pr> \| [repo]`); state `~/.local/share/wt-watch-prs/` → Inbox `pr-held` |
| wt-audit | auditor role loop (PM + QA findings) |
| wt-ticket | local kanban board CLI (`WP-N`): new/list/show/move/comment/claim/assign/keys |
| wt-room | rooms CLI: list/read/post/--attach/create |
| wt-ask | post an agent question as a room chip + Inbox card (WP-164); `--resolve` closes it without an answer |
| wt-roles | project role files `.wt-pack/roles/<name>.md` (override = base-role name, else persona): `list`/`new`/`check`; read by `wt-shared/scripts/roles.mjs`, injected by wt-memory `context`, spawned by `agents.sh spawn <persona>`, routed by Dispatch `personaFor` (WP-204) |
| wt-memory | store `~/.config/wt-memory`; Claude plugin via local marketplace `wt-pack` |
| wt-shared | shared helpers; `model-route.mjs` (WP-128 model routing: explain/pick/outcome, WP-130 `usage`) + `routing-eval.mjs` |
| wt-setup | runs `./setup` at repo root |
| wt-dashboard | see below |

## wt-dashboard
- `server.mjs` + `rooms.mjs` (Node, no deps); web: React 19 + Vite + TanStack Query + Astryx UI in `web/src`;
  Tauri 2 app in `app/`.
- Server is launchd `id.local.wtdashboard.server` (`npm run service:restart|status`). **Don't restart repeatedly.**
- Data `~/.local/share/wt-dashboard/` (tickets/rooms/inbox in `data/wt.db`, `node:sqlite`, node ≥ 22.13; rollback: README), config `~/.config/wt-dashboard/env`, logs `~/Library/Logs/wt-dashboard/`.
- No Claude API in the dashboard (user rule). Keep security: session cookie, Host/Origin allowlist,
  loopback-only terminals, SSRF guard on `/api/unfurl`.

## Traps
- `HERDR_PANE_ID` may be the stable id — resolve via `herdr pane get` (`canonicalPane()`).
- Pane tokens: ≤32 keys, values ≤80 chars; `task`/`handoff_*` never mirrored to `agent-tags.json`;
  unknown roles dropped.
- WKWebView `window.confirm` is always false — native dialogs banned (`noNativeDialogs.test.ts`).
- Room turns: agents answering in a room end their session turn with at most one line: `→ answered in #<slug>`.
- Never prompt the user's real agents (other projects' panes) for tests; use throwaway agents/temp repos and clean up.
- herdr names: lowercase, digits, `-`, `_`, ≤32 (`wt-agents spawn` breaks on capitalised repo dirs — open).
- macOS is case-insensitive: `Dock.tsx` beside `dock.ts` makes `./Dock` resolve to `dock.ts` (tsc: implicit any) — give sibling modules distinct names (WP-112).
- BSD pkill/pgrep: options after the pattern become patterns; `-f … -n` SIGTERMs every `claude --name` agent (WP-109). Kill by recorded pid (the wt-memory plugin hook denies misordered calls). Plugin hooks load at session start: a guard shipped in git protects nothing until the plugin cache has it AND the session restarted (WP-120). Second layer: `wt-agents/bin` pkill/pgrep/killall PATH shims set at spawn (also block short `-f` patterns — the WP-120 kill hit Chrome tabs too).
- A CLI script needing another skill's module for only one of its subcommands must `import()` it dynamically, scoped inside that subcommand's function — never as a top-level `import`. ESM resolves every top-level import before any module code runs, so a static import makes *every* subcommand in the file depend on that other skill being present. WP-130 shipped `model-route.mjs` with a top-level `import { UsageAgg } from '../../wt-dashboard/usage.mjs'` for its new `usage` subcommand; verified this broke `pick`/`explain`/`floor`/`outcome` too (`ERR_MODULE_NOT_FOUND`) wherever wt-dashboard isn't checked out — fixed in review by moving the import into `usageReport()` (`skills/wt-shared/scripts/model-route.mjs:186`).
- A secret resolved from more than one source (env var, macOS Keychain, a `.env`/config file) must check every source in the *same order* everywhere it is read — the order is part of the contract, not an implementation detail of whichever function happens to read it. WP-136: `typesafe.mjs`'s `apiKey()` checked env var, then the `~/.claude/.env` line, only falling back to the Keychain if both were empty — while `wt-dashboard/config.mjs`'s documented precedence is env var **> Keychain >** env file. Agent processes (no `TYPESAFE_API_KEY` in their env) kept reading a stale `.env` key even after the Keychain one was rotated to fix a 401, because the wrong source won by file position, not by recency. Fixed by reordering `apiKey()` to match `config.mjs` (`skills/wt-shared/scripts/typesafe.mjs:21`); `./setup doctor` now also warns when the two sources disagree, and `typesafe.test.mjs` pins the Keychain-over-`.env` precedence with a PATH-shimmed fake `security`.
- An availability invariant enforced by a herdr **pane token** (dnd, pair, task, …) is only as strong as the *rarest* write path to the data it mirrors — every place that field can be set must also set the token, not just the primary one. WP-147: `candidates()`, `retireIdle()` and a routine's agent-pick all gate on the pane's `pair` token (`skills/wt-handoff/scripts/handoff.sh:417`, `skills/wt-dashboard/server.mjs:1014`, `skills/wt-dashboard/routines.mjs:231`), which dispatch.mjs and handoff.sh's `--buddy` both set correctly — but the dashboard's ticket drawer set a buddy through the generic `PATCH /api/tickets/:id {pair:…}` route, which only ever wrote the ticket's own `pair` *field* and never touched either agent's pane token. A buddy picked that way looked paired in the UI while staying fully available to every other dispatch, routine and idle-retirement sweep. Fixed with a dedicated `POST /api/tickets/:id/buddy` (`skills/wt-dashboard/server.mjs:2075`) that tags/clears the token alongside the field and validates the buddy isn't DND or already paired elsewhere; the generic PATCH route still accepts a raw `pair` value (needed for programmatic/test writes) but the UI no longer goes through it for this field.
- A skill that arms a `Monitor` to drive a long-running loop cannot assume the arm call succeeded just because it returned — it can come back with no task id and no visible error (the harness's own auto-mode classifier gives no verdict), which reads as armed while nothing is actually watching. WP-152: `wt-watch-prs`'s §1 ("Arm two Monitors", `skills/wt-watch-prs/SKILL.md`) now treats an unconfirmed task id as a failure per Monitor, retries it a couple of times, runs degraded on a single Monitor's exhaustion rather than discarding a working one, and only posts "this repo is unwatched" and stops once every Monitor is exhausted. `wt-babysit`'s own "Arm a Monitor" section (`skills/wt-babysit/SKILL.md`) had the identical exposure — fixed in WP-154 with the same retry-then-stop pattern, adapted to its single Monitor and lack of a room to post to (stop and report honestly through the existing §3 path instead).
- A floor added to one spawn-tier call site does not cover every caller that spawns a session — grep for every
  shape that routes a fresh session's tier, not just the one already fixed. WP-157 added a `sessionFloor` (never
  haiku for a main agent) to `model-route.mjs floor`, used by `wt-agents/scripts/agents.sh`'s spawn path
  (`skills/wt-agents/scripts/agents.sh:239`) — and that round's own review explicitly checked for other callers
  and concluded the fix was complete. It missed `skills/wt-handoff/scripts/handoff.sh:327`, which spawns a
  session too but through `model-route.mjs pick` (task-text-routed), not `floor` (role-routed) — a different
  call shape to the same router, so a grep for `floor` alone found nothing. A haiku-eligible task still spawned
  a literal `--model haiku` main agent through handoff until a follow-up added an explicit `--session` opt-in
  to `route()`/`pick`/`explain` that floors both an explicit `--model` and a Jev/local/pin pick to `sessionFloor`,
  and passed it from handoff.sh; `wt-review`/`wt-research`'s own unflagged `pick` calls for subagent model
  selection are untouched by design. Enforced by `skills/wt-shared/scripts/model-route.test.mjs` (`--session`
  floors both an explicit and a routed haiku pick, never lowers an already-adequate tier, and is a no-op without
  the flag) and `skills/wt-handoff/scripts/handoff.test.mjs` (the shadow-log and reuse-vs-spawn tests now assert
  the floored sonnet/low tier for a read-only task). A completeness check for "who else calls the thing I just
  changed" must search for every shape that reaches the same router, not just its own name.
- A mode gate (live/shadow/off) exists to hold back a *judgment* until it's trusted — it protects the caller
  from a probabilistic or unproven decision taking uncontrolled effect. A fixed, non-probabilistic computation
  living in the same file or CLI as that judgment does not inherit the same reason to be gated, and defaulting
  it to the judgment's gate anyway is a bug, not a conservative default. WP-160: `model-route.mjs floor` — a
  deterministic lookup of a role's minimum spawn tier from `cfg.sessionFloor`/`cfg.roleFloors`, no Jev call
  involved — was gated on `cfg.mode === 'live'`, copying the exact gate that correctly protects `pick`/
  `explain`'s Jev-routed, potentially-wrong tier choice from taking effect before it's trusted. `floor` has no
  such trust concern (a spawn has no task text to route in the first place, so there's nothing "unproven" to
  hold back), so the copied gate silently produced the opposite of its own stated invariant — a spawn with no
  explicit `--model` got NO `--model` flag at all in shadow (the default mode) or off, so Claude Code's own
  default applied, which can be haiku. This survived WP-157's own fix (which added the floor in the first
  place) and its follow-up (WP-157's handoff.sh gap) because both rounds' reviews checked "does the floor
  reach every caller," never "does the floor's own gating make sense for what it computes." Fixed by removing
  the mode gate from `floor` specifically (`skills/wt-shared/scripts/model-route.mjs`'s `cmd === 'floor'`
  branch) while leaving `pick`/`explain`/`route()` untouched — they still gate on `live`, correctly, because
  they DO carry a Jev judgment. Enforced by `skills/wt-shared/scripts/model-route.test.mjs` ("floor never
  spawns a role on haiku, in any mode") and `skills/wt-agents/scripts/spawn-env.test.mjs` (`--model`/`--effort`/
  pane tokens all asserted present in shadow and off, not just live).
- `herdr pane split`/`resize` change a pane's reported layout (`herdr pane layout`) but not what `herdr agent
  read --ansi` returns for a process already running in it, and starting a fresh `claude` process into an
  already-narrow pane (`herdr agent start ... --pane <id>`) didn't render narrower either — WP-165 tried both
  to reproduce a pane-width-dependent parsing bug (a 4-question AskUserQuestion tab bar wrapping in a narrow
  terminal) and got the same wide render every time, confirmed by the transcript's own prompt-line wrap point
  staying identical across a 120-col and a claimed-54-col pane. Whatever herdr renders back through this
  command isn't reading the actual pty width the running TUI sees, at least in this environment/version — a
  ticket asking to "reproduce at a narrow pane" via herdr CLI tooling alone should expect this and budget for
  a hand-constructed fixture (built from a confirmed real single-line capture plus an existing multi-line
  fixture's real wrap conventions, per `skills/wt-dashboard/test-fixtures/picker-4-tabs-wrapped*.txt`) rather
  than spending time on split/resize/restart attempts expecting a genuinely narrower live render.
- A test that spawns a CLI synchronously (`execFileSync`/`spawnSync`) while also running an in-process HTTP
  stub server for that CLI to call reaches a deadlock disguised as a connection failure: the synchronous
  child-process call blocks the parent's event loop, so the stub's own request handler never gets to run, and
  every call times out looking exactly like "server unreachable" (curl's own `--max-time`) rather than a hang.
  WP-164's `wt-ask.test.mjs` first wrote its `run()` helper with `execFileSync`, and every test failed with
  the CLI's own "wt-dashboard not reachable" message even though a real client (`curl` by hand, or the same
  test with `execFile`/`promisify`) reached the identical stub instantly — confirmed by switching `run()` to
  `promisify(execFile)` (`skills/wt-ask/scripts/wt-ask.test.mjs:13,27`), which fixed all six tests with no
  other change. Any future skill test that spins up its own stub server and shells out to its CLI in the same
  process needs the async form for this reason, not just because sync blocking is generally bad practice.
- A markdown table that fires an LLM-judged lens/persona set (`wt-review/SKILL.md`'s trigger table) and a
  JS module that offers the same set as a probability-judged shortcut (`wt-judge.mjs`'s `LENS_TRIGGERS`/
  `LENS_FOCUS` maps) are a lockstep with no compile-time link, same shape as this file's other lockstep
  entries — adding a row to one does not add it to the other, and nothing errors when it's missed. WP-183
  added three lenses (agent-native, reliability, performance) to the trigger table and every persona file,
  and its own review pass (checking "every lens file", "the trigger table") never grepped `wt-judge.mjs`
  because that file is prose-adjacent tooling, not a lens persona — the omission was caught only by
  `wt-review`'s regression lens dogfooding the branch, deliberately checking beyond the diff's own files.
  Fixed by adding the three lenses to both maps (`skills/wt-shared/scripts/wt-judge.mjs:101-103,410-412`).
  A completeness check for "every lens file updated" must also check every *judged shortcut* for the same
  table, not just the table's own direct consumers.
- A helper that runs inside a hook under a hard timeout (wt-memory's SessionStart `context`, 2 s) must bound its own
  input and its own subprocess timeouts, and a CLI reusing the same helper must not inherit that tight budget.
  WP-204: `roles.mjs` stripped HTML comments with `/ *<!--[\s\S]*?-->/g`; a repo file with a 65 KB run of spaces took
  41 s (the leading ` *` makes it quadratic) and would have hung every agent's session start, because the cap was
  applied *after* the strip. Fixed by slicing to 4×cap before any regex (`load()`), and dropping the leading ` *`.
  The same helper's 500 ms `git rev-parse` was right for the hook but made `wt-roles` fail "not in a git repo" under
  load, so `mainCheckout(cwd, timeout)` takes the budget from its caller (`skills/wt-shared/scripts/roles.mjs`).
- One plugin, one hooks module, and a loader that reads the source statically (WP-206/212/213). `hooks.json`
  `modules` takes ONE entry; the engine refuses a second hook on the same event without a matcher, so mods share
  `session.start`/`turn.start`/`turn.complete`/`prompt.submit` through `hooks/register.ts`, which registers each once
  as the chain of every mod's handler (`skills/wt-mods/hooks/compose.ts`). `$` is followed only into functions declared
  in the same file (never across an import, never as a value), `on` is only passed to plain functions, and the hook must
  be a function literal — so shared-event handlers in a mod's file get a narrow `ctx` built in `register.ts` from literal
  `$.noun.event(...)` calls. A mod's non-shared hooks (`on('tool.call', {tool}, …)`, `turn.step`) stay in its own file as
  `registerX(on, …)`. Mods have no Node and no env access: gate through a CLI (`wt-ask --ping`), never by reading
  `HERDR_PANE_ID` in the module. They reach other skills as `<root>/skills/<name>/…` (the plugin root is the repo).
  `claude plugin test .` also picks up every `*.test.ts` under the tree, including the dashboard's `node:test` web
  tests, which it cannot load — use `skills/wt-mods/scripts/test`, which fails only on the mods' own tests.
  Earlier shapes that failed: a marketplace copy of a skill-dir mod loses its sibling scripts (cache copy = its
  `source` dir only) and clashes by name with the `<name>@skills-dir` plugin Claude Code builds from a skill dir that
  carries `.claude-plugin/` — hence no skill carries one.
