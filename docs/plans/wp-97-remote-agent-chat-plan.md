# WP-97 — Agent chat for remote machines (code-reviewer)

Branch `wp-97-remote-agent-chat`, base `origin/main`.

## Goal

The agent chat page shows the real Claude transcript for agents on a remote herdr machine (today
`code-reviewer`, SSH host `herdr-box`), not only the pane-read timeline. The server fetches the remote jsonl
over SSH, incrementally and read-only, and streams it through the same SSE endpoint and parser that local
agents use. When a transcript cannot be found or reached, the page says so and keeps showing the pane view.

## What research corrected

- **The transcript cannot be found from `cwd + session id`, because herdr gives remote agents no session id.**
  A live `herdr --machine code-reviewer agent list` returns
  `{'pane_id': 'w5:p8', 'cwd': '/work/projects/umkmall', 'agent_session': None}`. The server also nulls the
  session for any non-local agent: `server.mjs:428`
  `const session = m.local && a.agent_session?.kind === 'id' ? a.agent_session.value : null`. Both remote panes
  share `/work/projects/umkmall`, and its project dir `~/.claude/projects/-work-projects-umkmall` holds 49
  entries. → The transcript has to be **matched** to the pane (see Approach). A session id is used directly
  if herdr ever reports one.
- **Line ~1566 is not the chat gate.** `server.mjs:1566` `if (!a?.local) return BUILTINS // remote: no filesystem access`
  only limits slash-command autocomplete. The chat is blocked in two places:
  - the stream route, `server.mjs:2316` `if (!m.local) return send(res, 404, { error: 'no transcript for remote agents; use the pane read' })`;
  - the client, `App.tsx:1299` `const live = agent.local && Boolean(agent.session)`.
- **Local lookup does not encode cwd.** It scans every project dir for `<session>.jsonl`
  (`server.mjs:517-526`, `for (const d of await readdir(PROJECTS)) { const f = join(PROJECTS, d, \`${id}.jsonl\`) …`).
  On the remote side, the project dir name is the cwd with `/` replaced by `-` (`-work-projects-umkmall` for
  `/work/projects/umkmall`), which is how the dir is picked there.
- **There is no saved SSH target in wt-dashboard config.** Machines come from `herdr machine list`, and the
  SSH target is its `host` field (`server.mjs:218-224`
  `.map(([id, label, host, session, state]) => ({ id, label, host, … }))`). `code-reviewer` maps to host
  `herdr-box` and is enabled. server.mjs contains no ssh call today.
- **The remote HOME is not the local one.** On herdr-box `HOME=/work`. → The remote command uses `$HOME`, never
  a local path.
- **`streamTranscript` already takes a file override** (`server.mjs:655`
  `streamTranscript(req, res, session, url, fileOverride)`) and emits byte-offset SSE ids
  (`id: ${off}`, resumed with `?since=` / `Last-Event-ID`). The web `streamStore` already resumes from that
  cursor (`App.tsx:1156`). → The remote version keeps the same protocol, so the client changes only its
  `live` condition.

## Review corrections (binding — these win over Approach and the units where they conflict)

1. **Tail-first load, not paging from 0.** Real transcripts on herdr-box are 40–47 MB (live probe:
   `46627945 37b2a164-….jsonl`). The first load reads from `start = max(0, size - 4 MB)`, drops everything
   before the first `\n`, and emits absolute byte-offset ids. A `since` below `start` returns the tail again.
   Accepted cost: a question whose answer lies before the window won't fold. The live probe also printed
   `GNU findutils 4.9.0`, so `find -printf` is confirmed.
2. **Byte-safe chunking.** Keep the leftover as a `Buffer`, concatenate the raw bytes, cut at the last `0x0a`
   before decoding, and compute the offset as `from + cut + 1` from the byte math. Never compute it from a
   re-encoded string. The local code decodes `partial + buf.toString('utf8')` (`server.mjs:720`); do not copy
   that for remote. Add a U2 test where a page boundary splits `é` and an emoji.
3. **The client must listen for `event: remote`.** `streamStore` has only `open` (`streamStore.ts:55`) plus
   `onmessage` (`App.tsx:1154`), and named events never reach `onmessage`. `agentStreamSpec.attach` adds
   `es.addEventListener('remote', …)` and feeds a React state. The pane fallback stays until **at least one
   message** arrives, not until `synced`, because `open` sets `synced`.
4. **The persist tag for remote is the matched file id.** The server sends it in the existing
   `event: session` (`server.mjs:689`). `agentStreamSpec` uses it instead of `session`, which is null for
   remote. On a re-match to another file, the server ignores `since`.
