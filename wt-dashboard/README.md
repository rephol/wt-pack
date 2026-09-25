# wt-dashboard

Local dashboard over herdr panes (planners, workers, orchestrator), the umkmall git worktrees, their PRs and Linear tickets.

```sh
npm --prefix web install      # once
npm run dev                   # API on 127.0.0.1:7777 + Vite on 127.0.0.1:5173 (proxies /api)
npm run build && npm start    # or: serve the built UI from node server.mjs on :7777
npm test                      # pane-parser self-check
```

- `LINEAR_API_KEY=lin_api_… npm run dev` shows Linear tickets (read-only GraphQL). Without it the board uses worktrees, PRs and agents only.
- `UMKMALL_REPO` overrides the checkout path (default `~/Work/projects/umkmall`). Needs `herdr`, `git` and an authenticated `gh` on PATH.
- Refresh: agents/overview cached 3s, worktrees 10s, PRs 30s (GitHub rate limit), Linear 60s.

**Security:** the server binds to 127.0.0.1 only and rejects non-local `Host`/`Origin` headers and non-JSON POSTs. It can type into agents that run with bypassed permissions — never expose or proxy it beyond your machine.

## Desktop app (macOS, Tauri 2)

```sh
npm run app:build     # web build → Node SEA sidecar → tauri build
open app/src-tauri/target/release/bundle/macos/wt-dashboard.app
```

- Needs Rust (`~/.cargo/env`) and Xcode command-line tools. The app is unsigned: first launch via Finder right-click → Open (Gatekeeper).
- On start it reuses a server already answering `127.0.0.1:7777/api/health`, else it runs the live `server.mjs` from `$WT_DASHBOARD_HOME` or `~/.claude/skills/wt-dashboard` (symlink resolved), else the bundled `wt-dashboard-server` sidecar (server.mjs as a Node single executable). It restarts a crashed server and stops it on quit.
- GUI apps get a minimal PATH, so the sidecar's PATH comes from `zsh -lc 'echo $PATH'` plus nvm, Homebrew, `~/.cargo/bin` and `~/.local/bin`.
- Env for the server (e.g. Linear, tailnet hosts): `~/.config/wt-dashboard/env` with `KEY=VALUE` lines, e.g. `LINEAR_API_KEY=lin_api_…`, `WT_DASHBOARD_ALLOWED_HOSTS=…`. The old `~/.config/herdr-dash/env` is read as a fallback (logged).
- Logs: `~/Library/Logs/wt-dashboard/app.log`.

## Data

Nothing is written into this source tree. The data root is `$WT_DASHBOARD_DATA`, default `~/.local/share/wt-dashboard`:
`data/` (rooms/*.jsonl, rooms.json, settings.json, notifications.jsonl) and `uploads/` (images pasted into the composer).
Env names are `WT_DASHBOARD_*`; the old `HERDR_DASH_*` names still work as a fallback.
