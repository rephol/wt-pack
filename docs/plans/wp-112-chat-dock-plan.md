# WP-112: Chat dock (Facebook-style bottom bar for open agent and room chats)

## Goal
On desktop, every agent or room chat you open joins a dock at the bottom right. A chat can be a tab (a status dot plus
an unread marker) or a compact window, with at most 3 windows open. The dock survives hash navigation and is restored
per device. On phones there is no dock: the quick switcher stays, and a floating unread bubble opens it. The sidebar
"Open" list goes away.

## What research corrected
All paths below are under `skills/wt-dashboard/`.
- **The "Open" list is a roster, not open chats.** It lists every agent (`sortAgents(data?.agents ?? [], 'attention')`), or every room in the project, at `web/src/App.tsx:480-495`. Its only state is the tab choice in localStorage `'nav-list'` (`:452-457`). Removing it therefore takes away no "open chats" state. The dock introduces that state for the first time.
- **`/api/events` carries neither agent status nor unread counts, and the web page doesn't subscribe to it.**
  - Its event types are `tray`, `build`, `notification` and `inbox` (`server.mjs:1481,1567`).
  - The only `new EventSource('/api/events')` is in `useDesktop`, behind `if (!tauri)` (`desktop.tsx:28`).
  - Status comes from the existing `/api/overview` poll every 4 s (`App.tsx:350-356`, key `['overview']`).

  settled (headless): tab status and unread come from that **existing** overview poll plus the existing `['rooms']` list, which carries `lastAt` and `needsYou`. That adds no request and no server CPU. The ticket's "from /api/events" is met in spirit: minimised tabs make no fetch of their own. Rejected: new server events, which would mean server work for data the page already polls.
- **No per-chat unread count exists.** There are no read cursors (`/api/notifications` has only a global `unread`, `server.mjs:1581`). settled: unread is a per-device marker. A tab is unread when `room.lastAt > seenAt[key]`, or when an agent's last activity is later than `seenAt`, or when it needs you. The marker is a dot, or "!" for needs-you. It is not a number. Exact counts would need server read state [deferred].
- **The side panel is agent/terminal only, and there is one of it.** `open(key)` (`App.tsx:393-401`) routes `room:` keys to `#rooms/<slug>`, and it sets a single `openPane` (`:344`). The notification gate takes one `openKey` (`desktop.tsx:18,39`). With the dock, "open" means the set of keys in open windows plus `openPane`.
- **"Minimised tabs fetch nothing" conflicts with how the stream cache works.** Streams linger for `GRACE_MS = 30_000` after the last viewer (`streamStore.ts:42`). `AgentPanelBody` also runs its own polls: `:1356` every 5 s while working, and `:727` for picker questions every 400 ms to 2 s. So a tab must render **no chat body at all**, only data from the roster. Closing a window releases its stream; the 30 s grace is kept, because it is what makes re-opening instant. After 30 s the tab really does fetch nothing.
- **"Last N, more on scroll" can't page backwards on the server.** Rooms cache the whole history (`keep: Infinity`, `rooms.tsx:214`), and the agent stream resumes from a cursor. Both already render through `VirtualRows` (`virtual.tsx`, `THRESHOLD = 150`). settled: a compact window renders the last 100 rows and shows a "Show earlier" control at the top, which reveals the next 100 **from memory**. Rejected: server-side paging, which is new API for a problem the virtualiser already bounds.

## Approach
- **State lives in `web/src/dock.ts`, which is pure and tested.** `DockState = { items: [{ key, kind: 'agent'|'room', min: boolean, openedAt }], seen: { [key]: ms } }`. It exports:
  - `openChat(state, key)`: adds the chat or raises it as a window. When that makes more than 3 windows, the oldest window becomes a tab.
  - `minimise`, `close`, `markSeen`.
  - `unread(state, roster)`.
  - `load()` / `save()` on localStorage `'chat-dock'`, following the `try { … } catch { /* private mode */ }` idiom in `density.ts:7-12`.

  A useReducer in App holds it.
