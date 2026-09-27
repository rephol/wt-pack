# wt-pack

A pack of Claude Code skills for running herdr agents on a ticket pipeline, plus the wt-dashboard control
room. Each `skills/<name>` dir is one skill, linked as `~/.claude/skills/<name>` by `./setup` (install, doctor,
secrets, uninstall). Scripts refer to each other sibling-relatively (`../wt-shared/…`), so skills move together.
Branch `main`, remote `origin` = github.com/rephol/wt-pack; commits are authored as rephol via
repo-local git config — **push after committing** (`git push`).
User-facing feature reference: `docs/features.md` — a user-visible change updates it in the same merge.
Role rules (orchestrator, planner, worker, auditor, reviewer) live in wt-memory, not here.

## Layout
- `skills/wt-*` — the skills; `.claude-plugin/marketplace.json` — local marketplace `wt-pack` (serves
  `skills/wt-memory/claude-plugin`; also setup's marker for a wt-pack checkout); `setup` — installer;
  `docs/` — features, handoff, `plans/` (point-in-time, not rewritten).

## Build and test
- wt-dashboard (`skills/wt-dashboard`): `npm test` (server + web unit tests).
- Web (`skills/wt-dashboard/web`): `npx tsc --noEmit -p .`; web-only change: `npm run build` (no restart).
- wt-memory: `node --test skills/wt-memory/scripts/*.test.mjs`; wt-agents: `node --test skills/wt-agents/scripts/mcp.test.mjs`.
- Pack health: `./setup doctor`.

## Conventions
- **No draft PRs:** after code review (wt-review / wt-ship), merge to main directly, then push.
- **Browser checks:** use the `agent-browser` skill first; other browser tooling only when it is not installed.
  Always `--session <your agent name>`. Screenshots hang while the Mac's display sleeps (WP-1): run
  `caffeinate -u -t 60 &` first. If `agent-browser screenshot` still hangs, fall back to
  `node skills/wt-shared/scripts/screenshot.mjs --session <name> [--size 390x844] [--url <url>] <out.png>` (CDP).
- **One commit per skill touched.** Commit only your own paths (`git commit <paths>`), never `-a`.
- Commits use the rephol noreply identity (repo-local git config); `./setup doctor` flags any other.
- Keep every CLI backward compatible. Extending skills for dashboard needs is allowed.

## Skill map
| Skill | What / where to look |
|---|---|
| wt-agents | herdr pools, `spawn <role>`, `list --json`, pane tokens |
| wt-handoff | `--task`, sender/target tokens, reply footer (`skills/wt-plan/scripts/handoff.sh` is a shim) |
| wt-plan · wt-work · wt-review · wt-pr · wt-ship · wt-simplify · wt-compound · wt-research | ticket pipeline |
| wt-finish | retire worktree; clears `task` token |
| wt-babysit | watch PR to merge-ready |
| wt-watch-prs | reviewer loop over a repo's open PRs (`dispatch \| review <pr> \| [repo]`); state `~/.local/share/wt-watch-prs/` → Inbox `pr-held` |
| wt-audit | auditor role loop (PM + QA findings) |
| wt-ticket | local kanban board CLI (`WP-N`): new/list/show/move/comment/claim/assign/keys |
| wt-room | rooms CLI: list/read/post/--attach/create |
| wt-memory | store `~/.config/wt-memory`; Claude plugin via local marketplace `wt-pack` |
| wt-shared | shared helpers |
| wt-setup | runs `./setup` at repo root |
| wt-dashboard | see below |

## wt-dashboard
- `server.mjs` + `rooms.mjs` (Node, no deps); web: React 19 + Vite + TanStack Query + Astryx UI in `web/src`;
  Tauri 2 app in `app/`.
- Server is launchd `id.local.wtdashboard.server` (`npm run service:restart|status`). **Don't restart repeatedly.**
- Data `~/.local/share/wt-dashboard/` (tickets/rooms/inbox in `data/wt.db`, `node:sqlite`, node ≥ 22.13; rollback: README), config `~/.config/wt-dashboard/env`, logs `~/Library/Logs/wt-dashboard/`.
- No Claude API in the dashboard (user rule). Keep security: session cookie, Host/Origin allowlist,
  loopback-only terminals, SSRF guard on `/api/unfurl`.

## Traps
- `HERDR_PANE_ID` may be the stable id — resolve via `herdr pane get` (`canonicalPane()`).
- Pane tokens: ≤32 keys, values ≤80 chars; `task`/`handoff_*` never mirrored to `agent-tags.json`;
  unknown roles dropped.
- WKWebView `window.confirm` is always false — native dialogs banned (`noNativeDialogs.test.ts`).
- Room turns: agents answering in a room end their session turn with at most one line: `→ answered in #<slug>`.
- Never prompt the user's real agents (other projects' panes) for tests; use throwaway agents/temp repos and clean up.
- herdr names: lowercase, digits, `-`, `_`, ≤32 (`wt-agents spawn` breaks on capitalised repo dirs — open).
- macOS is case-insensitive: `Dock.tsx` beside `dock.ts` makes `./Dock` resolve to `dock.ts` (tsc: implicit any) — give sibling modules distinct names (WP-112).
- BSD pkill/pgrep: options after the pattern become patterns; `-f … -n` SIGTERMs every `claude --name` agent (WP-109). Kill by recorded pid (the wt-memory plugin hook denies misordered calls). Plugin hooks load at session start: a guard shipped in git protects nothing until the plugin cache has it AND the session restarted (WP-120). Second layer: `wt-agents/bin` pkill/pgrep/killall PATH shims set at spawn (also block short `-f` patterns — the WP-120 kill hit Chrome tabs too).
