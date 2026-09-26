# Jev integrations across wt-pack

## Goal

Replace seven regex/timer/`?` heuristics with Jev (TypeSafe System One) judgments, each behind its own
Settings switch, each failing open to today's behaviour when Jev is off, slow (>2s), keyless or erroring.
One shared client; call counts visible in `/api/health`; accuracy/latency measured on dry-run fixtures.
No Claude API anywhere in the dashboard.

## What research corrected

- **A shared client already exists** — `wt-shared/scripts/typesafe.mjs` (`ask`, `noul`, `choice`, `score`,
  judgment log). The brief said "extract from jev-mcp.mjs". But `ask()` is unusable for fail-open callers:
  it has no timeout and calls `process.exit(1)` on HTTP error (`typesafe.mjs:48-51`), and `apiKey()` reads
  only env and `~/.claude/.env` (`:19-28`), not the Keychain entry that `jev-mcp.mjs:36-41` and the server
  (`config.mjs:14`, `server.mjs:1106` `cfg.get('TYPESAFE_API_KEY')`) use. So U1 **extends typesafe.mjs**
  with a fail-open entry point instead of creating a second client; `jev-mcp.mjs` is ported onto it.
- **Item 6 is half-built.** `wt-judge.mjs triage` (`wt-judge.mjs:230`) already classifies review comments,
  but only as actionable yes/no, and `wt-babysit/SKILL.md:110-125` already calls it optionally (exit 3 =
  read every comment). The work is a three-way class, not a new feature.
- **Item 4's duplicate check exists as exact match** — `wt-memory:102` `norm(l) === norm(text)`. Jev adds
  near-duplicate and conflict detection on top; the exact check stays.
- **Item 3 has no routing today to replace**: `handoff.sh` always targets a worker (`:225`
  `agents.sh spawn worker`). The only `planner` reference is the sender's label (`:191`). This is new
  behaviour, so it must be opt-in and must never re-route wt-plan's own handoffs.
- **Inbox has no ordering to replace**: `groupInbox` (`web/src/notifyGate.ts:61-71`) keeps the incoming
  order; nothing sorts. The web has no key, so urgency must be computed server-side.

## Approach

- **Client (U1):** add `judge(feature, state, questions, {timeoutMs=2000})` to `typesafe.mjs`: returns the
  answers object or `null` — never throws, never exits. Key: env › Keychain (`security … -s wt-dashboard -a
  TYPESAFE_API_KEY -w`) › `~/.claude/.env`. In-process cache (Map, 128 entries, 10 min TTL, key = feature +
  sha1 of state+questions) — `ponytail:` per-process only; the server is the long-lived caller that benefits.
  Every real call appends `{ts, feature, ms, ok}` to `~/.local/share/wt-dashboard/jev-calls.jsonl` (CLIs and
  server alike, so one count covers both). `enabled(feature)` reads `WT_JEV_<FEATURE>` env › dashboard env
  file (same lookup as `wt-shared/scripts/mcp-mode.sh`) › the feature's default.
- **Switches and defaults** — settled (assumption, no synchronous user; flip in Settings): **ON** where calls
  are rare and event-driven — `ROOM_RESOLVE` (U3), `MEMORY_DUP` (U7 remember), `BABYSIT_TRIAGE` (U8),
  `ROUTE` (U6); **OFF** where calls scale with poll ticks or every prompt — `NEEDS_YOU` (U4), `STALL` (U5),
  `INBOX_RANK` (U9), `MEMORY_SUGGEST` (U7 hook, adds ≤2s to every user prompt). Rejected: all-ON (poll-loop
  features could burn credits unseen with no credits endpoint) and all-OFF (nothing gets exercised).
- **Server callers never block the 4s tick:** fire the judgment async, apply the result on a later tick,
  keyed by a hash of the input so an unchanged pane/message is asked once.
