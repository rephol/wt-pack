# WP-128 — Jev model routing (haiku / sonnet / opus), self-tuning

## Goal

Every wt-pack session and subagent runs on the cheapest tier that can do its task:
- **haiku** for mechanical, bounded work;
- **sonnet** for normal work (the default);
- **opus** for judgement-heavy or risky work.

A Jev 3-way choice makes the pick. The rules decide what stays out of Jev's hands: an explicit model always wins,
and each floor sets a minimum tier. Routing starts in **shadow** mode, which logs the pick and changes nothing.
Measured outcomes (send-backs, returns, escalations) then tune the thresholds weekly, within fixed bounds.

It works in plugin-only installs (WP-122). The dashboard adds settings, a stats table and Inbox alerts on top,
but routing doesn't depend on it.

## What research corrected

- **"Modes off / shadow / live" is new, not an extension.** No Jev feature has a shadow mode: grep finds no
  "shadow". `enabled(feature)` is on/off only: `WT_JEV_<FEATURE> … === 'on'` (`wt-shared/scripts/typesafe.mjs:138-140`).
- **`~/.config/wt-pack/` does not exist**, and there's no layered config loader. The only layered lookup is
  `envSetting(name)` (`typesafe.mjs:124`): env first, then the last line in `~/.config/wt-dashboard/env`. The
  five-layer precedence in the ticket is built here.
- **"Observability charts": the dashboard has no chart component.** `web/src/observability.tsx` renders a
  **table**, "Jev calls by feature" (`Stat {calls, cacheHits, failOpen, picked, …}`, line 18). This plan ships a
  per-skill×tier **table**; charts are deferred (see Risks).
- **Most outcome signals aren't recorded anywhere yet.**
  - Recorded: `board_events` has `returned` (written at `dispatch.mjs:193`), ticket history has the moves, and
    the Inbox has `agent-stalled` and `ci-failed`.
  - Not recorded: review send-backs, tests failing after done, the parent re-running a task, and user corrections.

  This plan records the first two cheaply (U4). The last two are deferred.
- **The subagent hook is plausible but unverified.** The docs say `hookSpecificOutput.updatedInput` "merges with
  original tool_input" for PreToolUse, and that the subagent tool is `Agent` (`Task` is the deprecated alias).
  Neither the docs nor the repo show `updatedInput` working on `Agent`: the only existing hook,
  `pkill-guard.mjs`, emits only `permissionDecision: 'deny'`. U3 starts with a spike.
- **`/model <tier>` mid-session: whether it switches without a picker, and whether it works while a `/goal` is
  active, is undocumented.** U2 starts with a spike.
- **`--resume <id> --model x` overrides the restored model** ("`--model` flag takes precedence"). So
  `watchdog.mjs:193` resume argv must **not** add `--model`, or a resume would silently change the tier.

## Approach

One module, `wt-shared/scripts/model-route.mjs`, holds the routing core: build the state, decide locally or ask
Jev, apply rules and floors, log. Every caller uses its CLI.

**Where it hooks in:**
- **Session level (about 94% of spend):**
  - `agents.sh spawn` adds `--model <tier>` to the argv at the one insertion point (`agents.sh:207-209`,
    `set -- --name "$label"`). Every dashboard path (spawnAgent, Dispatch, routines, New agent) goes through
    agents.sh or handoff.sh (`server.mjs:1034`, `:1289/1295`, `:2634`, `dispatch.mjs:9`), so they all inherit it.
  - `handoff.sh` reuse sends `/model <tier>` before the task, the same way the optional `/clear` is sent in
    `hand_to()` (`handoff.sh:202-210`).
- **Subagent level:** a PreToolUse `Agent` hook fills `model` when it's absent.