5. **Match on parsed user text, not the raw tail.** The pane's `lastPrompt` (`server.mjs:167`
   `lastUser?.text.split('\n')[0]`) is wrapped and ANSI-stripped. Parse the tail's lines (dropping the first,
   partial line), take the string content of `type:"user"` entries, normalise whitespace on both sides, and
   compare the first 40 characters.
6. **`projectDir` uses Claude's encoding:** `cwd.replace(/[^A-Za-z0-9]/g, '-')`, validated
   `/^-[A-Za-z0-9-]+$/` on the **final** string. The cwd is remote-controlled, so the snapshot test names
   hostile inputs: `'/x"; rm -rf ~; "'`, `'/x$(id)'`, `'/x\nid'` → output only `[A-Za-z0-9-]`.
7. **Abort on disconnect.** Each stream gets an `AbortController`, passes `signal` to `execFile` (which kills
   ssh), and aborts in `req.on('close')` (next to the existing cleanup at `server.mjs:729`). Retry and page
   loops check `signal.aborted`, and the per-host count of 4 is released in `finally`.
8. **Minor fixes.** The candidate window is `-mmin -10080` (7 days), so a pane idle for a day still matches.
   The route finds the agent with `x.machine === m.label && x.id === pane`, because pane ids are unique only
   per machine.

## Approach

**`remoteTranscript.mjs` (new, pure plus injected `ssh`), so it is unit-testable without a network.**
- `ssh(host, script)` → stdout. This is `execFile('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '--', host, script], { timeout: 10_000 })`,
  refused unless `host` matches `/^[A-Za-z0-9._@-]+$/` and does not start with `-`. `host` comes only from
  `herdr machine list` via `machineBy` (`server.mjs:227`, "user input never becomes an argv flag"). It never
  comes from the request.
- `projectDir(cwd)`: `cwd.replace(/\//g, '-')`, then validated with `/^-[A-Za-z0-9._-]+$/` and `!includes('..')`.
  Anything else returns null, which means unavailable.
- Session ids are validated with the UUID regex `/^[0-9a-f-]{36}$/` before being put in a path.
- Every path is built as `"$HOME/.claude/projects/<dir>/<id>.jsonl"`, with the validated parts inside double
  quotes, so `$HOME` expands but nothing else can. No user text ever reaches the script.
- **Candidates** (one call): `cd "$HOME/.claude/projects/<dir>" 2>/dev/null && find . -maxdepth 1 -name '*.jsonl' -mmin -1440 -printf '%T@ %s %f\n'`.
  This lists files changed in the last 24 h with their mtime, size and name. GNU find 4.9.0 is confirmed on the box (review probe).
- **Match to pane.** Take the pane's last user prompt from the pane read the server already does
  (`server.mjs:350` `herdrOn(m, 'agent', 'read', pane, '--lines', …)`, parsed into turns). Pick the
  candidate whose last 64 KB (`tail -c 65536`) contains that prompt text, using the first 80 characters,
  whitespace-normalised. If exactly one candidate matches, that is the pane's transcript. If none or several
  match, fall back to the newest candidate only when it is the only candidate; otherwise report
  `unmatched`. Cache `pane → {host, path}` for the process lifetime, and redo the match when the chosen
  file has not grown for 10 minutes while the pane is `working`, which covers `/clear` or a restart.
- **Read** is `tail -c +<offset+1> "<path>" | head -c 4194304`, so each pull is at most 4 MB. The full
  first load uses offset 0, in pages of up to 4 MB, until the size from the candidate listing is reached.
- **Rate limit.** Per pane: one in-flight SSH call at a time, and a pull at most every 3 s while a client is
  connected. The same pattern already exists at `server.mjs:481`
  `if (r.inflight || Date.now() - r.lastTry < 10_000) return`. Per host: at most 4 concurrent SSH processes.
  There is no polling without an open stream.

**Server route.** The stream route drops the `!m.local` 404 for remote agents and calls
`streamRemote(req, res, m, agent, url)`. That function reuses `streamTranscript`'s framing by factoring out
two pieces: its emit/parse core (`parseLines`, `foldQuestions`, `normalizeEntry`, with ids as byte offsets)
and a `source` interface `{ size(), read(from, to) }`. The local source is the existing `stat`/`readFile`.
The remote source is the SSH reads above. The watch and 1 s interval become the 3 s pull for remote. When a
remote transcript is unavailable, it sends the SSE comment event `event: remote\ndata: {"state":"unmatched"|"unreachable"|"loading"}`
and keeps the connection open with retries: 30 s for unreachable, 60 s for unmatched.
settled: factor `streamTranscript` into core + source, rather than copying it. A copy would fork the
byte-offset and resume logic that `parse.test.mjs:567` pins.

