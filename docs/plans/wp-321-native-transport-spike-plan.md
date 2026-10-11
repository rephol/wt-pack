# WP-321 — Spike: native ListAgents/SendMessage as a wt-pack transport

**Type:** spike, research only. No product code. Deliverable: `docs/plans/wp-321-native-transport-spike.md`, a note
with GO / NO-GO / PARTIAL and a migration sketch. This file is the plan the spike runs from.

## What is already known (planner observation, 2026-10-11, `ListAgents` from wt-pack-planner-01)
- Output per peer: `name [6-hex short id] · kind · state · started <age>`. Kinds seen: `interactive`, `Remote Control`.
  States seen: `idle`, `busy`, `shell`, `offline`. 150 peers, ~130 of them `Remote Control · offline`; listing is
  truncated ("… 30 more not shown").
- **No cwd, project, full session id, or pane id.** Nothing like herdr tokens (role, pair, dnd, task).
- **Names are not unique:** `wt-pack-worker-04` appears 4 times (1 interactive `shell`, 3 Remote Control offline);
  `umkmal-design-system-engineer-01` many times. The `[short id]` is what disambiguates.
- `wt-pack-worker-04` shows `shell` while herdr reports it `done` — the ticket's disagreement, reproduced.
- Cross-project: peers from umkmall, hackdog, self-porto, pag are all listed to a wt-pack planner. No project scope.
- No `hl-…` headless run appears in the listing, but none was known to be live at the time `[unsourced]`; E3 tests it.

`[unsourced]` until the spike tests them: everything about SendMessage delivery below.

## Rules for the spike
- **Throwaway only.** Create agents with names prefixed `spike321-` in a temp repo (`mktemp -d` + `git init`).
  Never `SendMessage` any listed peer that is not yours (CLAUDE.md "Never prompt the user's real agents").
- Strip `HERDR_*` from any child `claude` env (CLAUDE.md WP-320 trap) unless the experiment is about herdr panes.
- Clean up: `agents.sh rm`, kill recorded pids only, `rm -rf` the temp repo.
- No e2e writing or running.

## Experiments (each records: command, what the receiver saw verbatim, timing)
- **E1 Reach.** From a sender session, SendMessage to: (a) an interactive herdr pane `spike321-a` idle, (b) the same
  while busy (give it a 60 s task), (c) a headless dashboard run (`POST /api/headless`, on a throwaway server as
  WP-309's worker did), (d) a plain `claude -p --input-format stream-json` process, (e) a Remote Control session you
  start yourself. Per target: delivered? woke idle? queued while busy, or interrupted? arrives as a user turn or a
  separate peer-message block?
- **E2 Semantics.** Send 3 numbered messages fast → order kept? Send 10 KB, 100 KB → limit/error text. Does the sender
  get an ack or only "sent"? What identity does the receiver see (name? short id?) and can the receiver reply by it?
  Send a full `<wt-message id=… kind=handoff from=…>` envelope: does the wt-pack UserPromptSubmit hook still fire and
  classify it (the hook keys on the tag), and does the receiver's system prompt mark peer text as untrusted?
- **E3 Discovery.** Compare `ListAgents` with `wt-agents list --json` for the throwaway agents: name, state mapping
  (herdr idle/working/blocked/done ↔ idle/busy/shell/offline), restart = new short id? Is a headless run listed?
  Any filter (the tool takes none visible besides unused `q`/`channel`): can offline Remote Control noise be hidden?
- **E4 Scope/security.** Can a session in temp repo A message one in temp repo B (expected yes, per observation)?
  Any per-project or allow-list setting? Record whether a peer message could carry instructions the receiver obeys.
- **E5 Headless/SDK.** Is `SendMessage`/`ListAgents` in a `claude -p` run's init `tools`? Can such a run send and
  receive? Could the dashboard (no Claude API, user rule) send without being a Claude session — i.e. is there any
  CLI/file/HTTP entry point, or only the tool inside a session?

## Decision rule for the note
- GO only if E1(a,b) deliver reliably with wake + queue, E2 envelope keeps hook classification, and an agent can be
  addressed uniquely. NO-GO if the dashboard cannot send (E5) — then it can at most replace agent→agent replies,
  and herdr stays for dispatch.
- Expected from what is known: **PARTIAL** — agent↔agent replies (`handoff.sh --reply`) could move; dispatch,
  room delivery and token-based availability (pair/dnd/task) stay on herdr because ListAgents carries no tokens or cwd.

## Migration sketch (fill from results)
For `skills/wt-handoff/scripts/handoff.sh`, `skills/wt-room/mod/scripts/wt-deliver`, `skills/wt-agents/scripts/agents.sh`:
what each keeps, what moves to SendMessage, and the name→short-id resolution needed given duplicate names.

## Definition of done
`docs/plans/wp-321-native-transport-spike.md` committed on this branch with: a verdict line, E1–E5 each answered
with the verbatim evidence or "not testable: <why>", the migration sketch, and a cleanup line (agents removed, temp
repos deleted). Follow-up tickets filed with `wt-ticket new` for any GO piece.

## QA brief
No UI. QA reads the note: every question (1)–(5) of the ticket has an answer with evidence, the verdict matches the
decision rule, and `ListAgents` shows no `spike321-` interactive peers left behind.
