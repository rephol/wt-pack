# WP-166: Mac app, one window per project

Base: `origin/main` @ c0587ad. Branch `wp-166-window-per-project`. Code is in `skills/wt-dashboard/app/src-tauri/src/main.rs`
(Rust) and `skills/wt-dashboard/web/src/{App,desktop}.tsx`.

## What research found (evidence)
- **Every native path assumes the single label `"main"`.** These are:
  - `show()` uses `app.get_webview_window("main")` (`main.rs:518`)
  - the tray agent item: `show(app); app.emit_to("main", "open-agent", &id[6..])` (`main.rs:536-537`)
  - server-control results: `emit_to("main", "server-control-result", …)` (`:426`)
  - the update badge: `get_webview_window("main")…set_badge_label` (`:622`)
  - the error-page recovery: `get_webview_window("main")` then `navigate(URL)` (`:353-356`)
  - the global shortcut toggle (`:559`)
  - window creation: `WebviewWindowBuilder::new(&handle, "main", url)` (`:679`)
  - Dock reopen: `RunEvent::Reopen { .. } => show(handle)` (`:694`)
- **Every window would relay the tray and notifications.** `useDesktop` (`web/src/desktop.tsx:28-40`) opens its
  own `EventSource('/api/events')` and emits `tray` and `notify` to Rust. With N windows, that is N native
  notifications per event and N tray rebuilds (the WP-146 dedupe in Rust absorbs the tray, but not
  notifications). **This is the bug the ticket did not name.** Only one window may relay.
- **The project selection already comes from the URL first.** `initialProject` reads
  `new URLSearchParams(location.search).get('project')` (`App.tsx:240`) and falls back to
  `localStorage.getItem('project')` (`:242`). `setProject` writes both the URL (`:347-348`) and `localStorage`
  (`:350`), so switching in a secondary window would overwrite the saved default. That contradicts the ticket.
- `tauri_plugin_window_state` is already registered (`main.rs` Builder), so per-label size and position are restored.
  It restores geometry only and does not reopen windows. **[unsourced: confirm that in the plugin's
  source under `app/src-tauri/target` or `~/.cargo/registry`]**.
- Close hides a window (`on_window_event` → `CloseRequested` → `prevent_close`). For secondary windows that
  would leak a hidden WKWebView per project forever.

## Settled decisions (headless: stated assumptions)
1. **Labels:** `"main"` stays the primary window: the tray relay, the default project, and the target of Dock
   reopen and the global shortcut. A project window's label is `p-<project>` (sanitised to `[a-zA-Z0-9-_]`, as
   Tauri requires **[unsourced: the exact label charset; check tauri's `WindowLabel` validation]**). Opening a
   project that already has a window focuses that window and does not create a duplicate.
2. **Only `main` relays.** `useDesktop` runs its EventSource, `tray` and `notify` work only when
   `getCurrentWebviewWindow().label === 'main'` (from `window.__TAURI__.webviewWindow`, which is available with
   `withGlobalTauri: true` in `tauri.conf.json`). Other windows still listen for `open-agent`.
3. **Secondary windows are really closed.** In `CloseRequested`, only `main` calls `prevent_close` and hides.
   A `p-*` window closes and frees its WebView.
4. **The saved default is untouched:** `setProject` writes `localStorage` only in `main` (or in a browser).
   Inside a `p-*` window it updates only the URL.
5. **Restore on launch:** keep the open `p-*` project list in `~/Library/Application Support/<identifier>/
   windows.json` (via `app.path().app_config_dir()`). Write it on create and destroy (`WindowEvent::Destroyed`),
   and re-open each window after `main` is built. Do not write it while `EXITING`, so a Quit keeps the list.
6. **Routing:** a notification or tray `agent:<key>` action goes to the `p-<project>` window when one exists
   for the agent's project, and otherwise to `main`. The agent's project must reach Rust: the tray payload
   (`TrayState` items) gains `project`. The server's `trayOfInbox()` (`server.mjs`, the WP-146 area) adds it
   from the item's target **[unsourced: whether inbox items carry project; the worker checks `inbox.mjs`
   `itemFromTransition`, which has `e.project`]**. A native notification click cannot be routed (macOS gives
   no callback, per the comment in `desktop.tsx:24-26`). The existing focus heuristic stays in `main`.
7. **Entry points:**
   - App menu `File › New Window` (⌘⇧N) opens a new window on the focused window's current project (or `all`),
     as label `p-<project>`, or focuses the existing one.
   - Tray submenu "Open in new window" lists projects taken from the last `TrayState` **[unsourced: the
     project list source; otherwise `GET /api/projects` from Rust is out — use the web: `main` emits
     `projects` to Rust alongside `tray`]**.
   - There is no app menu today **[unsourced; the worker checks for `.menu(` on the Builder]**. If there is
     none, add a minimal one (app, Edit with the standard predefined items so ⌘C/⌘V keep working, File).
8. Memory cost: each window is its own WKWebView. Hidden windows pause their polls (WP-146), and closed
   windows are freed (decision 3). Note this in features.md.

## Units
1. **Web gating** (`desktop.tsx`, `App.tsx`): decisions 2 and 4, plus a pure helper
   `isPrimaryWindow()` with a unit test (stub `__TAURI__`).
2. **Rust window plumbing:**
   - a helper `open_project_window(app, project)` (label, URL `URL?project=<enc>`, size, focus-if-exists)
   - decision 3's close behaviour
   - `windows.json` persistence and restore (decision 5)
   - `focus_for(app, project)`, used by tray `agent:` and `open-agent`
3. **Menu and shortcut:** File › New Window ⌘⇧N, and a tray "Open in new window ›" submenu.
4. **Server:** `project` on the tray items, and parse/tray tests (`tray.test.mjs`) asserting it.
5. **Docs:** `docs/features.md` covers windows per project, the memory note, and that only the main window
   notifies.

## Definition of done
Each item is checkable from a transcript:
- `cd skills/wt-dashboard && npm test` passes (including the new `tray.test.mjs` project field and the
  `isPrimaryWindow` test). `npx tsc --noEmit -p web/tsconfig.app.json` is clean. `cargo build --release` in
  `app/src-tauri` succeeds.
- Live in the built app, with log evidence (`~/Library/Logs/wt-dashboard/` app log lines added for window
  open, close and restore):
  - ⌘⇧N with project X opens `p-X` (log `window: open p-X`)
  - switching project in `p-X` leaves `localStorage.project` in `main` unchanged (Web Inspector console read)
  - one inbox event produces exactly one `notify:` log line with 2 windows open
  - Quit and relaunch logs `window: restore p-X`
  - closing `p-X` logs `window: destroyed p-X`, and it is not restored next launch
- `grep -n 'emit_to("main", "open-agent"' app/src-tauri/src/main.rs` → nothing (routed through `focus_for`).

## Order
1 → 2 → 3 → 4 → 5. Unit 1 alone is safe to ship (no visible change with one window). Commit per skill.

## Risks
- `withGlobalTauri` exposes `webviewWindow` only in some Tauri 2 versions **[unsourced]**. The fallback is a
  Rust `emit_to(label, "whoami", label)` on page load.
- The project name in the label must not collide after sanitising (for example `a.b` and `a-b`). Append a
  short hash when sanitising changed the name.