**Settled decisions** (the user approved the design in #wt-pack; details made headless):
- *Reuse `typesafe.mjs` `judge()`.* It never throws, has a timeout, retries a 5xx once, keeps a sha1 cache, and
  logs to `jev-calls.jsonl`. It is called with `timeoutMs: 1500` and a `choice(...)` question.
  - Rejected: a new client. Everything the ticket asks of one is already in `judge()`.
- *Durable cache.* `judge()`'s cache is per process (`CACHE_TTL = 10 min`), and every hook call is a new
  process. So `model-route.mjs` keeps its own on-disk cache: `~/.cache/wt-pack/model-route.json`, keyed by the
  state hash, max 2,000 entries, TTL 7 days.
- *Config.* The file schema:

  ```
  { mode: 'off'|'shadow'|'live', skills: { <skill>: { mode?, pin?: tier, floor?: tier } },
    floors: { correctness|security|data|migration: 'sonnet' }, roleFloors: { planner: 'opus' },
    thresholds: { haiku: 0.8, opus: 0.6 } }
  ```

  - The layers merge in this order: env `WT_MODEL_ROUTING` (a mode string, or `off` as the kill switch), then
    the repo `.wt-pack/model-routing.json`, then the dashboard project setting `WT_MODEL_ROUTING` (mode only),
    then `~/.config/wt-pack/model-routing.json`, then the built-in defaults.
  - The global mode defaults to `shadow`.
- *The decision order:*
  1. The kill switch or mode `off` means no pick.
  2. An explicit model wins: the caller passes it, the Agent call already has `model`, or the agent definition
     has one. Then routing does nothing.
  3. A skill `pin` gives that tier.
  4. Local obvious cases, with no call. Examples: a read-only Explore subagent → haiku; a skill in {wt-review
     security/data lens, wt-plan} → at least the floor; length < 80 chars and no edit verbs → haiku.
  5. Jev choice. It picks haiku only when the choice is `haiku` with confidence ≥ `thresholds.haiku`, and opus
     only when the choice is `opus` with confidence ≥ `thresholds.opus`. Otherwise, including on failure or
     timeout, it picks sonnet. Review corrected this rule: a `choice` answer is only `{choice, confidence}`,
     with no per-option probabilities (`ticketJev.mjs:40`), so the first draft's p(haiku)/p(opus) couldn't be
     read.
  6. `max(pick, floors)`.

  **Floors only raise the tier.**
- *State ≤ about 300 tokens:* `{skill, agent_description, task: first 600 chars, signals: {edits, reads, lens, keywords[], len}}`.
  The question text is a constant string.
- *Shadow logs the decision and returns nothing to apply.* Live returns the tier.
- *Escalation lives on the ticket, not the pane.* Review found that `returned` fires only after the assignee has
  been gone from herdr for two scans, and then unassigns the ticket (`dispatch.mjs:180-193`). No pane is left to
  send `/model opus` to, and a return mostly means the agent died, not that the model fell short.
  - The primary signal is therefore the wt-review send-back (U4). `returned` counts only as a weak signal.
  - On a ticket's second send-back or return (live mode), U4 sets the ticket's dispatch record to
    `model: 'opus'`. The next handoff for that ticket passes `--model opus`, or sends `/model opus` to a reused
    worker.

## Implementation units

### U1 — routing core `model-route.mjs` (wt-shared)
- `skills/wt-shared/scripts/model-route.mjs` exports `buildState`, `localDecide`, `applyFloors`, `loadConfig`
  and `route()`, plus a CLI:
  - `model-route.mjs pick --skill S [--role R] [--lens L] [--model M] [--cwd D] < task` prints
    `haiku|sonnet|opus` in live mode, and nothing in off/shadow. It always exits 0. With `--json` it adds
    `run#i`, for the caller to store.
  - `model-route.mjs explain …` prints the whole decision as JSON, for tests and the dashboard.
- Every decision appends `{run, i, ts, cmd:'routing', p: confidence, t: threshold, decided: tier !== 'sonnet', item:{skill, tier, mode, source:local|jev|pin|floor|explicit}}`
  to the judge log (`typesafe.mjs:79` `LOG`, record shape at `:84`). `calibrate` must **skip
  `cmd:'routing'`**, because its binary `decided = p ≥ t` would misread a 3-way pick. Tuning belongs only to U5.
- Outcomes with a reason go to `~/.local/share/wt-pack/routing-outcomes.jsonl` as `{run, i, ts, outcome: ok|send-back|returned|escalated, why}`.
  `wt-judge.mjs mark` takes only `<run>#<i> yes|no` and has no `--why`, so the reason lives here. `mark` is
  still called, with `no` or `yes`, so that existing tooling sees the label.
- Tests in `model-route.test.mjs`:
  - the state builder stays within 300 tokens (use 1,200 chars as the proxy) and the question is constant;
  - a cache hit makes no fetch (stub `fetchImpl`);
  - floors only raise;
  - explicit wins;
  - pin wins over Jev but not over a floor;
  - precedence across all five layers, using a temp HOME and temp repo;
  - the kill switch;
  - a timeout gives sonnet within 1.5 s.
- **Verify:** `node --test skills/wt-shared/scripts/model-route.test.mjs`.

### U2 — session level (wt-agents, wt-handoff)
- **Spike first.** Run a throwaway herdr claude agent (`agents.sh spawn worker <tmp repo>`; never a real agent,
  per the CLAUDE.md Trap). Send it `/model haiku` with `herdr agent prompt`, once while idle and once with a
  `/goal` active, and check the model in its transcript (`message.model`). Record the result in the PR body.
- `agents.sh spawn [--model T]` only **applies** a tier. It receives no prompt (usage:
  `spawn <role> [cwd] [--mcp …]`; the task arrives later through handoff.sh), so it can't route. It adds
  `--model <T>` to `set --` when `T` is given; otherwise, only the role floor applies: a planner gets
  `--model opus` when mode is live. Without a tier, nothing is added.
- `handoff.sh` is where routing happens:
  - it runs `model-route.mjs pick --json --skill <role|skill from prompt> --role <role>` on the prompt text;
  - a ticket whose dispatch record has `model` (U4) uses that model as the explicit one;
  - `--new` passes `--model <tier>` to spawn;
  - reuse sends `/model <tier>` before the task in `hand_to()`;
  - it stores the `run#i` on the ticket's dispatch record via `wt-ticket` when a ticket is known, and otherwise
    as pane token `route_run`. Review noted that tokens die with the pane and `route_run` isn't in
    `MIRRORED_KEYS` (`roles.mjs:25`), so the ticket record is the durable copy;
  - if the spike shows `/model` is unusable (a picker, or ignored under `/goal`), reuse is **skipped for routed
    handoffs**, which then spawn `--new` with `--model` instead.
- `watchdog.mjs` resume argv stays without `--model` (see the correction above). Add a test pinning that.
- Tests:
  - extend `spawn-env.test.mjs`: a stub `model-route` printing `haiku` leads to `--model haiku` in the herdr
    argv; printing nothing leads to no flag; `--model opus` passed explicitly wins;
  - a handoff `--dry-run` case prints `would send /model <tier>`.
- **Verify:** `node --test skills/wt-agents/scripts/*.test.mjs skills/wt-handoff/scripts/*.test.mjs`.

### U3 — subagent hook (plugin)
- **Spike first.** A throwaway plugin dir with a PreToolUse `Agent` hook returning
  `{hookSpecificOutput:{hookEventName:'PreToolUse', updatedInput:{model:'haiku'}}}`. Run
  `claude --plugin-dir <tmp> -p "spawn a subagent that says hi"`, then check the subagent transcript's
  `message.model`.
- If the spike works: add `skills/wt-shared/hooks/model-route-hook.mjs`. When `tool_input.model` is absent it
  calls `route()` with `skill` from `subagent_type`, `agent_description` from `description`, and the task from
  `prompt`. In live mode it returns `updatedInput`; otherwise it outputs nothing. Register it in **both** hook
  files, `hooks/hooks.json` (root) and `skills/wt-memory/claude-plugin/hooks/hooks.json`, with
  `"matcher": "Agent|Task"`.
- If the spike fails: ship no hook. Instead add a one-line rule to the skills that dispatch subagents (wt-review,
  wt-research, wt-plan): "set `model` from `model-route.mjs pick --skill <lens>`". Record the reason.
- Test, modelled on `pkill-guard.test.mjs:8`:
  - no model in the input: live gives `updatedInput.model`, shadow gives empty output;
  - a model present gives empty output;
  - any error gives empty output (it must never block a tool call).
- **Verify:** `node --test skills/wt-shared/hooks/*.test.mjs`, and `claude plugin validate --strict .`.

### U4 — outcomes + escalation (wt-dashboard, wt-review)
- Record outcomes against the `run#i` stored on the ticket's dispatch record (U2):
  - `dispatch.mjs`: `returned` → outcome `returned`, `mark … no`; done without a return or send-back →
    `ok`, `mark … yes`;
  - wt-review diff mode, when it returns high-severity correctness findings on work it didn't write, runs
    `model-route.mjs outcome <run#i> send-back "<one line>"`. That command writes the outcomes log and calls
    `mark … no`.
- Escalation (live mode only): on a ticket's second `returned` or send-back (counted from the ticket history and
  the outcomes log), set the dispatch record's `model: 'opus'`, log outcome `escalated`, and add an Inbox item,
  kind `routing-escalation` (KINDS and ACTIONABLE updated).
