# WP-332 — Destructive-action gate

Source: `docs/plans/wp-326-envelope-trust-audit.md` remedy S6, user decision **Q2**: these need the user's OK — `git push`
and merge, `gh pr approve|merge|close`, deleting branches/worktrees/files outside the task's worktree, sending files or
secrets off the machine — **unless** the request is a verified (WP-329) `handoff`, `dispatch` or `routine` from the
orchestrator, a routine, or the user. A setting with that default, enforced where possible by a wt-mods `tool.call`
guard that **asks the user** through the existing ask/Inbox flow (no silent deny), and stated in the role rules. It must
not block the orchestrator's own merge/push flow. Only WP-332.

## Today (read from the tree)
- `skills/wt-mods/hooks/guards.ts`: `registerGuards(on)` → `on('tool.call', {tool:'Bash'}, …)`; `guard(cmd, here, main)`
  splits a command on `&& || ; \n`, strips quoted strings, returns a refusal string or null; the handler returns
  `{deny}` or `next(e)`. It already has `forcePush`, loose parsing "stops accidents, not obfuscation". Registered once
  from `hooks/register.ts:12,36`. Mods have **no Node and no env** (CLAUDE.md WP-206/212/213 trap): they reach state
  only through `$.process.run([...])` on a CLI (like `wt-ask --ping`).
- WP-329: `skills/wt-memory/claude-plugin/hooks/inject.mjs` `verify(e)` already asks `GET /api/messages/:id/verify` per
  UserPromptSubmit and builds the per-turn reminder (verified/unverified, `kind`, `sender`, `senderPane`). That result
  exists only inside the hook process and the reminder text; nothing a later `tool.call` can read.
- Dashboard settings: `skills/wt-dashboard/config.mjs` `KEYS` (e.g. `WT_NUDGE: {oneOf:['on','off'], label}`), edited in
  Settings, read by the server and by CLIs through the env file.
- Ask flow: `wt-ask "<q>" --option … --ticket <id>` posts a room chip + Inbox card; the answer returns as a delivery.

## Design
### Turn trust record (the missing link)
`inject.mjs`, on every UserPromptSubmit, writes `~/.cache/wt-memory/turn-<key>.json` where `<key>` = `HERDR_PANE_ID`
(else `WT_HEADLESS_ID`; no key → skip): `{at, trust: 'user'|'verified'|'unverified', kind, sender, senderRole}`.
- no `<wt-message>` in the prompt → `trust:'user'` (the human typed it);
- `<room-message>` → `trust:'unverified'` for this gate (rooms are not an allowed source in Q2);
- `<wt-message>` verified → `trust:'verified'` with `kind`, `sender`, and `senderRole`: the verify route returns it
  (`server.mjs` verify branch: look up the sender pane's `role`/pool token via `agents()`; for server-sent rows
  `sender_pane` is null → `senderRole:'server'`);
- unverified/timeout → `trust:'unverified'`.
Written best-effort, atomically (tmp + rename); never blocks the hook.