- **The UI is `web/src/Dock.tsx`,** mounted beside the other hosts in `App.tsx:572-580`. App never unmounts, so it persists across navigation.
  - Each tab shows its name, a status dot from the overview agent status (or room `needsYou`), and the unread marker.
  - A window is roughly 320×440. Its header has a status dot, the name, and minimise / expand / close buttons.
  - Expand, for an agent, calls the existing `open(key)` to reach the side panel and removes the item from the dock. For a room, it goes to `#rooms/<slug>`.
- **Window bodies reuse the existing components.**
  - Agent windows use `AgentPanelBody` with a new `mode='dock'` (props at `App.tsx:1284`: `mode = 'panel'`). It hides the panel header and uses the dock's own.
  - Room windows use `RoomView` with a new `compact` prop. It hides the back button, the members sheet and the project chip, and keeps the composer, ticket chips, newlines and image preview.
  - Both take `limit={100}` for last-N rendering.
- **Routing on desktop.** `open(key)` at `App.tsx:393` changes. When the viewport is wide (`!narrow`) and the key is `agent:` or `room:`, it calls `dock.openChat(key)`. Terminals keep the panel. This covers every existing entry point in one place, because they all route through `open`:
  - room member list (`rooms.tsx:329`) and @mentions (`:353,363`);
  - inbox (`inbox.tsx:143`);
  - notifications (`desktop.tsx:52,54`);
  - the quick switcher (`App.tsx:579`), TaskQueue (`:545`), AgentsPage (`:547,1023`) and SpawnHost (`:574`).

  Overview has no agent open call; its room links are `href="#rooms/…"` (`overview.tsx:107`). They become `onClick` → `open('room:<slug>')` on desktop, so "Overview opens a dock window" holds. The Rooms page `#rooms/<slug>` stays a full page when navigated directly.
- **Notification gate.** `useDesktop(openKey)` becomes `openKeys: string[]`, made of `openPane` plus the keys of open windows. `gate()` checks inclusion in that list.
- **Phone** (`phone` = 639px, `App.tsx:377-380`): the dock does not render. `QuickSwitcher` keeps its FAB. When any docked chat is unread, the FAB shows a badge dot, which is the "floating unread bubble".
- **Sidebar:** delete the Open section (`App.tsx:480-495`) along with the `sideList` / `'nav-list'` state and `sideRooms` (`:452-458`), after confirming they have no other readers.
- **Mockup:** move `/private/tmp/claude-501/chat-dock-mockup.html` to `docs/mockups/wp-112-chat-dock.html`.

## Review corrections (applied; these override the text above where they conflict)
- **Not every entry point goes through `open()`.** Room opens bypass it: the switcher's `onOpenRoom` sets `location.hash = rooms/…` (`App.tsx:579`), the inbox `go()` room branch does too (`inbox.tsx:142`), and so does RoomsPage's `onSelect` (`App.tsx:555`). U3 changes the switcher and inbox room paths to `open('room:<slug>')`. `onSelect` on the Rooms page stays page navigation, because there you are already on the page.
- **Room key format.** It is exactly `room:<slug>`, the same string the gate builds (`desktop.tsx:41`, `room:${e.target.room}`). `open()` must not append a suffix for dock keys.
- **Where the gate lives.** `gate()` is in `notifyGate.ts:16-19` (`target === s.openKey`), so the change is `s.openKeys.includes(target)`, and its tests are updated. The desktop open calls are at `desktop.tsx:44,46`. The `useDesktop` call site is `App.tsx:420`, `useDesktop(collapsed ? null : openPane, open)`, which becomes `openKeys = [...(collapsed || !openPane ? [] : [openPane]), ...open dock windows]`. Minimised tabs are excluded.
- **RoomView has to be exported.** It is `function RoomView` at `rooms.tsx:203`, not exported. Compact mode needs `profile`, taken from the same query RoomsPage uses (`:99`), and `onBack` is set to close the dock item, which covers the delete-room call at `:209`.
- **How `limit` works.** `VirtualRows` has no limit prop (`virtual.tsx:12`). Slice `rows` before passing them in (`App.tsx:1388`, `rooms.tsx:351`). A `jump` target (search, reply links) outside the slice must widen the slice first.
- **What `mode='dock'` has to do.** `AgentPanelBody` only branches on `page = mode === 'page'` (`App.tsx:1475`). Dock mode needs its own header branch, and it hides the Summary and TagsDialog trigger (`:1563`). Tags stay editable from the side panel.
- Files add: web/src/notifyGate.ts and its test, web/src/inbox.tsx, web/src/virtual.tsx (unchanged; reference only, remove if untouched).