- **Thresholds:** noul ≥ 0.7 unless a unit says otherwise, each overridable by `WT_JEV_<FEATURE>_MIN`.
- **Fixtures:** `wt-shared/jev-fixtures/<feature>.json` = `[{state, expect}]` (≥10 cases each, real samples
  scrubbed of secrets), run by `node wt-shared/scripts/jev-eval.mjs <feature>` → accuracy, p50/p95 ms.
  Exit 3 without a key. Each unit's evaluator lives next to its caller as an exported `questions(state)` +
  `decide(answers)` pair so the eval and production share one code path.

## Review corrections (binding — they override unit text below where they differ)

1. `config.mjs` keys have no `default` (`Config.get()` `:88-90` returns null when unset). U2 adds a `default`
   field to key definitions, used by `get()` and `publicState()`.
2. The desktop app copies the env file into the server env at launch (`config.mjs:3-4`), so env-first
   `enabled()` would ignore Settings toggles in the server. **Server callers use `cfg.get('WT_JEV_*')`**;
   only CLIs use `enabled()`.
3. `judge()` takes `{key}`; the server passes `cfg.get('TYPESAFE_API_KEY')` (`server.mjs:1106`) so it never
   runs `security` per call. CLIs fall back to env › Keychain › `~/.claude/.env`.
4. U3 race: apply a late Jev answer only if `room.needsYou` still holds an entry for that `msg.id`, then
   `saveIndex()` (`rooms.mjs:377`). Test with a stub judge resolving after a second message.
5. U4: `parsePane` (`server.mjs:95`) stays pure (also used by an HTTP route, `:2014`). Tail hash, async ask and
   result cache live at the poll call site (`:350-382`); U4 builds this **shared tail-judgment cache**.
6. U5 depends on U4's cache; the stall rule is `server.mjs:985-990` (`deriveTasks` is sync; it reads the cache).
7. U6 must route **before** the reuse block (`handoff.sh:214-221`), restrict reuse to the chosen role, and fix
   the dry-run text (`:223`). A planner starts in the **main checkout** (as `agents.sh spawn planner` does),
   not `$cwd`.
8. U7 hook: the plugin is installed as a copy (`inject.mjs:14-16`), so locate `typesafe.mjs` like the CLI
   (`~/.claude/skills/wt-shared/…`, then the pack checkout), skip silently if missing. Run the Jev call in
   parallel with `wt-memory context` (already `timeout: 2000`, `inject.mjs:17`; hook budget 5s), Jev cap 1.5s.
   Verify: hook returns under 4s with network blocked.
9. U7 remember: exact-dup checks are `wt-memory:119` (global, returns "proposed") and `:121` (scoped); run the
   Jev near-dup/conflict check **before** the global branch so both paths get it.
10. U8: babysit triage section is `wt-babysit/SKILL.md:111-125`.
11. U2 builds one generic `JevSwitch(key,label)` in `integrations.tsx` (`LeanMcp` `:164` is single-key); later
    units only add a row.
12. `judge()` does `mkdir -p` of `~/.local/share/wt-dashboard` before appending, failures swallowed;
    `typesafe.test.mjs` is added to `wt-dashboard/package.json` `npm test` in U1.

## Addition — observability (user, #wt-pack, after the first commit)

Research: Settings has **no server-log viewer today**. The Server tab only prints the path as text
(`web/src/status.tsx:108` `log ~/Library/Logs/wt-dashboard/server.log`; `server.mjs:2050`). So "move server logs"
means a new read-only viewer in the new tab, and the Server tab keeps its path text. Tabs are one array,
`web/src/settings.tsx:33` `const SECTIONS: [Section, string][] = [... ['server', 'Server'], ['about', 'About']]`.

