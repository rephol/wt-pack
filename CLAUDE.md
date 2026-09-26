# wt-pack — orchestrator router

Skills pack: each top-level dir is a skill symlinked as `~/.claude/skills/<name>`. Branch `main`,
remote `origin` = github.com/rephol/wt-pack (private); commits are authored as rephol via repo-local
git config — **push after committing** (`git push`). Full context: `docs/handoff-2026-09-26.md`.
User-facing feature reference: `docs/features.md` — a user-visible change updates it in the same merge.

## Working here
- Role: orchestrator — **never implement yourself.** Spawn planners (`wt-agents spawn planner`) for work needing a plan, workers for clear tasks; hand off with wt-handoff.
  Verify, commit, report concisely.
- **Schedule only Ready tickets** on the local board (`wt-ticket list --column ready`); `claim` one before planning it.
  A board with **Dispatch** on (WP-52, off by default) schedules its own Ready cards: skip cards with a dispatch badge
  (`dispatch` field) and handle only the exceptions (held, stalled, blocked). Reconcile may return a card to Ready when its agent is gone.
- **No draft PRs:** after code review (wt-review / wt-ship), merge to main directly, then push.
- **Browser checks:** use the `agent-browser` skill first; other browser tooling only when it is not installed.
  Always `--session <your agent name>`. Screenshots hang while the Mac's display sleeps (WP-1): run
  `caffeinate -u -t 60 &` first. If `agent-browser screenshot` still hangs, fall back to
  `node wt-shared/scripts/screenshot.mjs --session <name> [--size 390x844] [--url <url>] <out.png>` (CDP).
- **One commit per skill touched.** Commit only your own paths (`git commit <paths>`), never `-a`.
- Keep every CLI backward compatible. Extending skills for dashboard needs is allowed.
- The umkmall orchestrator (previous owner) is reachable via `herdr agent prompt wP:p1 "..."`.

## Skill map
| Skill | What / where to look |
|---|---|
| wt-agents | herdr pools, `spawn <role>`, `list --json`, pane tokens |
| wt-handoff | `--task`, sender/target tokens, reply footer (wt-plan/scripts/handoff.sh is a shim) |
| wt-plan · wt-work · wt-review · wt-pr · wt-ship · wt-simplify · wt-compound · wt-research | ticket pipeline |
| wt-finish | retire worktree; clears `task` token |
| wt-babysit | watch PR to merge-ready |
| wt-ticket | local kanban board CLI (`WP-N`): new/list/show/move/comment/claim/assign/keys |
| wt-room | rooms CLI: list/read/post/--attach/create |
| wt-memory | store `~/.config/wt-memory`; Claude plugin via local marketplace `wt-pack` |
| wt-shared | shared helpers |
| wt-setup | `./setup` (install, doctor, secrets, uninstall) at repo root; the skill only runs it |
| wt-dashboard | see below |

## wt-dashboard
- `server.mjs` + `rooms.mjs` (Node, no deps); web: React 19 + Vite + TanStack Query + Astryx UI in `web/src`;
  Tauri 2 app in `app/`.
- Web-only change: `cd web && npm run build` (no restart). Checks: `cd web && npx tsc --noEmit -p .`; `npm test`.
- Server is launchd `id.local.wtdashboard.server` (`npm run service:restart|status`). **Don't restart repeatedly.**
- Data `~/.local/share/wt-dashboard/` (tickets/rooms/inbox in `data/wt.db`, `node:sqlite`, node ≥ 22.13; rollback: README), config `~/.config/wt-dashboard/env`, logs `~/Library/Logs/wt-dashboard/`.
- No Claude API in the dashboard (user rule). Keep security: session cookie, Host/Origin allowlist,
  loopback-only terminals, SSRF guard on `/api/unfurl`.

## Traps
- `HERDR_PANE_ID` may be the stable id — resolve via `herdr pane get` (`canonicalPane()`).
- Pane tokens: ≤32 keys, values ≤80 chars; `task`/`handoff_*` never mirrored to `agent-tags.json`;
  unknown roles dropped.
- WKWebView `window.confirm` is always false — native dialogs banned (`noNativeDialogs.test.ts`).
- Room turns: agents answering in a room end their session turn with NO text.
- Never prompt the user's real umkmall-* agents for tests; use throwaway agents/temp repos and clean up.
- herdr names: lowercase, digits, `-`, `_`, ≤32 (`wt-agents spawn` breaks on capitalised repo dirs — open).
