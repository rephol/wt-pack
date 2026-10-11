# WP-318 — budgeted keepwarm mod

Ticket: a wt-mod that keeps a long-lived agent's 1h prompt cache warm with a tool-less fork after ~50 idle minutes,
within a per-role, time-boxed budget, configured from dashboard Settings and visible per agent. **Order is fixed by
the ticket and the orchestrator: Unit 0 measures first; Units 1–4 start only after the orchestrator accepts Unit 0's
numbers.** The branch reports to the orchestrator (w1M:p2) for merge; no wt-ship.

## Evidence (research, 2026-10-11, Claude Code 2.1.296)

- **`$.model.fork` exists and is tool-less.** The engine checks `"model.fork":{check:(n)=>typeof n?.prompt!=="string"…`,
  denies tools (`"A model fork cannot use tools"`), and returns `{isAnswered, text}` or
  `{isAnswered:false, reason:"aborted"|"empty-reply", usage}`. **Unknown: whether a fork reuses the session's cached
  prefix** — the whole premise; Unit 0 settles it.
- **Mod plumbing:** shared events are chained once in `hooks/register.ts:38-41`
  (`on('turn.complete', ($, e, next) => runShared(ctx($), mods, 'turn.complete', e, next))`); a new `$` capability
  must be added to `Ctx` (`skills/wt-mods/hooks/compose.ts:11-19`) and to `ctx()` (`register.ts:18-28`), because the
  loader follows `$` only into same-file functions (`compose.ts:9-10`). Timers: `every: (ms, fn) => $.clock.every(ms, fn)`
  (`register.ts:23`). CLI: `$.process.run([wt, ...argv], { stdin, timeoutMs })` (`skills/wt-ask/hooks/register.ts:17`).
  Commands: `/wt` table at `skills/wt-mods/hooks/commands.ts:27`, registered at `:57`. Status: `$.ui.status(...)`.
- **Env access exists** (CLAUDE.md says mods have none — disproved): `commands.ts:41`
  `await $.env.get('HERDR_PANE_ID')`. Role still comes from the pane's `role` token via the dashboard
  (`server.mjs:2777`, `…?.tags?.role`), not from the mod.
- **Usage:** `register.ts:25` `contextPercent: async () => (await $.session.usage()).context.percent` (WP-282,
  `skills/wt-mods/hooks/context.ts`). Fork results carry `usage`; the binary maps `cache_read_input_tokens`.
  Dashboard limits: `skills/wt-dashboard/usage.mjs:29` `readLimits` (5-hour / weekly %, from
  `~/.cache/ccstatusline/usage.json`), UI `web/src/usage.tsx:72`.
- **Settings — ticket corrected:** `/api/settings` is the *Rooms* settings route with GET + **PATCH** (not PUT),
  fields in `rooms.mjs:10` `DEFAULT_SETTINGS`, validated at `rooms.mjs:294-300`, UI `web/src/settings.tsx:200-202`.
  Housekeeping keeps its own `DEFAULTS` + `cleanSettings` (`housekeeping.mjs:7`, `server.mjs:3843`). No settings →
  CLI path exists today.
- **AgentInfo** is built server-side (`skills/wt-dashboard/agentinfo.mjs:33` `paneInfo`, `:45` `headlessInfo`, types in
  `contracts.d.mts`), rendered from `web/src/agentInfo.ts` / `App.tsx:119`. No mod → dashboard state route exists; the
  pane-authenticated pattern is the `x-herdr-pane` allowlist at `server.mjs:2451-2452` (`/api/asks`, `/api/deliveries…`).
- Nothing keepwarm/cold-send exists yet. Watch `STALL_MS` (20 min idle-stall, `server.mjs:1592`): whether a fork
  counts as activity is unknown — keepwarm must not make an idle agent look busy or reset stall detection
  `[unsourced: checked in Unit 3]`.

## Unit 0 — measure (gate; no product code)

Throwaway long-lived session (temp dir, not a real agent), context pushed ≥ 50k tokens, then idle. A tiny temporary
mod or a one-off `claude -p` stream-json script is not enough — it must be a fork over a real session, so: a scratch
local mod (in the temp dir, never committed) that fires `$.model.fork({prompt:'ok'})` on demand and logs
`usage` to a file.