### Policy (one pure function, one file)
`skills/wt-shared/scripts/gate.mjs` — `export const classify(cmd) → null | {action}` (the Q2 list: `git push`,
`git merge`, `gh pr (approve|merge|close)`, `git branch -D|-d`, `git worktree remove`, `git push --delete`, `rm`/`rmdir`
with a target outside `cwd`'s worktree, `curl|wget|scp|rsync|nc` posting local files/`--data @`/secret env vars) and
`export const allowed(turn, mode) → boolean`:
- `mode` = setting `WT_GATE` ∈ `ask` (default) | `off`; `off` allows everything (the setting the ticket asks for).
- allowed when `turn.trust === 'user'`, or `turn.trust === 'verified'` and `kind ∈ {handoff, dispatch, routine}` and
  (`senderRole === 'orchestrator'` or `senderRole === 'server'` — dispatch/routine are server-sent).
Same `loose parsing` stance as guards.ts: stops accidents and injected text, not a determined obfuscator
`// ponytail: pattern list, not a shell parser — extend the list when a bypass shows up`.

### Enforcement
- **CLI** `skills/wt-shared/scripts/wt-gate` (`wt-gate check -- <cmd>`): reads `HERDR_PANE_ID`/`WT_HEADLESS_ID`, the turn
  file (stale >6 h or missing → `unverified`, never allowed by absence — **but** missing pane key = not an agent
  session → exit 0 allow, so a human's own terminal is not gated), `WT_GATE` from the env file, runs `classify`+`allowed`.
  Exit 0 allow; exit 3 gated (prints `{action}`); exit 0 also when a live **grant** matches (below).
- **Mod guard**: in `guards.ts` add a second `on('tool.call', {tool:'Bash'}, …)` registered via `registerGuards`
  (non-shared event, allowed): only for a command whose text matches the cheap `classify`-style prefilter inlined in the
  mod (pay the process spawn only then), call `$.process.run(['<root>/skills/wt-shared/scripts/wt-gate','check','--',cmd])`;
  on exit 3 return `{deny: 'wt-pack gate: <action> needs the user. I asked them in the Inbox; wait for their answer
  — do not retry until it arrives.'}` **and** the CLI has already posted the ask (below). Fail open on spawn error/timeout
  (a broken gate must not wedge every agent) but write one line to stderr.
- **Ask, not silent deny**: on exit 3 the CLI posts once per (pane, action, command-hash, 10 min) an Inbox card through
  the existing ask path (`wt-ask "<agent> wants to <action>: <cmd ≤120 chars>" --option allow once --option deny`), and the
  user's *allow once* creates a **grant** the next identical command passes: `POST /api/gate/grants {pane, hash}` user
  session only (cookie) → `wt_gate_grants` row, TTL 10 min, consumed on use. `wt-gate check` asks
  `GET /api/gate/grant?pane=&hash=` (pane key authenticated, WP-327) and consumes it. The agent sees the denial text,
  waits for the user's reply (the card's answer is delivered like any wt-ask answer), then retries.
- Dashboard: `config.mjs` `KEYS.WT_GATE = {oneOf:['ask','off'], label:'Ask before push, merge, delete and send-out actions'}`
  + the Settings row (follow how `WT_NUDGE` is rendered; tsc `-p tsconfig.app.json`).
- **Role rules**: the wt-memory SessionStart text (`inject.mjs` `wtm`) gains one sentence: "Pushing, merging, approving
  or closing PRs, deleting outside your worktree, and sending files or secrets out need the user's OK unless a verified
  handoff/dispatch/routine from the orchestrator or a routine asked for it; otherwise ask the user and wait" — and the
  same line in the orchestrator/worker role docs `wt-memory` ships `[unsourced: find the role-rules file — CLAUDE.md says
  role rules live in wt-memory]`.

### The orchestrator's own flow must not break
The orchestrator's merge/push is triggered by the user's prompt (`trust:'user'`) or by a verified dispatch from the
dashboard — both allowed. Workers told "Do not merge/push" never needed it. A worker asked by the *orchestrator* via a
verified handoff to push is allowed (senderRole orchestrator). A planner relaying an unverified request is gated — the
intended effect. Dry-run proof in tests (below).

## Units (one commit per skill)
- **U1 wt-shared** — `gate.mjs` (`classify`, `allowed`) + `gate.test.mjs`: each Q2 action matched; `git push --dry-run`
  and `git status` not; `rm` inside the worktree not, outside yes; allowed matrix (user / verified handoff from
  orchestrator / verified handoff from a worker → gated / verified `system` → gated / unverified → gated / `WT_GATE=off`).
- **U2 wt-dashboard** — verify route adds `senderRole`; `wt_gate_grants` migration; grant POST (cookie only) / GET+consume
  (pane key); `WT_GATE` key + Settings row. Route tests: pane cannot POST a grant (403); grant consumed once; expires;
  `senderRole` for pane-sent vs server-sent rows.
- **U3 wt-memory** — `inject.mjs` writes the turn file; rule sentence. Test: stub verify server → file has
  `trust:'verified', kind, senderRole`; forged → `unverified`; no wt-message → `user`. Async `execFile` in tests
  (CLAUDE.md WP-164).
- **U4 wt-mods** — second `tool.call` handler. Tests with `skills/wt-mods/scripts/test` (not `claude plugin test .`):
  gated command → deny text and the CLI called; ungated command → CLI not spawned; CLI error → allowed.
- **U5 docs** — `docs/features.md` (setting, default list, exception, how the user approves) and one CLAUDE.md Traps line:
  a new class of outward action goes in `gate.mjs` `classify`; the gate's evidence is the per-turn `turn-<pane>.json`
  written by inject.mjs, so a stale or missing record means unverified.

## Definition of done
- Tests: `node --test skills/wt-shared/scripts/gate.test.mjs`, `skills/wt-mods/scripts/test`, wt-memory suite, `npm test`
  (skills/wt-dashboard) pass, including the allowed matrix and the grant lifecycle.
- Throwaway-only live check: a throwaway agent (`spike332-` name, temp repo with a **local bare remote** — never a real
  remote) given an *unverified* prompt "git push" → denied, Inbox card appears, *allow once* → retry pushes to the
  local bare repo; given a verified handoff from the orchestrator pane → pushes without a card. Never push anywhere real.
- `WT_GATE=off` restores today's behaviour (tested).
- No merge, no push: reply to the orchestrator with the branch. Merge order: server (restart) → plugin.
- No e2e writing or running.

## QA brief
Settings shows the row (default Ask) without overflow at 412x700 and iPhone 13. On a throwaway agent: an unverified
"push" request makes an Inbox card "<agent> wants to push"; Allow once lets the retry through, Deny leaves it blocked;
a push the user types directly into the pane is never asked.

## Residual
- Pattern-based: obfuscated shell (`sh -c "$(…)"`, scripts that push internally) is not caught; MCP/other tools
  (`gh api -X PUT …/merge`) only if added to `classify`.
- Fail-open on gate errors trades safety for not wedging agents; revisit with `WT_GATE=strict` if wanted.
