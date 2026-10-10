# WP-294 — T3 Code review: what to copy, adapt or avoid for wt-pack

Point-in-time read-only review (2026-10-10). Repo: `github.com/pingdotgg/t3code` (MIT, "T3 Tools Inc."), shallow
clone at commit `57b3780770a829ff81e62d8dc658683bf51d5155` (2026-10-09), read only; nothing was run or modified. The
same commit is HEAD of the local clone at `~/Work/projects/t3code`, which was left untouched. Paths below are relative to that repo. Claims marked *(not found)* mean a targeted grep returned nothing, so they
are absence-of-evidence, not proof.

## What it is

Confirmed: "a minimal GUI for coding agents" (`AGENTS.md`). A Node WebSocket server (Effect-based, `apps/server`)
wraps provider CLIs/agents and serves web, Electron desktop and React Native clients. Providers: Codex, Claude Code
(via `@anthropic-ai/claude-agent-sdk ^0.3.276`, `apps/server/package.json`), Cursor, Grok, OpenCode, Antigravity,
Pi, and any ACP-registry agent. Its own pitch is "bring-your-own-subscription". The architecture target is written
down in `docs/orchestration-v2/` (README, data model, lifecycles, MCP server); the code is `apps/server/src/orchestration-v2/`.

## 1. Process model

- **SDK in-process driver, one `claude` child per provider session.** `orchestration-v2/Adapters/ClaudeAdapterV2.ts`
  calls the SDK's `query({ prompt, options })` where `prompt` is an async iterable fed from an unbounded queue
  (streaming-input mode); the SDK spawns the Claude Code binary (`pathToClaudeCodeExecutable`). The adapter's
  session handle is `{ messages: Stream<SDKMessage>, offer(userMessage), setModel, setPermissionMode, interrupt, close }`
  (`ClaudeAgentSdkQuerySession`, ~L335).