Record, per fork (≥ 3 forks, ~50 min apart, plus one at > 60 min as the "cold" control):
- `cache_read_input_tokens`, `cache_creation_input_tokens`, `input_tokens`, `output_tokens` from the fork's usage;
- 5-hour and weekly % from `readLimits` before and after (note the % resolution; if one fork does not move it, do 5
  in a row and divide).

Outcome to the orchestrator in one reply: **reuse?** (warm fork reads ≈ the context, cold control writes it),
**limit cost** of a warm fork vs a cold send in %. Stop the session by recorded pid; delete the temp dir and its
transcript. If forks do not reuse the cache, or a read costs like fresh input against the limits, **stop: the
orchestrator decides drop vs tighter budget.** Also confirm, from the binary/engine, whether a second plugin's hook
on `turn.complete` (cache-tax beside wt-pack) is refused or chained — note only, we build inside wt-mods.

## Unit 0 — results (measured 2026-10-11, sonnet, one scratch session, ~160k-token context)

Source of every number is named. Harness: `claude -p` stream-json driven by a script (a fork-equivalent ping on the same session), not the `$.model.fork` mod API.

**Cache reuse across idle gaps** (usage of each ping's assistant message, `forks.json`):

| ping | idle gap | cache read | cache write | verdict |
|---|---|---|---|---|
| 0 | 1 min | 141,086 | 19,036 | warm |
| 1 | 49.3 min | 141,086 | 19,036 | warm |
| 2 | 49.6 min | 141,086 | 19,036 | warm |
| 3 | 49.9 min | 141,086 | 19,036 | warm |
| 4 (cold control) | 65.3 min | 10,988 | 149,134 | **cold: the whole context re-written** |

- A ping every ~50 min keeps the 1 h cache alive indefinitely (4 pings, ~150 min, identical reads). A > 60 min gap loses it and re-writes everything (149k tokens).
- **The "13% write" is a constant, not a leak**: 19,036 tokens written on every warm ping are the same tail each time (the fork's own new turn does not extend the cached prefix). `stopWritePct` default 10 would therefore stop a perfectly healthy keepwarm. Use "writes >= 50% of reads" (a cold ping writes ~1,357% of reads) or compare against the previous ping (a *change* in cache_read, or read < 50% of the context).

**Limit cost** (source: `rate_limit_event.rate_limit_info.unifiedWindows.*.utilization` in stream-json, resolution 0.01; the earlier `ccstatusline/usage.json` numbers were a day stale and are discarded). Burst in a fresh scratch dir (HERDR_* stripped): 1 cold send of ~160k tokens, then 10 warm pings back to back (each reads ~166k):
- the cold send moved five_hour 0.13 → 0.14 (and the next event, after turn 2, still 0.14); seven_day 0.22 → 0.22. The event is only emitted when a window moves, and **ten warm pings emitted none**: ten 166k-token reads cost < 0.01 of the five-hour window in total, i.e. under ~0.1% each — below the resolution.
- Cost proxy (`total_cost_usd`, the session's own API-price estimate, not the plan limit): cold send $0.70; each warm ping +$0.017 (**~2.5% of a cold send**). A cold re-send after a lapsed cache costs ~40 warm pings.
- Conclusion: **reads are cheap against the limits** (they do not count like fresh input), so the idea holds; the budget is about total pings, not limit pressure.

**Recommended defaults** (the user already set: daily cap 15 pings, window 1-12 h in 1 h steps, `/wt keepwarm status|off`):
- ping interval 50 min (floor 5; never above 55); min context 50,000 tokens; window default 3 h; daily cap 15 per agent (a 12 h window at 50 min is 14 pings, so 15 never truncates a window).
- Stop rules: **zero reads** (cache already cold: stop and mark cold), or **read < 50% of the previous ping's read**; drop the "writes >= 10% of reads" rule. Cost of one lapsed window: one cold re-send (~$0.70 at 160k), about 40 warm pings; at 15 pings/day the worst case is ~$0.26/day per agent in estimate terms.
- Not measured: `$.model.fork` itself (the real mod path) and a second plugin's `turn.complete` hook; both are Unit 1+ checks.

## Unit 1 — settings + config CLI (wt-dashboard)

`skills/wt-dashboard/keepwarm.mjs`: `DEFAULTS` and `clean(input)` (housekeeping's pattern), persisted like housekeeping:

| key | default | rule |
|---|---|---|
| `enabled` | `false` | bool |
| `roles` | `['orchestrator','tech-lead','planner']` | known role names |
| `minContext` | `50000` | tokens, int ≥ 0 |
| `intervalMin` | `50` | int, 5..59 |
| `windowH` | `3` | int, **1..12** (user) |
| `dailyCap` | `15` | pings per agent per day, int ≥ 1 (user) |
| `stopZeroReads` | `true` | stop when a ping reads 0 |
| `stopWritePct` | `10` | stop when writes ≥ X% of reads, 0..100 |

Routes: `GET/PATCH /api/keepwarm/settings` (user only for PATCH; 400 on any out-of-range value, `windowH` especially);
per-agent `POST /api/keepwarm/:pane {arm|off, windowH?}` (`windowH` ≤ global ceiling, else 400); pane-authenticated
`GET /api/keepwarm/me` → effective config for that pane (role from its token, enabled only if role ∈ roles or armed)
and `POST /api/keepwarm/me/report {event: ping|stop, usage, reason?, nextAt}`, both added to the `x-herdr-pane`
allowlist at `server.mjs:2451`. A `wt-keepwarm` CLI (`skills/wt-mods/scripts/wt-keepwarm`, `config` / `report`) wraps
them, like `wt-ask`. Tests: `keepwarm.test.mjs` (clean: every bound incl. windowH 0/13/2.5) + routes test.

## Unit 2 — the mod (wt-mods)

`skills/wt-mods/hooks/keepwarm.ts`, added to `mods` in `register.ts:33`; `ctx()` / `Ctx` gain `fork(prompt)` and
`usage()`. Logic (pure, testable `decide(state, now, cfg)`):
- `session.start`: `wt-keepwarm config` once, cached; disabled → do nothing else.
- `turn.complete` (a real turn): `lastReal = now`; reset `stopped` only on a user/real turn.
- `every(60s)`: fire a ping when `enabled && contextTokens ≥ minContext && now - lastActivity ≥ intervalMin && now -
  lastReal ≤ windowH && pingsToday < dailyCap && !stopped`. Ping = `fork({prompt:'Reply with: ok'})`.
- After a ping: stop if `cache_read == 0` (and `stopZeroReads`) or `cache_creation ≥ stopWritePct% × cache_read`;
  report `ping|stop` with usage and `nextAt`. A ping never counts as `lastReal`.
- `/wt keepwarm [status|off]` (user: inside `/wt`, no separate `/keepwarm`) in the `/wt` table (`commands.ts:27`) — status: warm|cold, next ping, pings today;
  off: stop for this session and report.
Tests: `keepwarm.test.ts` via `skills/wt-mods/scripts/test`: decide() for each gate (window edge, cap, min context,
stop rules), and a ping never extends the window.

## Unit 3 — dashboard surfaces

- Settings: a "Keepwarm" section in `web/src/settings.tsx` (window as a 1..12 select, interval number with min 5).
- AgentInfo: `agentinfo.mjs` `paneInfo` adds `keepwarm: { state: 'warm'|'cold'|'off', nextAt, pingsToday, spentTokens }`
  from the reports (types in `contracts.d.mts`); agent menu gains Arm/Off (`POST /api/keepwarm/:pane`).
- Confirm a report/ping does not count as activity for `STALL_MS` (`server.mjs:1592`) or idle retirement; test it.
- `cd skills/wt-dashboard && npm test`.

## Unit 4 — docs

`docs/features.md` § mods list (~181), § Settings (~582), § Agents (~222); `skills/wt-mods/SKILL.md`; CLAUDE.md trap
line correcting "mods have no env access" (`$.env.get` exists, `commands.ts:41`).

## Commits

One per skill: wt-dashboard (units 1, 3), wt-mods (units 1 CLI, 2, register.ts), docs with the dashboard commit.

## Definition of done

- Unit 0's numbers posted to the orchestrator and accepted (or the ticket stopped there).
- `skills/wt-mods/scripts/test`, `npm test` (wt-dashboard) pass.
- Live check on a throwaway armed session: one ping fires after the interval, AgentInfo shows warm + next ping,
  `/wt keepwarm off` stops it, and the session/temp dir are cleaned up.

QA brief: Settings → Keepwarm: window select offers 1..12 h only, bad values rejected; Agents → a throwaway
orchestrator-role agent → AgentInfo shows warm|cold and next ping; agent menu Off turns it cold. Check at 412x700 and
iPhone 13.

No e2e writing or running.
