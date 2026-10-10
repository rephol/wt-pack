# WP-308 — headless agents can put a file in front of the user

Ticket: a headless run (WP-293 `headless.mjs`) said it cannot attach files. Give it a way to show a file/image in the
Conversation view.

## What research found

- **`SendUserFile` does not exist in `claude -p`.** Probe (2026-10-11, throwaway haiku `-p` stream-json session in a temp
  dir, transcript deleted): `--tools Read,SendUserFile` → `init.tools` was `["Read"]`. So adding it to the `--tools` list
  is not a fix; the run needs its own tool.
- **The Conversation view already renders delivered files** — from the transcript, not from supervisor events.
  `skills/wt-dashboard/server.mjs:769`: `if (b.type === 'tool_use' && b.name === 'SendUserFile' && Array.isArray(b.input?.files))`
  → one attachment row per file (`{ id: 'f:<tool id>', role: 'assistant', files, caption }`), and `allowFile()` adds the
  realpath to `FILE_ALLOW`, the only files `/api/files` serves (`server.mjs:819-840`, sandbox CSP + nosniff). A headless
  row's stream is that same transcript: `headlessAgentRoute` → `streamTranscript(req, res, r.session, url)`
  (`server.mjs:2952`). So the whole UI side is "recognise one more tool name".
- **Read-only roles get no MCP today.** `headless.mjs:106`: reviewer/pr-watcher/auditor spawn with
  `--tools Read,Grep,Glob,LS,NotebookRead,AskUserQuestion --strict-mcp-config` (WP-300: "only read tools exist, so no
  allow-rule in the user's settings can open a write/exec/MCP tool"), and `#toolRequest` (`headless.mjs:171`) denies any
  non-`READ_ONLY` tool for them. Other roles load the plugin, so they get the `wt` MCP server
  (`.claude-plugin/plugin.json` `mcpServers.wt` → `skills/wt-shared/mcp/wt-server.mjs`), and every tool request becomes
  an open ask (`headless.mjs:175`).
- `wt-server.mjs` tools are registered with `tool(name, description, props, required, exec)` (`wt-server.mjs:97`),
  shell out to CLIs, and exposed by `tools()`. A `send_file` tool needs no CLI and no dashboard call: the transcript
  carries the paths.

## Design

One MCP tool, `send_file { files: string[1..5] (absolute paths), caption?: string ≤ 500 }`, in `wt-server.mjs`. Its exec
checks each path is absolute, exists and is a regular file ≤ 20 MB, and returns `{ shown: [<names>] }`; a bad path fails
`invalid_argument` and nothing is shown. Description: "Show files to the user in the dashboard's Conversation view. Use
when SendUserFile is not available (headless runs)."

- **Read-only roles:** keep `--strict-mcp-config` but add `--mcp-config '<json>'` with a single server `wt-files` running
  `node <wt-server.mjs>` with env `WT_MCP_ONLY=send_file`, which makes `tools()`/`call()` expose only that tool. So the
  run gains exactly one MCP tool (`mcp__wt-files__send_file`), never the ticket/room/handoff writers, whatever the
  user's allow rules say. `--tools` keeps built-ins only `[unsourced: --tools does not filter MCP tools; Unit 2's
  probe confirms]`.
- **Permission:** `#toolRequest` allows a send_file tool (name matches `SEND_FILE = /^mcp__.+__send_file$/`) for every
  policy without an ask: it only names files to the user and reads nothing into the model.
- **Rendering:** `server.mjs:769` accepts `b.name === 'SendUserFile' || SEND_FILE.test(b.name)`. The row shape is
  unchanged; skip the row when the paired `tool_result` is an error? No: the row is emitted at `tool_use` time and
  `allowFile` returns `null` size for a missing file, which the existing card already shows. Kept as is.
- **Herdr (TUI) agents** see `send_file` too through the plugin's `wt` server; harmless, and it renders the same.

Not in scope: the ticket's second note (a run claimed it "opened a page in the browser" without doing so). That is a
role-rule change in wt-memory (verify before claiming), owned by the orchestrator; this plan does not touch role rules.

Trust: `/api/files` serving any path an agent names is the existing `SendUserFile` exposure (`server.mjs:819`), unchanged
here; a read-only agent could `Read` the same file anyway.

## Units

1. **`send_file` tool** — `skills/wt-shared/mcp/wt-server.mjs`: register `send_file`; `WT_MCP_ONLY` (comma list)
   filters `T` in `tools()` and `call()` (unknown → `unknown_tool`). Tests in `wt-server.test.mjs`: valid file →
   `{ shown }`; relative / missing / directory path → `invalid_argument`; `WT_MCP_ONLY=send_file` lists exactly one
   tool and refuses `ticket_list`. Commit: wt-shared.
2. **Headless spawn + permission** — `skills/wt-dashboard/headless.mjs`: export `SEND_FILE`; read-only args add
   `--mcp-config` JSON (server path from `new URL('../wt-shared/mcp/wt-server.mjs', import.meta.url)`, `env:
   { WT_MCP_ONLY: 'send_file' }`); `#toolRequest` allows `SEND_FILE` names before the policy check. Tests in
   `headless.test.mjs` (fake `cmd`, as the existing ones): read-only args contain `--strict-mcp-config` and a
   `--mcp-config` naming only `wt-files`; a `can_use_tool` for `mcp__wt-files__send_file` gets `allow` for a reviewer
   and for an `ask`-policy role with no ask row; `mcp__wt-files__ticket_list` is still denied for a reviewer.
   Then one live check with a throwaway reviewer run in a temp dir (`agents.sh spawn --headless reviewer <tmp>
   --prompt "write nothing; call send_file with <tmp>/a.png"`): `init.tools` lists `mcp__wt-files__send_file` and
   no other `mcp__` tool; stop it by `agents.sh rm --headless <id>` and delete the temp dir and its transcript.
3. **Render** — `skills/wt-dashboard/server.mjs:769`: accept `SEND_FILE` names. Test in the existing transcript
   normalisation tests (`parse.test.mjs`): an `mcp__wt-files__send_file` tool_use yields the same `f:<id>` attachment
   row as `SendUserFile`, and `/api/files` then serves that path. Commit with unit 2 (one commit per skill: wt-dashboard).
4. **Docs** — `docs/features.md` headless section: "a headless run shows files with the `send_file` tool (wt MCP);
   read-only roles get only that MCP tool." Commit with unit 3.

## Definition of done

- `node --test skills/wt-shared/mcp/wt-server.test.mjs` and `cd skills/wt-dashboard && npm test` pass.
- The unit 2 live check shows the throwaway run's file as an attachment card in its Conversation view (agent-browser,
  `--session <agent name>`, screenshot), then the run and temp dir are gone.

QA brief: Agents → the headless reviewer row → Conversation view; done when an attachment card for `a.png` shows with
its preview and opens/downloads; check at 412x700 and iPhone 13.

No e2e writing or running.
