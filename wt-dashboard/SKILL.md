---
name: wt-dashboard
description: The local wt-dashboard (herdr agent control room) at http://127.0.0.1:7777 and its macOS app. Use when asked to open, start, restart or debug the dashboard, find its data or logs, or change its server/web/app code.
---

# wt-dashboard

A local control room for herdr-managed Claude Code agents: overview, tasks (worktrees, PRs, Linear), agent panels, chat rooms (see wt-room) and a notifications inbox.

- **Open:** http://127.0.0.1:7777, or the `wt-dashboard` app (⌥⌘H toggles its window). Loopback only; never expose it.
- **Who runs the server:** a launchd LaunchAgent (`id.local.wtdashboard.server`, installed by `npm run service:install`): it starts at login, restarts after a crash (at most every 10s) and keeps running when the app quits. The app only connects, and kickstarts the service if it is down. Without the service the app falls back to spawning `node server.mjs` from this directory (`$WT_DASHBOARD_HOME` overrides) or its bundled sidecar, restarts it at most 3 times in 5 minutes, and stops it on quit.
- **Restart:** `npm run service:restart` (= `launchctl kickstart -k gui/$UID/id.local.wtdashboard.server`), or Restart server in the tray / Settings › Server. `npm run service:status` shows state, pid and last exit; `service:uninstall` removes it. Without the service: kill only the listening pid and let the app restart it, or `npm start` here.
- **Logs:** server stdout/stderr (and crash stacks) → `~/Library/Logs/wt-dashboard/server.log` (not rotated; truncate by hand); the app → `~/Library/Logs/wt-dashboard/app.log`.
- **After code changes:** `npm run build` (web) — the server reads web/dist from disk, so a web-only change needs a reload, never a restart; a server change needs ONE restart as above; `npm test`. Rebuilding the app (`npm run app:build`) requires quitting it first.
- **Data:** `$WT_DASHBOARD_DATA` or `~/.local/share/wt-dashboard` → `data/` (rooms, rooms.json, settings.json, notifications.jsonl) and `uploads/`.
- **Config:** `~/.config/wt-dashboard/env` (`KEY=VALUE`: `LINEAR_API_KEY`, `WT_DASHBOARD_ALLOWED_HOSTS` for tailnet access, `WT_DASHBOARD_PROJECTS` extra repo paths offered in "New agent"). Editable in Settings › Integrations (applies without a restart, except `UMKMALL_REPO`); precedence is process env var › Keychain (`LINEAR_API_KEY`, service `wt-dashboard`) › env file › default. Allowed hosts can be changed only from `http://127.0.0.1` on this machine.
- **Memory:** Settings › Memory edits the wt-memory preference files (global / per role / per project; `/api/memory`, session cookie required for read and write) and previews what an agent receives. See wt-memory.
- **Spawn/remove agents:** the Agents page's "New agent" and the ⋯ "Remove agent" run `wt-agents/scripts/agents.sh spawn`/`rm`; nothing reimplements it.
- **Logs:** `~/Library/Logs/wt-dashboard/app.log`.

Never use the dashboard to type into, answer or stop real agents unless the user asks.

## Terminals

Shells that herdr owns: each is a pane with no agent in a `<project>-shells` workspace. The dashboard mirrors the screen (`pane read --format ansi`, streamed at ~300ms only while someone watches) and types into it (`send-text`, plus whitelisted `send-keys`: Enter, Tab, Esc, arrows, Backspace, Ctrl+C/D/Z/L, PageUp/PageDown, Home/End). A shell may start only in a project, one of its worktrees, `$HOME` or `/private/tmp`, and agent panes are refused. **Off by default:** Settings › Terminals turns it on, and separately allows the tailnet, both changeable only from `http://127.0.0.1` on this machine; every endpoint needs the page's session cookie. Creation, input, keys, close and settings changes are appended to `~/.local/share/wt-dashboard/data/terminal-audit.jsonl` (viewable in Settings). The command bar's Enter always runs the line, on a phone too.
