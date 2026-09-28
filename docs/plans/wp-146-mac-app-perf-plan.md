# WP-146 — Mac app feels heavy vs web/PWA: profile and fix

Base: `origin/main` @ c17b602. Branch `wp-146-mac-app-perf`.

## Problem
Idle after 3.5h (orchestrator measurement): app process 50MB / 5.9% CPU, WebKit.WebContent 202MB / 8.1% CPU.
Continuous idle CPU is the defect; memory is secondary.

## What research found (evidence from the tree)
1. **Native tray menu rebuilt every 4 s, unconditionally.** `server.mjs:2929` `setInterval(tick, 4000)`; the
   tick ends with `broadcastEvent('tray', trayOfInbox())` (`server.mjs:1626`) whether or not anything changed.
   `web/src/desktop.tsx:29` relays each one: `tauri.event.emit('tray', …)`. `app/src-tauri/src/main.rs:600-612`
   then calls `tray.set_title(...)` and `build_menu(&hh, &st)` + `tray.set_menu(Some(m))` on **every** event —
   the `last.swap` check only gates the log line. That is ~15 full NSMenu rebuilds a minute, forever, on the
   main thread of the app process. Prime suspect for the app's 5.9%. Ticket candidate (1) — **confirmed**.
2. **The second EventSource is cheap** (heartbeat every 15 s, `server.mjs:1642`); it is not a cost by itself,
   only as the carrier of (1). Keep it.
3. **Polls that never pause.** Closing the window only hides it (`main.rs:574-576`), so the WebView keeps
   running. TanStack Query pauses `refetchInterval` when `document.visibilityState` is hidden **unless**
   `refetchIntervalInBackground: true`; these set it: `inbox.tsx:30` (5 s), `status.tsx:76` (5 s),
   `usage.tsx:50` (30 s), `App.tsx:748` picker (2 s / 400 ms). Plus un-flagged polls (`board.tsx:80` 4 s,
   `App.tsx:356` 4 s, `terminals.tsx:57` 5 s, `rooms.tsx:75` 10 s…) that only pause if WKWebView reports the
   hidden window as `hidden` — **[unsourced]**: whether a hidden Tauri window flips `visibilityState` must be
   measured (Unit 1).
4. `backdrop-filter` is already disabled for WKWebView in `web/src/index.css:8-12` (candidate (2) partly
   handled). Long-list rendering cost is **[unsourced]** — only profiling says.
5. Build: `tauri.conf.json` serves `../../web/dist` (a Vite production build), so React dev mode is not in
   play — candidate (4) is **disproved** for the web side. Rust build profile **[unsourced]**: check that the
   installed app was built `--release` (Unit 1).

## Settled decisions (no synchronous user — assumed)
- Fix what the evidence proves first (tray), then what profiling ranks; do not restyle the UI speculatively.
- No behaviour change in the browser/PWA except that the tray event is sent only on change.
- The user judges the feel; the worker reports numbers.

## Units
### Unit 1 — Baseline measurement (no code)
Build and run the app as installed. With the window visible-and-idle for 5 min, then hidden for 5 min, record
CPU% and RSS of the app process and WebKit.WebContent (`top -l 6 -s 10 -stats pid,command,cpu,mem` or
`ps -o %cpu,rss`). In Safari Web Inspector (Develop → app) check `document.visibilityState` while hidden and
record a 30 s Timeline to list what is firing. Also note if the running app binary is a release build.
Record the numbers in the PR body. **Done when** a before-table exists for both states.

### Unit 2 — Tray: only on change (the proven cause)
- Server: in the tick, remember the last serialized `trayOfInbox()` and `broadcastEvent('tray', …)` only when
  it differs (the on-connect send at `server.mjs:1639` and the clear path at `:1662` stay).
- Rust (`main.rs:600-612`): keep the last `TrayState` (already stored in `LAST_TRAY`); if the new one equals
  it, return before `set_title`/`build_menu`/`set_menu`. (`TrayState` needs `PartialEq`.) Belt and braces:
  a server restart or other emitter must not reintroduce the loop.
- Test: a server unit test that two ticks with an unchanged inbox broadcast `tray` once.
**Done when** the app log / an event counter shows no tray rebuild over 60 s of idle with an unchanged inbox.

### Unit 3 — Pause background polling while the window is hidden
If Unit 1 shows `visibilityState` stays `visible` while the window is hidden: have Rust emit window
shown/hidden to the webview and, in `desktop.tsx`, drive TanStack's `focusManager`/an `online`-style flag so
queries pause; otherwise just drop `refetchIntervalInBackground: true` from `usage.tsx:50` and `status.tsx:76`
where a stale value while hidden is harmless. Keep `inbox.tsx:30` (notifications come from the SSE stream
anyway — verify before dropping) and the picker (`App.tsx:748`, only enabled while a picker is open).
**Done when** hidden-window CPU for WebKit.WebContent drops measurably vs. Unit 1.

### Unit 4 — Top profiled cause in the visible window (conditional)
Only if Unit 1's Timeline shows a single dominant visible-idle cost (a re-render loop, a timer at 1 s such as
`App.tsx:230` staying on, layout thrash). Fix that one; otherwise record "nothing dominant" and stop.

### Unit 5 — Report
`docs/features.md` only if user-visible behaviour changed (it should not). PR body: before/after table
(app + WebContent, CPU% and RSS, visible-idle and hidden). Post the table to #wt-pack for the user to judge.

## Definition of done
- Tray event and menu rebuild occur only on change (test + log evidence).
- Before/after idle CPU numbers for both processes, visible and hidden, in the PR body.
- `npm test` and `npx tsc --noEmit -p tsconfig.app.json` green; `cargo build --release` for the app succeeds.
- Server restarted at most once (`npm run service:restart`).

## Risks
- Rebuild the app to measure; don't restart the server repeatedly (CLAUDE.md).
- Tray dedupe must still update the title when only `needs` count changes — compare whole state.
