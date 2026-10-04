# WP-229 — Board page: its own project picker, independent of the global project filter

## Today (research)

- The global project lives in `App.tsx`: `const [project, setProjectState] = useState<string>(initialProject)`
  (`web/src/App.tsx:344`); `setProject` writes `?project=` and `localStorage 'project'` (L345-353). The board
  gets it directly: `<Board project={project} … projects={counts.by.map(([p]) => p)} onProject={setProject} />`
  (L523). So picking a board today changes the whole dashboard.
- `Board` (`web/src/board.tsx:77`) keys every query on its `project` prop: tickets `['tickets', project]`
  (L79-80), board settings PUT and Run now (L90-91), `TicketDetail` (L278, L445). Dispatch status comes from the
  same `/api/tickets?project=` response. **So switching the prop alone switches all of the board's queries** —
  no change inside the queries is needed.
- `project === 'all'` renders `BoardPicker` (one button per project, L63-75, L143), which calls `onProject`.
- Header shows the project as a plain `<Heading level={3}>{project}</Heading>` on desktop (L253); the phone
  header is the `VStack` just above (L236-250). A `Selector` (`label`, `value`, `options`, `onChange`,
  `width`, `hasSearch`) is already used in this file (L333).
- Two "open ticket" paths set the global project then jump to `#board/<id>`: the `wt:open-ticket` event
  (L356) and `onOpenTicket` (L587).

## Decisions

1. New state in `App.tsx`: `boardProject` — `localStorage 'board-project'` (read/write in try/catch, like
   `nav-collapsed` at L376-379), `null` when never chosen. Effective board project = `boardProject ?? project`,
   so it defaults to the global project until the viewer picks one. Written only from the primary window
   (same `isPrimaryWindow()` guard as L352, WP-166) — a project window must not overwrite the saved default.
2. `<Board project={boardProject ?? project} onProject={setBoardProject} …/>`. `BoardPicker` therefore sets the
   board project, not the global one.
3. In `Board`'s header (desktop L253 and the phone header), replace the plain heading with a `Selector`
   (label "Board project", `hasSearch`, options = `projects`; include the current `project` if missing so the
   value never vanishes). `onChange` → `onProject`. Picking does not touch `?project=` or `'project'`.
4. Both open-ticket paths (L356, L587) also call `setBoardProject(p)`, else the jump lands on another
   project's board where the ticket does not exist. They keep calling the global `setProject(p)` as today
   (unchanged behaviour outside the board; ticket says the global filter stays as it is).
5. No "follow global" reset control. [unsourced: judged unneeded — picking the global project in the
   Selector is the reset.] Add one if asked.

## Units
1. `web/src/App.tsx`: decisions 1, 2, 4.
2. `web/src/board.tsx`: decision 3 (both headers).
3. `docs/features.md`: Board section — one sentence: the board has its own project picker, remembered per
   viewer, defaulting to the global project.

## Definition of Done
- `cd skills/wt-dashboard && npm test` passes (includes web typecheck; `noNativeDialogs.test.ts`).
- `cd skills/wt-dashboard/web && npm run build` succeeds (web-only change: no server restart).
- agent-browser `--session <agent name>`: on `#board`, with the global sidebar on project A, choose project B
  in the board's Selector → the board shows B's tickets and Dispatch row; the sidebar still says A and the
  Overview still shows A; reload → board still B. Same check at 390x844.
- One commit (wt-dashboard) + docs in the same merge.

## QA brief
Screen: Board. Taps: open the board's project select → pick a different project → the board's columns and
title switch; open Overview → still the old project; back to Board, reload → still the picked project. Done
check: those hold at 412x700 and iPhone 13. No e2e writing or running — the done check is not an e2e test.
