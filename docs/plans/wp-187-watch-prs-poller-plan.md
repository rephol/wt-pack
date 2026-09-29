# WP-187: wt-watch-prs background poller delivers PR events as wt-messages (includes WP-188)

Base: `origin/main` @ 96641f3 (WP-186 Monitor re-arm merged). Branch `wp-187-watch-prs-poller`.

## Problem
Today the reviewer session arms two `Monitor`s (`skills/wt-watch-prs/SKILL.md` §1, "Arm two Monitors, both
`timeout_ms: 1800000`") and re-arms them every 30 minutes. Each arm is a tool call. When the harness's
auto-mode classifier is down, those calls fail silently ("the tool can come back with no task id and no error
… the harness's own auto-mode classifier gave no verdict"), and the watch stops. The fix is to make the polling
independent of the session. A background process polls, and each event reaches the pane as a typed wt-message,
which needs no tool call to receive.

## What research found (evidence)
- Both pollers already have a single-shot mode: `poll-shas [--once]` sets `WATCH_PRS_POLLS=1` (`watch-prs.sh:218`),
  and `poll-replies --session S [--once]` sets `polls=1` (`:258`). Each printed line is one event:
  `PR #n — new commits <sha> — …`, `PR #n — NO LONGER OPEN — …`, and `PR #n — <kind> on a held PR — …`.
- **All of their dedupe state is per-process and temporary. This is the WP-188 bug, and it also blocks
  `--once`:**
  - `poll-shas` uses `T=$(mktemp -d) … : > "$T/fired"; : > "$T/prev"` (`:220`). With an empty `prev`, a PR
    that vanished between runs is never reported, and an empty `fired` means the TTL dedupe resets on every
    run.
  - `poll-replies` uses `T=$(mktemp)` for seen ids and `SINCE` = now−15 min on every start (`:261-262`).
  - So a poller that calls `--once` every minute would re-announce every unreviewed head each minute (the
    `fired` TTL of 900 s never survives) and would never report a merge. **Persisting this state is required
    for the poller, not optional.** It also fixes WP-188 for the Monitor fallback.
- State already lives under `${WT_WATCH_PRS_HOME:-~/.local/share/wt-watch-prs}/<owner>-<repo>/` with
  `state.json`, `claims/` and `state.lock` (header, `watch-prs.sh:18`).
- Delivery: `handoff.sh` takes `--pane <id>`, `--kind handoff|dispatch|routine|reply|system` (`handoff.sh:92-93`)
  and `--no-goal` (`:95`). wt-watch-prs dispatch already calls it this way (`watch-prs.sh:213`:
  `--role reviewer --kind dispatch … --no-goal`).
- launchd precedent: `setup` installs `id.local.wtdashboard.server` and `id.local.wtdashboard.watchdog`
  (`setup:20`, `:375`) through `skills/wt-dashboard/scripts/service.mjs`. Doctor checks the plist
  (`setup:205`), and non-Darwin gets an `opt` line (`setup:214`, `:370`).

## Settled decisions (headless: stated assumptions)
1. **One poller process for all watched repos**: `watch-prs.sh serve`, run by a launchd agent
   `id.local.wtpack.watchprs` and installed by `setup install` the same way the watchdog probe is. It does not
   run inside the dashboard server. The plugin-only install has no dashboard, and a restart of the dashboard
   must not drop the watch. On Linux, `setup` prints an `opt` line (`run: watch-prs.sh serve`).
2. **Registration, not arming.** SKILL.md §1 changes from "arm two Monitors" to
   `$W register --session S`, which records `{repo, pane: canonical($HERDR_PANE_ID), session, at}` in
   `$WT_WATCH_PRS_HOME/watchers.json` under a lock. `$W unregister --session S` removes it. The pane is
   resolved with `herdr pane get` (CLAUDE.md trap: `HERDR_PANE_ID` may be the stable id).
3. **Each loop** (every 60 s) runs, for each watcher, `poll-shas --once` and, every 90 s, `poll-replies --session S
   --once`. Each output line is delivered with
   `handoff.sh --pane <pane> --kind system --no-goal --from wt-watch-prs <main checkout>`, with the line as the
   prompt. `kind=system` means "act, no reply needed", which matches what an event is.
4. **Persistent dedupe (WP-188).** `poll-shas` keeps `prev` and `fired` in `<repo dir>/poll/`.
   `poll-replies` keeps `seen` ids and `since` in `<repo dir>/poll/replies-<S>`. All of these are written
   under the existing `state.lock`. The Monitor path uses the same files, so a re-armed Monitor resumes rather
   than starting blank. The fired TTL stays 900 s: a head that is still unreviewed re-fires after 15 min, which
   is a nudge, not spam.
5. **"The pane stopped consuming"** is either: the pane is gone (`herdr pane get` fails), handoff fails 3 times
   in a row, or a delivered `new commits` event has no claim and no `reviewed` record for that PR after 30 min
   while the pane is `idle` or `done`. When that happens, post
   `room post <main checkout basename> "wt-watch-prs: <repo> is unwatched — reviewer <name> stopped
   consuming (<reason>)"`, which is the same text shape as the Monitor path's notice. The dashboard's inbox
   already picks up room posts that mention the user **[unsourced: confirm a room post raises an Inbox item;
   otherwise also POST an Inbox `server` item]**. The poller then unregisters that watcher, so it posts once,
   not every minute.
6. **Fallback.** §1 first runs `$W poller-status`, which exits 0 when the launchd agent is loaded and its
   heartbeat file (`$WT_WATCH_PRS_HOME/poller.beat`, touched each loop) is younger than 3 min. If it exits
   non-zero, the session arms Monitors exactly as WP-186 describes. The Monitor text stays in SKILL.md as the
   fallback section.

## Units
1. **Persist poll state** (`watch-prs.sh` poll-shas/poll-replies): implements decision 4. Tests in
   `watch-prs.test.mjs` (existing gh PATH shim, `WATCH_PRS_POLLS`): two consecutive `--once` runs do not re-emit
   the same head within the TTL, and a PR that was present in run 1 and missing in run 2 with
   `gh pr view`=MERGED emits `NO LONGER OPEN` in run 2 (this is the WP-188 regression test). A reply that was
   seen in run 1 is not re-emitted in run 2.
2. **register / unregister / poller-status**: tests for lock-safe concurrent register, unregister, and a stale
   heartbeat → exit 1.
3. **serve loop**: delivery via `WATCH_PRS_HANDOFF` (the existing knob, `watch-prs.sh:189`) so tests stub it.
   Also covers the unconsumed rule (decision 5) and heartbeat. Tests: one event → one stub-handoff call with
   `--kind system --pane <p>`, 3 failures → the unwatched post (a stubbed `room`) plus unregister.
4. **launchd + setup**: plist writer (reuse `service.mjs`'s probe pattern **[unsourced: whether service.mjs is
   generic enough; else a small `watch-prs.sh install-agent`]**), `setup install` and `setup uninstall`, and
   a doctor line (`watchprs poller: loaded, beat Ns ago` or `bad`).
5. **SKILL.md** §1: register first, Monitor as the fallback, and the WP-186 paragraph about the vanished-PR
   gap replaced with "fixed by WP-187/188: the baseline persists". Also update `docs/features.md`.

## Definition of done
Each item is checkable from a transcript:
- `node --test skills/wt-watch-prs/scripts/watch-prs.test.mjs` passes, including the new cases in units 1–3.
- `node --test skills/wt-shared/scripts/paths.test.mjs` passes, and `./setup doctor` prints the poller line
  as loaded.
- A live check against a **throwaway repo and a throwaway reviewer pane** (never the user's agents): register,
  push a commit to an open PR, and within 2 min `herdr pane read <pane>` shows a
  `<wt-message … kind=system from="wt-watch-prs">PR #n — new commits …`. Kill the pane, and the unwatched room
  post appears (`room read <slug>`). Clean up the repo, the pane and the registration.
- `grep -n "register --session" skills/wt-watch-prs/SKILL.md` matches in §1.
- WP-188 is closed as covered by this change (a `wt-ticket comment WP-188` plus a move to done after merge).

## Order
1 → 2 → 3 → 4 → 5. Unit 1 ships value alone (it fixes WP-188 for the Monitor path). Make one commit per skill
touched (`wt-watch-prs`, `setup`/`wt-setup`, docs).

## Risks
- Double delivery while both paths run (a Monitor armed and the poller alive). §1 arms Monitors only when
  `poller-status` fails, and the persisted `fired` file is shared, so the second path dedupes against the
  first.
- A wt-message typed into a busy pane queues behind its turn. That is acceptable: events are not urgent to the
  second.
- launchd PATH lacks `gh` and `herdr`. The plist must set a PATH that includes `brew --prefix`/bin, as the
  dashboard's plist does **[unsourced: copy what service.mjs sets]**.