- Tests in `dispatch.test.mjs`:
  - two returns set `model: 'opus'` and add the Inbox item;
  - one return doesn't;
  - shadow mode never sets it;
  - the next handoff's dry-run shows `--model opus`.
- **Verify:** `npm test` in `skills/wt-dashboard`.

### U5 — self-tuning eval (wt-shared)
- `jev-eval.mjs`:
  - add a `routing` evaluator (`EVALUATORS` line + `jev-fixtures/routing.json`, seeded with about 30 labelled
    tasks drawn from real skills);
  - add `jev-eval routing --report [--since 7d] [--apply]`. Review found that `jev-eval.mjs` is one top-level
    script that exits when no API key is set, so report/apply goes in a new importable
    `wt-shared/scripts/routing-eval.mjs`. `jev-eval.mjs` gets an early `routing --report` branch before the key
    check. There's no jev-eval test yet; `routing-eval.test.mjs` is new.
- The report shows, per skill×tier from the judge log: picks, share applied (live), send-back rate, escalations,
  and estimated tokens saved (tier price ratio × session tokens, where transcripts give `message.usage`
  [unsourced — skip the column if absent]).
- `--apply`:
  - moves each threshold by at most **±0.05** per run;
  - skips pinned skills;
  - never lowers a floor;
  - writes `~/.config/wt-pack/model-routing.json`;
  - posts each change with `room post wt-pack` (best-effort).