- **U1 log record** (supersedes the `{ts, feature, ms, ok}` line in Approach): `judge()` appends to
  `~/.local/share/wt-dashboard/jev-calls.jsonl` `{ts, feature, outcome ('picked'|'not'|'failopen'), p, ms,
  cache (bool), err ('timeout'|'http_<n>'|'nokey'|'parse'|null), in}`. `in` is a sha1 prefix (12 chars) of the
  input; with `WT_JEV_LOG_SNIPPETS=on` (default off) also the first 120 chars. The key is never written.
  Cache hits are logged too (`cache:true`, `ms` ≈0) so the fail-open and hit rates are real. Rotation: when the file passes
  5 MB, rename it to `.1` (one old file kept) before appending. `ponytail:` a single rename, not a rotation library.
- **U2 changes:** `/api/health` `jev.calls` becomes a summary only (`today`, `errors`). The full stats move to U2b.
- **U2b — wt-dashboard: Observability tab (before U3).** Server: `GET /api/observability` (session-gated like
  `/api/config`) returns, for 24h and 7d, per feature: calls, cache hits, fail-open count, error and timeout
  rate, p50/p95 ms (computed from `jev-calls.jsonl` + `.1`); plus the `recent` 200 calls, filterable by
  `?feature=&outcome=&err=`. It also returns `sources` from the existing `track()` (`server.mjs:1085`:
  herdr/git/gh/linear), because those are already collected, so no new Linear/GitHub probes. `GET /api/logs/server?lines=500`
  tails `~/Library/Logs/wt-dashboard/server.log` (read-only, lines capped at 2000, file path fixed on the server,
  never taken from the query). Web: new `observability.tsx`, a new `['observability', 'Observability']` entry in
  `SECTIONS`, with two parts: **Integrations** (per-feature stats table, 24h/7d toggle, recent-calls table with
  feature/outcome/error filters, sources health) and **Server logs** (a tail with refresh and a text filter,
  in a native `overflow:auto` pre, as the Inbox fix used). The `WT_JEV_LOG_SNIPPETS` switch lives here. Verify:
  a server test aggregating a fixture jsonl (known p50/p95, fail-open count), plus a test that `/api/logs/server`
  ignores any path-like query; `npm test`, tsc, build; check it at 390px and on desktop with agent-browser.
- Every feature unit U3–U9 must show up under Integrations with its feature name. Its DoD report includes a
  screenshot of its row.

## Implementation units

Order: U1 → U2 → U2b, then pairs that touch different skills (max 2 workers): U3∥U6, U4∥U7, U5∥U8, U9.
One commit per skill per unit; merge to main after review, push.

**U1 — wt-shared: fail-open client + eval runner.** Files: `wt-shared/scripts/typesafe.mjs`,
`wt-shared/scripts/jev-eval.mjs` (new), `wt-shared/scripts/typesafe.test.mjs` (new), `wt-shared/README.md`;
then `wt-handoff/scripts/jev-mcp.mjs` ported to `judge('mcp', …)` (separate wt-handoff commit, output format
unchanged). Existing `ask()` untouched (wt-judge keeps its exit contract). Verify: test with a stub `fetch`
covering timeout → null, HTTP 500 → null, no key → null, cache hit makes no second fetch, counter line
written; `node --test wt-handoff/scripts/jev-mcp.test.mjs` still passes.

**U2 — wt-dashboard: switches + health.** Files: `wt-dashboard/config.mjs` (8 keys `WT_JEV_*`,
`oneOf ['on','off']`, defaults per Approach), `wt-dashboard/web/src/integrations.tsx` (a "Jev" group of
switches beside `LeanMcp`, `:56`), `wt-dashboard/server.mjs` `health()` (`:1111-1120`) gains
`jev.calls: {today, byFeature, errors, p50ms}` read from the jsonl (last 24h). Verify: `npm test`, tsc,
build; `curl /api/health | jq .jev.calls`; toggling a switch writes `WT_JEV_…=off` to the env file.