- **In:** user messages and steers are `offer`ed onto the prompt queue; model and permission mode change mid-session
  through the SDK control calls. **Out:** the SDK message stream is mapped by `ProviderEventIngestor` into normalized
  domain events (provider events are never rewritten to look like another provider's).
- **Interrupt:** `query.interrupt()`; it completes as a request, the turn ends later via the terminal event (the
  docs call the provider's terminal event "authoritative"). A comment in the adapter records a real deadlock found
  here: iterate the `Query` object, not its raw generator, or close hangs while the CLI is idle.
- **Permissions and questions:** the SDK `canUseTool` callback becomes a persisted *runtime request* (approval or
  `AskUserQuestion`); the callback awaits a `Deferred` that the `runtime-request.respond` outbox effect completes
  with allow/deny/"accept for session" (+ session permission rules) or the question answers. Cancel maps to
  deny + `interrupt: true`.
- **Pooling:** none beyond residency. `ProviderSessionManager.ts` keeps `LiveSessionEntry`s (one runtime, possibly
  several attached app threads for providers that multiplex, e.g. Codex app-server) behind `KeyedLock`s per session
  and thread. Claude is one process per session.
- **Isolation:** `packages/shared/src/AgentScope.ts` wraps the agent launch on Linux (high `oom_score_adj`, a
  transient systemd scope) so the OOM killer takes one agent, not the server. No-op on macOS/Windows.

## 2. Concurrency

- **No global cap, no queue, no pool, no backpressure on session count** *(not found: greps for max-concurrent,
  session limit, semaphore-around-spawn returned nothing)*. Every thread with a turn gets its own process.
- **What exists:** an **idle timeout** (`DEFAULT_IDLE_TIMEOUT_MS` = 30 min, `ProviderSessionManager.ts:54`): a session
  with no busy turns is released; release is *deferred* while background work is pending, capped by
  `DEFAULT_MAX_IDLE_PIN_MS` = 4 h. Per-thread command locks serialize commands on one thread. The lease/claim
  outbox (below) is the only work queue.
- **Bounded streams, not bounded sessions:** `LiveStreamBudget.ts` caps a live subscription buffer (1,000 items /
  8 MB serialized) so a slow client cannot grow memory without limit.
- **Delegation limits:** MCP-originated commands run under a `DispatchModeLimit` (a delegated child may not run with
  broader runtime/interaction mode than its parent). No depth or fan-out cap *(not found)*.

## 3. Supervision

- **Crash / error:** a runtime failure releases the session (`ProviderSessionReleaseReason` = `idle_timeout |
  runtime_error | manual_shutdown | server_shutdown`). The manager says it "intentionally does not resurrect persisted
  sessions": a later user command opens one lazily.
- **Restart recovery:** `ProviderRuntimeRecoveryService.reconcile("startup" | "shutdown")` terminalizes every
  non-terminal run (`preparing|starting|running|waiting`), stops sessions, expires open runtime requests ("the server
  restarted before this request was resolved"), retires non-replayable outbox effects and requeues replay-safe ones,
  and records orphaned background work on the thread. Optionally it queues a "Continue where you left off." run
  for an unfinished root turn (`RestartContinuation.ts`; background leftovers are reported, not resumed).
- **Resume:** by provider session id: the adapter passes `resume`/`resumeSessionAt` to the SDK; `forkSession` is
  used for forks; where a provider cannot fork or load, it falls back to a "portable context handoff".
- **Stuck turns:** no watchdog, heartbeat or per-turn timeout *(not found)*. A stuck turn is ended by the user
  (interrupt) or by restart reconciliation. The Claude usage-limit wait is surfaced in the UI instead of being
  timed out (`docs/user/providers-claude.md`).
- **Orphans:** on startup "all provider processes are gone", so reconciliation clears state rather than hunting
  pids. `AgentScope.oomKilled(threadId)` lets a failure be reported as an OOM kill.

## 4. Event store and outbox

- **Store (SQLite, `persistence/Migrations/055_OrchestrationV2.ts`):** `orchestration_v2_events(sequence INTEGER
  PRIMARY KEY AUTOINCREMENT, event_id UNIQUE, command_id, thread_id, run_id, node_id, provider, raw_event_id,
  event_type, occurred_at, payload_json)` with indexes on thread/run/node/command + sequence. Projection tables carry
  a `last_sequence` in `orchestration_v2_projection_metadata`. Command receipts (`OrchestrationCommandReceipts.ts`)
  make commands idempotent.
- **Streaming contract:** "read snapshot at sequence N → stream committed events where sequence > N"
  (`docs/orchestration-v2/core-graph-and-data-model.md`); the sequence belongs to the stored envelope, not the
  provider event. `ThreadStream.ts` takes an `afterSequence` cursor; `EventStore.read({afterSequence, threadId})` is the underlying read.
- **Outbox (`orchestration_v2_effect_outbox`):** `status pending|running|succeeded|failed`, `attempt_count`,
  `available_at`, `lease_owner`, `lease_expires_at`, `last_error`, claimed by workers with a lease
  (`EffectOutbox.claimNext`). Effect types include `provider-turn.start|interrupt|steer|restart`,
  `runtime-request.respond`, `provider-session.detach`, `checkpoint.capture`, `thread-title.generate`. Effects for a
  thread claim in order (a failed rollback blocks a later turn start). `reconcileAfterProcessLoss` clears leases.
- **Survives restart:** events, projections, receipts, outbox rows. **Does not:** provider processes, in-flight
  turns (terminalized), open approval/question requests (expired).
- **Raw provider frames** go to bounded rotating NDJSON diagnostics, not SQLite.

## 5. Auth

- Claude: it uses **Claude Code's own login and config**, nothing of its own: "T3 Code uses Claude Code's login and
  configuration" (`docs/user/providers-claude.md`). Multiple accounts = separate `CLAUDE_CONFIG_DIR` per provider
  instance with `claude auth login` run by the user; per-instance env vars cover API-key or router setups. The
  provider status is read from the SDK `initializationResult()` account info (subscription type is shown), via a
  disposable probe query. T3 stores no Claude credential and no `ANTHROPIC_API_KEY` appears in the server source
  *(not found)*; it launches the user's installed binary (`binaryPath` setting).
- Its own surface is separately authenticated (sessions, pairing links, per-provider-session MCP bearer tokens
  scoped to environment, thread, instance and session, short-lived and revoked on release).
- **Relevance to "No Claude API in the dashboard":** this is the same stance wt-pack would take (drive the
  unmodified binary under the user's login) but T3 does it through the Agent SDK package. The SDK package is the
  part to avoid under our rule; the pattern (SDK is a thin launcher around the user's `claude`) is what WP-290 found
  reproducible with plain `claude -p --input-format stream-json` and no SDK dependency. T3's own wording puts the
  responsibility on the user's own login, not on a hosted service.

## 6. Orchestration

- **Multi-agent:** yes, first-class. The app's MCP endpoint (`apps/server/src/mcp/`, key `t3-code`, injected into
  Claude as an HTTP MCP server with a bearer token) exposes `delegate_task` (create a child thread on any provider
  instance; child sees only the task prompt plus an optional role instruction), wait/poll for the durable result,
  cancel, create/list/read/rename threads, send or **steer** follow-ups, wait for or interrupt runs
  (`docs/orchestration-v2/orchestrator-mcp-server.md`, `OrchestratorMcpService.ts`). `ThreadManagementService` is the
  single application boundary shared by WebSocket commands and MCP. Steering degrades to interrupt-and-restart on
  providers that cannot steer (capability flags, not provider-name checks).
- **Tickets / board:** none in the server *(not found)*. A thread is the unit of work; there is no ticket model.
- **Scheduled / long-running jobs:** no scheduler or cron *(not found)*. "Background" means (a) background work *inside* a
  turn (subagents, shell jobs), which pins the session against idle release, and (b) the host service staying awake
  (`background/BackgroundPolicy.ts`, power-aware). A PR watcher would be modelled as a long-lived thread whose agent
  waits (`wait` tool) and is re-driven by commands; there is no timer that wakes it.

## 7. For WP-292 / WP-293: copy, adapt, avoid

Copy (ideas, not code; different stack):
1. **Command → event → projection with a store-assigned `sequence` and snapshot-then-stream cursor.** Matches what
   the dashboard needs for replay after reconnect; use the sequence as the single cursor for clients.
2. **Outbox with leases and `reconcileAfterProcessLoss`** for anything that must survive a server restart
   (deliveries, interrupts, answers). Keep effects ordered per thread.
3. **Restart reconciliation as a named step:** terminalize non-terminal runs, expire open asks, say why in the
   record. Cheap, and it removes the "stuck forever" class after a crash.
4. **Provider-neutral commands with capability flags;** degrade (steer → interrupt+restart) by policy.
5. **Single application service under both UI and MCP** (`ThreadManagementService`), so the two cannot drift.
6. **Idle release with a bounded deferral** (30 min, pin for pending background work up to 4 h).
7. **Bounded live-stream buffers** (item and byte caps).

Adapt:
- Approvals and questions as persisted, expirable *requests* answered by a command (ours already exist as
  `wt-ask` chips/Inbox cards; T3 shows the same lifecycle with an explicit expiry on restart).
- Delegation with a mode ceiling (`DispatchModeLimit`): worth porting as "a delegated agent never exceeds its
  dispatcher's permission mode". Add the depth/fan-out cap T3 lacks.
- Per-instance `CLAUDE_CONFIG_DIR` for multiple accounts: relevant if the dashboard ever drives more than one login.

Avoid:
- **No session cap at all.** For our single-machine, subscription-rate-limited use, add a global and per-project cap
  with a queue in front of spawn; T3's approach assumes the user watches.
- **No stuck-turn watchdog.** Add one (no events for N minutes while "running") rather than waiting for a restart.
- **The Agent SDK as a dependency** (auth/terms reading in WP-290); use the binary's stream-json or the inbox
  socket instead.
- The size: ~8.3k lines for one provider adapter and a full Effect runtime. We need the contracts above, not the framework.
- Provider breadth (Codex, Cursor, ACP registry) and checkpoint/rollback machinery: out of scope for the pack.
