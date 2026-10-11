# WP-315: headless on the Claude Agent SDK (plan)

Point-in-time (2026-10-11). Spike: `wp-315-sdk-spike.md`. User decision: ship the SDK driver **opt-in** (`WT_HEADLESS_DRIVER=sdk`,
default `cli`) for personal use on the user's own login, and document the terms caveat in `docs/features.md`.

## Decisions

1. **The seam is the process, not the class.** A new worker, `skills/wt-dashboard/headless-sdk/worker.mjs`, takes the same arguments
   as `claude -p …` and speaks the same stream-json on stdin and stdout. `Headless` keeps everything it owns: runs table, queue and cap,
   asks, permission policy, resume, WP-304 restart resume, plugins (WP-309), send_file (WP-308), role env (WP-307), the read-only lock,
   AgentInfo (WP-313) and kill by recorded pid. The SDK driver changes only what `#start` spawns: `process.execPath worker.mjs <args>`
   instead of `<cmd> <args>`. Feature parity comes from reuse, not from a second implementation.
2. **Dependency placement.** `headless-sdk/` has its own `package.json` and `package-lock.json`, with
   `@anthropic-ai/claude-agent-sdk` pinned to `0.3.296` plus its peers (`@anthropic-ai/sdk`, `@modelcontextprotocol/sdk`, `zod`).
   `server.mjs` and the rest of wt-dashboard stay dependency-free; only the worker imports the SDK, and it does so dynamically.
   `./setup` runs `npm ci --omit=optional` there (54 MB, no bundled binary), and doctor reports whether it is installed.
3. **The binary.** The worker passes `pathToClaudeCodeExecutable` as the server's `WT_HEADLESS_CMD`, resolved to an absolute path
   (default: `claude` on PATH). It uses `settingSources: ['user','project','local']`, so the user's settings, plugins and login apply
   exactly as for the CLI. There is no API key and no `env` beyond what `Headless` already passes.
4. **Flag.** `WT_HEADLESS_DRIVER=sdk|cli` (default `cli`, read by `Headless` like its other settings). A run records its driver in
   the new column `headless_runs.driver`, added additively; old rows are NULL, which means cli. A resume uses the run's recorded driver.
   If the SDK is not installed, the run fails at start with `SDK driver not installed: run ./setup`. Nothing silently switches drivers.
5. **WP-312/314.** After each `result`, the worker calls `getContextUsage()` and emits
   `{type:'system', subtype:'context_usage', totalTokens, maxTokens, percentage}`. `Headless` stores `maxTokens` as `context_window`
   and `totalTokens` as `context_used`, a new additive column. AgentInfo prefers those. `slash_commands` still come from `init`;
   `supportedCommands()` is emitted once after init as `{type:'system', subtype:'commands', commands}` and is stored in `init_commands`.
6. **Tests** use a fake SDK module. The worker imports `process.env.WT_HEADLESS_SDK_MODULE || '@anthropic-ai/claude-agent-sdk'`.
   The variable is test-only and undocumented.

## Worker contract (U1 builds it, U2 drives it)

- Run as: `node headless-sdk/worker.mjs [-p] [--permission-mode M] [--tools a,b] [--strict-mcp-config] [--mcp-config JSON]
  [--model M] [--effort E] [--settings JSON] [--resume SID]` with the cwd and env that `Headless` sets. It also gets
  `WT_CLAUDE_BIN`, an absolute path. Flags it does not know (`--input-format`, `--output-format`, `--verbose`,
  `--permission-prompt-tool`) are accepted and ignored.
- stdin is JSON lines: `{type:'user', message}` feeds the streaming prompt; `control_request {subtype:'interrupt'}` calls
  `q.interrupt()`; `control_request {subtype:'set_permission_mode', mode}` calls `q.setPermissionMode()`; `control_response` resolves
  a pending `canUseTool` by `request_id`.
- stdout is JSON lines: every `SDKMessage` as is (`system/init`, `assistant`, `user`, `result`, …).
  - `canUseTool(tool, input, {signal})` writes `control_request {request_id, request:{subtype:'can_use_tool', tool_name, input}}`
    and waits for the answer. An aborted signal writes `control_cancel_request {request_id}`.
  - The extra events `system/context_usage` and `system/commands` are described in decision 5.
- Lifecycle: on stdin EOF it ends the input stream, lets the query finish and exits 0. On SIGTERM it aborts through the
  AbortController and exits. The SDK's own `claude` child must not outlive the worker. If the SDK is missing, it writes the
  decision-4 message to stderr and exits 3.

## Units (non-overlapping files)

| Unit | Files | Done check |
|---|---|---|
| U1 worker | `headless-sdk/{package.json,package-lock.json,worker.mjs,worker.test.mjs}`, `test-fixtures/fake-sdk.mjs` | `node --test headless-sdk/worker.test.mjs` covers each stdin and stdout line of the contract, plus the missing-SDK exit |
| U2 supervisor | `headless.mjs`, `store.mjs` (columns `driver`, `context_used`), `server.mjs` `hl()`, `agentinfo.mjs`, `headless.test.mjs` | the existing headless tests pass unchanged; new tests: an sdk-driver run through the real worker with the fake SDK (spawn, ask, interrupt, context_usage, resume keeps its driver), and a missing SDK fails the run |
| U3 install and docs | `setup` (install and doctor), `skills/wt-dashboard/package.json` test list, `docs/features.md` (flag plus the terms caveat), `.gitignore` | `./setup doctor` in a scratch HOME shows the line; the docs are written for a public repo |

Integration happens on `wp-315-sdk-headless`, then `npm test` and `npm run build`. A live smoke test runs the sdk driver with the
fake SDK, a scratch data dir and a scratch port; one real haiku turn runs in a temp dir. No user run and no user data is touched.