- Escalations and send-backs are appended to `jev-fixtures/routing.json` as fixtures, deduped by state hash.
- Tests: the bound is clamped at 0.05; a pin is untouched; a floor is never loosened; fixtures don't duplicate.
- **Verify:** `node --test skills/wt-shared/scripts/routing-eval.test.mjs`.

### U6 — dashboard surface + docs (wt-dashboard, docs)
- Add a project setting `WT_MODEL_ROUTING` (`off|shadow|live`) in `project-settings.mjs` `PKEYS`, with its
  `CHOICES` in `web/src/projects-settings.tsx:31`.
- Add an Observability "Model routing" table: skill × tier picks, applied, send-backs and escalations, from the
  `explain`/judge log via `observabilityApi` (`server.mjs:2178`).
- Update the Weekly Jev eval routine (`routines` table, id `jev-eval`) to the 5-step prompt posted in #wt-pack
  (room msg #755). Do it through the routines API/UI **after merge**, as the ticket says "when this ships".
- Docs: `docs/features.md` (routing, modes, config files and precedence, escalation, the eval); CLAUDE.md skill
  map note under wt-shared.
- **Verify:** `npm test`; `npx tsc --noEmit -p web`; web build; one service restart; an agent-browser check of
  the setting and the table (`--session <your agent name>`).

## Files

- New:
  - `skills/wt-shared/scripts/model-route.mjs` + `.test.mjs`
  - `skills/wt-shared/hooks/model-route-hook.mjs` + `.test.mjs` (only if the U3 spike passes)
  - `skills/wt-shared/jev-fixtures/routing.json`
  - `skills/wt-shared/scripts/routing-eval.mjs` + `.test.mjs`
- Modified:
  - `skills/wt-shared/scripts/jev-eval.mjs`, `skills/wt-shared/scripts/wt-judge.mjs` (calibrate skips routing)
  - `skills/wt-agents/scripts/agents.sh`, `spawn-env.test.mjs`
  - `skills/wt-handoff/scripts/handoff.sh` + test
  - `hooks/hooks.json`, `skills/wt-memory/claude-plugin/hooks/hooks.json`
  - `skills/wt-dashboard/`: `dispatch.mjs`, `dispatch.test.mjs`, `inbox.mjs`, `watchdog.test.mjs`,
    `project-settings.mjs`, `server.mjs`, `web/src/projects-settings.tsx`, `web/src/observability.tsx`
  - `skills/wt-review/SKILL.md` (the send-back marker)
  - U3 fallback only: `skills/wt-research/SKILL.md`, `skills/wt-plan/SKILL.md`
  - `docs/features.md`, `CLAUDE.md`

## Definition of Done

The transcript shows each command and its output:

1. The U2 and U3 spike results are stated: `/model` idle / under `/goal`, and `updatedInput` on `Agent`. The
   matching branch was taken.
2. `node --test` passes for wt-shared (routing core, hook if shipped, eval), wt-agents and wt-handoff.
   `npm test` in wt-dashboard passes, and `tsc` is clean.
3. `model-route.mjs explain --skill wt-work < sample` prints a decision whose mode is `shadow` by default. With
   `WT_MODEL_ROUTING=live`, `pick` prints a tier; with `WT_MODEL_ROUTING=off`, it prints nothing.
4. `jev-eval routing --report` runs on the live judge log. `--apply` on a temp config moves no threshold by more
   than 0.05.
5. The dashboard shows the Model routing table and the project setting (agent-browser screenshot).
6. The default install stays in shadow: no real agent's model changes on merge.
7. features.md and CLAUDE.md are updated, with one commit per skill touched. U2 is two commits (wt-agents,
   wt-handoff) and U4 is two (wt-dashboard, wt-review). The routine prompt is updated after
   merge, and its new text is shown.

## Risks and deferred

- **Charts are deferred.** There's no chart component yet; the table carries the same numbers. A charting
  follow-up can use the `dataviz` guidance.
- **Unrecorded signals are deferred:** "tests failing after done", "parent re-ran the task" and "user
  corrections". Tuning uses returns and send-backs only until those exist.
- **Two routed layers can compound.** A haiku session spawning subagents that default to its own model: the hook
  routes each subagent on its own task, so a haiku session can still get an opus subagent. That is intended.
- **Cost.** One Jev call per un-cached decision (about 300 tokens of state). Floors and local rules skip most
  calls.
- **Live mode is the user's switch.** This merge leaves everything in shadow.
