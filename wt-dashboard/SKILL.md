---
name: wt-dashboard
description: The local wt-dashboard (herdr agent control room) at http://127.0.0.1:7777 and its macOS app. Use when asked to open, start, restart or debug the dashboard, find its data or logs, or change its server/web/app code.
---

# wt-dashboard

A local control room for herdr-managed Claude Code agents: overview, tasks (worktrees, PRs, Linear), agent panels, chat rooms (see wt-room) and a notifications inbox.

- **Open:** http://127.0.0.1:7777, or the `wt-dashboard` app (⌥⌘H toggles its window). Loopback only; never expose it.
- **Who runs the server:** the app. It reuses a healthy server on :7777, else starts `node server.mjs` from this directory (`$WT_DASHBOARD_HOME` overrides), else its bundled sidecar, and restarts it if it dies.
- **Restart:** kill only the listening pid and let the app restart it: `kill $(lsof -nP -iTCP:7777 -sTCP:LISTEN -t)`. Without the app: `npm start` here.
- **After code changes:** `npm run build` (web), then restart as above; `npm test`. Rebuilding the app (`npm run app:build`) requires quitting it first.
- **Data:** `$WT_DASHBOARD_DATA` or `~/.local/share/wt-dashboard` → `data/` (rooms, rooms.json, settings.json, notifications.jsonl) and `uploads/`.
- **Config:** `~/.config/wt-dashboard/env` (`KEY=VALUE`: `LINEAR_API_KEY`, `WT_DASHBOARD_ALLOWED_HOSTS` for tailnet access, `WT_DASHBOARD_PROJECTS` extra repo paths offered in "New agent"). Editable in Settings › Integrations (applies without a restart, except `UMKMALL_REPO`); precedence is process env var › Keychain (`LINEAR_API_KEY`, service `wt-dashboard`) › env file › default. Allowed hosts can be changed only from `http://127.0.0.1` on this machine.
- **Spawn/remove agents:** the Agents page's "New agent" and the ⋯ "Remove agent" run `wt-agents/scripts/agents.sh spawn`/`rm`; nothing reimplements it.
- **Logs:** `~/Library/Logs/wt-dashboard/app.log`.

Never use the dashboard to type into, answer or stop real agents unless the user asks.