**Agents list.** For remote agents, `session` stays null, and the dashboard marks `transcript: 'remote'` so
the client knows to try.

**Client (`App.tsx`).** Change `live` to `(agent.local && Boolean(agent.session)) || !agent.local`. For
remote agents, the pane query stays enabled as a fallback until the stream is `synced` with at least one
message. The badge at `App.tsx:1419` shows:
- `remote · loading transcript…` while connecting;
- `remote · transcript` once synced;
- `remote · transcript not matched — pane view` or `remote · unreachable — pane view`, taken from the `remote`
  SSE event.

Sending messages is unchanged, because it already goes through herdr.

**Out of scope:** slash-command autocomplete for remote agents (`server.mjs:1566`), removing remote agents,
and file attachments.

## Implementation units

**U1 — `remoteTranscript.mjs` + tests (M).** `ssh` guard, `projectDir`, UUID check, script builders,
candidate parsing, `matchCandidate(candidates, tails, prompt)`, and the rate limiter.
Files: `skills/wt-dashboard/remoteTranscript.mjs` (new), `skills/wt-dashboard/remoteTranscript.test.mjs` (new),
`skills/wt-dashboard/package.json` (add the test to `"test"`).
Verify: `npm test`, with cases for:
- a host starting with `-` → refused; a cwd containing `..` → null; a non-UUID id → refused;
- the built script contains no unquoted interpolation (snapshot);
- match: one hit → path; two hits → `unmatched`; zero hits with a single candidate → that one;
- the limiter allows one in-flight call per pane.

Also run one live read-only probe, `ssh -o BatchMode=yes herdr-box '<candidates script>'`, and paste its
output. That confirms the `find -printf` format on the box.

**U2 — stream refactor + remote route (M).** Split `streamTranscript` into core + source, add `streamRemote`,
change the route, and add the `remote` event.
Files: `skills/wt-dashboard/server.mjs`, `skills/wt-dashboard/parse.test.mjs`.
Verify: the existing `parse.test.mjs:567` streamTranscript test still passes unchanged. A new test drives
`streamRemote` with a fake source and fake ssh and checks: ids are byte offsets, `?since=` resumes, an
unmatched state emits `event: remote` with `unmatched`, and an ssh timeout emits `unreachable`.

**U3 — client states + docs (S).** The `live` condition, the pane fallback until synced, the badge states,
and a `docs/features.md` line in the agent chat section.
Files: `skills/wt-dashboard/web/src/App.tsx`, `docs/features.md`.
Verify: `cd skills/wt-dashboard/web && npx tsc --noEmit -p . && npm run build`, and `npm test` in
`skills/wt-dashboard`. After one service restart, use agent-browser (`--session <agent name>`, with
`caffeinate -u -t 60 &` first) on a code-reviewer agent at 1440 and at 390. Take screenshots showing
transcript messages, or showing the `not matched` badge with pane-view content if matching fails. Never send
a message to the user's real umkmall agents on that box: read-only viewing only.

Order: U1 → U2 → U3.

## Files

- `skills/wt-dashboard/remoteTranscript.mjs` (new), `skills/wt-dashboard/remoteTranscript.test.mjs` (new), `skills/wt-dashboard/package.json`
- `skills/wt-dashboard/server.mjs`, `skills/wt-dashboard/parse.test.mjs`
- `skills/wt-dashboard/web/src/App.tsx`
- `docs/features.md`

## Definition of Done

Each item is shown by output in the transcript:
- `npm test` in `skills/wt-dashboard` passes, including the named U1 and U2 cases, and the existing
  `streamTranscript` test is unchanged.
- `npx tsc --noEmit -p .` and `npm run build` in `web` pass.
- The live SSH probe output from U1 is pasted.
- Screenshots at 1440 and 390 of a code-reviewer agent's chat show either transcript messages or the
  explicit `not matched`/`unreachable` badge, and never a blank page.
- `grep -n "remote" docs/features.md` shows the new line.

## Risks and deferred

- **Matching is heuristic.** Two panes typing the same prompt, or a pane with no visible user prompt, gives
  `unmatched`, which falls back to the pane view instead of showing the wrong transcript. This could be
  fixed properly by getting herdr on the box to report `agent_session`, which is outside this repo.
  Deferred.
- **SSH load.** This is one ssh process every 3 s per open remote chat, capped at 4 per host. ControlMaster
  multiplexing is deferred.
- **Slash-command autocomplete and attachments for remote agents** stay unsupported.
