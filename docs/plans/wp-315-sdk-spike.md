# WP-315: headless on the Claude Agent SDK (verification spike)

Point-in-time (2026-10-11), `@anthropic-ai/claude-agent-sdk` 0.3.296 with Claude Code 2.1.296 on macOS. Each run used a
throwaway temp directory, a haiku model and a minimal env (HOME, PATH, USER; no `ANTHROPIC_API_KEY`). Afterwards, no SDK
or `claude` process was left running, and no live headless run or real agent was touched.

## Results

| Check | Result |
|---|---|
| Auth | `query()` ran on the user's own Claude login: `init.apiKeySource: "none"`, `accountInfo()` reports "Claude Max". No API key anywhere. |
| Who calls the API | A preload that logs every `fetch`, `http(s).request` and `net.connect` of the Node process recorded **no network calls**. The spawned `claude` binary does all model traffic, exactly as in the `-p` supervisor, so the dashboard's Node process itself makes no Claude API call. |
| Binary | `pathToClaudeCodeExecutable: ~/.local/bin/claude` (the user's installed, unmodified Claude Code) works. The bundled binary works too, but adds ~240 MB. |
| User settings and plugins | With `settingSources: ['user','project','local']`, the same 17 plugins load as for the CLI (`wt-pack` first), with 23 `wt*` slash commands. |
| API surface used by WP-312/314 | `getContextUsage()` (categories, totalTokens, maxTokens, percentage), `supportedCommands()`, `accountInfo()`, `interrupt()` and `setPermissionMode()` are present and typed. `canUseTool` is the ask hook. |
| Dependency shape | No runtime `dependencies`. There are peers `@anthropic-ai/sdk` (the API client, types only on this path), `@modelcontextprotocol/sdk` and `zod`, plus optional per-platform binaries. `npm install --omit=optional` gives **54 MB** and runs with the installed binary. |

## Terms (reading, not legal advice)

- `code.claude.com/docs/en/legal-and-compliance`: "Advertised usage limits for Pro and Max plans assume ordinary,
  individual usage of Claude Code **and the Agent SDK**". So the SDK on one's own subscription is contemplated for
  individual use.
- The same page: "Developers building products or services that interact with Claude's capabilities, including those using
  the Agent SDK, should use API key authentication … Anthropic does not permit third-party developers to offer Claude.ai
  login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their
  users". The SDK overview says the same ("Unless previously approved, Anthropic does not allow third party developers to
  offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK").
- Reading: one person running the dashboard locally on their own login is "ordinary, individual usage". The dashboard never
  offers a login and never holds or relays a credential. Each user's `claude` binary signs in itself. wt-pack is a public
  repository, though, and the docs steer **products** built on the SDK to API keys. The SDK path is closer to that line
  than the current `claude -p` path, which sits on the carve-out for "an end user signing in to the unmodified Claude Code
  binary". Whether wt-pack, as distributed, is a "product" is a call for the user, not for this spike.

## Dependency placement (proposal)

A separate worker module, `skills/wt-dashboard/headless-sdk/`, with its own `package.json` (the SDK pinned, plus its
peers). The server spawns one Node worker per supervisor and talks to it over JSON lines on stdin and stdout, the same
shape the supervisor already speaks to `claude -p`. `server.mjs` stays dependency-free. `./setup` runs
`npm ci --omit=optional` there (54 MB), and doctor reports whether it is installed. A feature flag
(`WT_HEADLESS_DRIVER=sdk|cli`, default `cli`) falls back to the existing supervisor until the SDK path is proven.

## Verdict

Technically **go**: the user's login works with no key, the dashboard makes no API call, the user's binary, settings and
plugins are kept, and the API surface covers WP-312/313/314. **Gate:** the user must confirm the terms reading above
(personal use on their own login; the public repo ships the SDK path as opt-in). If they would rather not take it, keep
the `claude -p` supervisor. The build waits for that answer.