**U3 — item 2, room needs-you resolve (wt-dashboard).** `rooms.mjs:185-191` keeps the `?` rule as the sync
answer; when the previous message is the user's and `WT_JEV_ROOM_RESOLVE` is on, ask async: "Does this reply
still leave the user's question/request unanswered, or ask the user something?" (noul). Result overrides
`room.needsYou` for that handle when it arrives. Fixture `room-resolve.json`. Verify: parse.test.mjs cases
with a stubbed judge (answered → cleared, unanswered without `?` → kept, judge null → heuristic).

**U4 — item 1, pane needs-you (wt-dashboard).** In `parsePane` (`server.mjs:133-136`) the regex stays. For an
idle/blocked pane whose last-25-line tail hash changed and `WT_JEV_NEEDS_YOU` on: ask noul "Is this agent
waiting for the user to answer or decide something?"; yes ≥ threshold sets `asks` true and `question` to the
tail's last non-empty lines (as the regex path does, `:136`). Jev no → `asks` false only when the regex also
had no picker (`:382` picker path wins). Fixture `needs-you.json`. Verify: unit test on the merge rule with a
stubbed judge; count of calls per hour on the live server under 60 in `/api/health` over a normal session.

**U5 — item 5, stalled vs thinking (wt-dashboard).** Where `deriveTasks` marks `stalled` (`server.mjs:986-990`,
`STALL_MS` 20 min), with `WT_JEV_STALL` on ask choice over the pane tail: `finished` / `stuck` / `looping` /
`waiting_on_user`. Only `stuck`/`looping` keep `stalled`; `finished` → no stall notification;
`waiting_on_user` → needs_you. Also check working agents >20 min once per tail hash for `looping`. Null → today's
rule. Fixture `stall.json`. Verify: deriveTasks test with stubbed judge per class.

**U6 — item 3, handoff routing (wt-handoff).** In `handoff.sh` auto mode only, when `WT_JEV_ROUTE` on and the
prompt does **not** start with `Use wt-work` / `/goal Use wt-work`: `node jev-route.mjs` (new, on U1) asks noul
"Does this request need an implementation plan before any code is written?"; ≥0.75 → target a planner via
`agents.sh spawn planner`/free planner instead of a worker. `--pane`/`--new`/`--list` untouched; new flag
`--role worker|planner` forces either. Prints `route: planner (p=0.82)`. Fixture `route.json`. Verify:
`--dry-run`-style test via a stub judge env; existing handoff invocations unchanged with switch off.

**U7 — item 4, wt-memory (wt-memory).** (a) `remember`: after the exact-dup check (`wt-memory:116`), with
`WT_JEV_MEMORY_DUP` on, one batched call over the scope's existing entries asks per entry
`duplicate` / `conflicts` / `unrelated` (choice); prints `similar to: …` or `conflicts with: …` and still writes
(exit 0) unless `--strict`, which refuses. (b) `claude-plugin/hooks/inject.mjs` on UserPromptSubmit, with
`WT_JEV_MEMORY_SUGGEST` on: noul "Is this message a standing preference or recurring correction?" ≥0.8 →
additionalContext suggesting `wt-memory remember`. Bump plugin version. Fixtures `memory-dup.json`,
`memory-suggest.json`. Verify: wt-memory.test.mjs cases with a stub judge; hook returns within 2.5s with the
network blocked.

**U8 — item 6, babysit triage (wt-shared + wt-babysit).** `wt-judge.mjs triage` gains `--classes`: choice
`must_fix` / `question` / `nit` / `no_action` per comment (JSON adds `class`, `p`); without the flag, output is
unchanged. `wt-babysit/SKILL.md:110-125`: when `WT_JEV_BABYSIT_TRIAGE` on, fix must_fix, answer question,
reply-and-optionally-fix nit; never leave a thread unanswered (keep the existing rule). Fixture
`triage.json`. Verify: fixture eval; `triage` without the flag prints as before.