## Implementation units
**U1: dock state (`web/src/dock.ts`, `dock.test.ts`).**
- Tests:
  - A 4th open collapses the oldest window.
  - Re-opening a tab raises it.
  - Close removes the item and its `seen` entry.
  - Unread rules for room `lastAt` and for agent needs-you.
  - `load` tolerates garbage and a throwing localStorage.
- Runs in the existing `node --experimental-strip-types --test web/src/*.test.ts` (skill `package.json:10`).

**U2: Dock UI + compact modes.**
- `Dock.tsx`.
- `AgentPanelBody` `mode='dock'` and `limit`.
- `RoomView` `compact` and `limit`.
- The "Show earlier" control.
- CSS in the existing stylesheet.

No native dialogs (`noNativeDialogs.test.ts`).

**U3: routing + removal.**
- `open()` routes to the dock on desktop.
- Overview room links change as described.
- `openKeys` goes to `useDesktop` / `gate`.
- The sidebar Open list is removed.
- The phone FAB gets its unread badge.

A test in `dock.test.ts` or `switcherData.test.ts` covers any extracted pure helper, for example `routeOpen(key, {narrow})`, which returns `'dock'|'panel'|'page'`.

**U4: mockup, docs, performance check.**
- Move the mockup.
- Update `docs/features.md` for the Dock, the removal of the sidebar Open list, and the phone bubble.
- Record the measurements as a `wt-ticket comment WP-112`.

## Files
- skills/wt-dashboard/web/src/dock.ts (new), dock.test.ts (new), Dock.tsx (new), App.tsx, rooms.tsx, desktop.tsx, overview.tsx, switcher.tsx, the stylesheet that holds `hd-nav-scroll`
- docs/mockups/wp-112-chat-dock.html (new, moved), docs/features.md

## Verification
- `cd skills/wt-dashboard && npm test`, then `cd web && npx tsc --noEmit -p . && npm run build`. The change is web only, so no restart is needed.
- agent-browser (`--session <agent name>`; run `caffeinate -u -t 60 &` first) at 1440×900 and 390×844:
  - Open 4 chats and check that the oldest collapses.
  - Minimise, expand, and close.
  - Navigate between pages and check the dock stays.
  - Reload and check the state is restored.
  - Open from the member list, inbox and Overview.
  - At 390, check there is no dock and that the FAB badge appears when a chat is unread.
- Performance: open 3 windows and 10 tabs, and read `performance.memory.usedJSHeapSize` through agent-browser eval (or a CDP heap snapshot); the budget is ≤ about 50 MB. Take `ps -o %cpu` of the server over 60 s idle, before and after, to confirm no rise. Leave all tabs minimised for more than 30 s and confirm there are no new `/stream` or agent requests in the network log.

## Definition of Done
- The `dock.test.ts` cases above pass, as do `npm test`, tsc and the build.
- Screenshots at 1440 and 390 show the dock with windows and tabs, and the phone bubble. They are attached to #wt-pack or the ticket, with paths quoted in the transcript.
- The ticket has a comment with the measured heap MB, the idle server CPU before and after, and the "no requests from minimised tabs" network observation.
- The sidebar Open list is gone. `grep -n "nav-list" web/src` returns nothing.
- The mockup is at `docs/mockups/wp-112-chat-dock.html`, and `docs/features.md` is updated.

## Risks and deferred
- **Unread is per device and approximate** (a dot, not a count, driven by `lastAt`). Exact counts and cross-device read state need server read cursors, which are deferred.
- **Agent status is up to 4 s stale** (the overview poll). That is acceptable for a dot.
- **An open agent window still runs `AgentPanelBody`'s polls** while its agent is working, which is the same cost the side panel has today. Three working agent windows means three 5 s polls. That is within budget [unsourced: not measured yet; U4 measures it].
- **Removing the Open list removes the sidebar room roster.** The Rooms page and the quick switcher still list rooms.