**U9 — item 7, inbox urgency (wt-dashboard).** Server scores each new inbox item once (score, 4 levels:
blocking / needs attention soon / FYI / noise) when `WT_JEV_INBOX_RANK` on, storing `urgency` 0-3 on the item
(`inbox.mjs`). `groupInbox` sorts groups by max urgency desc, then newest; items without `urgency` sort as 1
(today's order preserved when off). Fixture `inbox-rank.json`. Verify: notifyGate.test.ts sort cases; web tsc/build.

## Files

`wt-shared/scripts/typesafe.mjs`, `wt-shared/scripts/typesafe.test.mjs`, `wt-shared/scripts/jev-eval.mjs`,
`wt-shared/scripts/wt-judge.mjs`, `wt-shared/README.md`, `wt-shared/jev-fixtures/{room-resolve,needs-you,stall,route,memory-dup,memory-suggest,triage,inbox-rank}.json`,
`wt-handoff/scripts/jev-mcp.mjs`, `wt-handoff/scripts/jev-route.mjs`, `wt-handoff/scripts/handoff.sh`,
`wt-handoff/SKILL.md`, `wt-dashboard/config.mjs`, `wt-dashboard/server.mjs`, `wt-handoff/scripts/agents.sh` (read-only check), `wt-dashboard/rooms.mjs`,
`wt-dashboard/inbox.mjs`, `wt-dashboard/parse.test.mjs`, `wt-dashboard/package.json` (add typesafe test),
`wt-dashboard/web/src/integrations.tsx`, `wt-dashboard/web/src/observability.tsx` (new), `wt-dashboard/web/src/settings.tsx`, `wt-dashboard/web/src/notifyGate.ts`,
`wt-dashboard/web/src/notifyGate.test.ts`, `wt-memory/scripts/wt-memory`, `wt-memory/scripts/wt-memory.test.mjs`,
`wt-memory/claude-plugin/hooks/inject.mjs`, plugin manifest version, `wt-babysit/SKILL.md`.

## Verification

Per unit as listed. Across all: `cd wt-dashboard && npm test`, `cd web && npx tsc --noEmit -p . && npm run build`;
`node wt-shared/scripts/jev-eval.mjs <feature>` for each shipped feature, with accuracy and p50/p95 posted in
#wt-pack; with `TYPESAFE_API_KEY=` empty and the Keychain lookup failing, every feature behaves exactly as today.
Server restarted at most once per dashboard unit.

## Definition of Done

- `judge()` exists in `typesafe.mjs`, returns null on timeout/HTTP error/no key (tested), and `jev-mcp.mjs` uses it.
- Settings › Observability shows the Jev stats (24h/7d), the filterable recent calls and the server log tail; `jev-calls.jsonl` rotates at 5 MB and never contains the key.
- 8 `WT_JEV_*` feature switches (plus `WT_JEV_LOG_SNIPPETS`) appear in Settings with the defaults above; `/api/health` reports `jev.calls`.
- Each of U3–U9 is on main, each gated by its switch, each with a stub-judge test proving the fail-open path
  and a fixture file with ≥10 labelled cases.
- `jev-eval.mjs` results (accuracy, p50/p95) for every feature are posted in #wt-pack.
- `npm test`, web tsc and build pass on main.
- Each unit's completion report in #wt-pack pastes: the commit SHA(s), the test command's pass/fail line, and
  (U2+) the output of `curl -s …/api/health | jq .jev.calls`, so the transcript alone shows it landed.

## Risks and deferred

- Jev's exact output shape for `choice`/`score` is taken from `wt-judge.mjs:257-265` (`choice`,
  `probabilities`, `confidence`); `score` answer shape is [unsourced] — U9 must read one real response first.
- Free-text question extraction (item 1) is not a Jev answer type we have seen [unsourced]; the plan keeps the
  regex's tail-lines extraction and uses Jev only for the yes/no.
- Cost: no credits endpoint; the counter is the only signal. Poll-loop features default OFF for this reason.
- Deferred: learned thresholds from outcomes (the `wt-judge` log exists but is not wired to these features).
