# Reliability lens

Triggered when the target touches timeouts, retries, launchd plists, child processes, kill paths, or a
`Monitor` driving a long-running loop.

Adversarial asks whether the premise can be attacked; this lens asks whether the mechanism keeps running
under ordinary operational pressure — a process dies, a signal lands, an arm call returns with no confirmed
task id. The failures here are quiet: the system looks armed or running while nothing actually is.

## Look for

- **A `Monitor` (or equivalent) armed without confirming it.** An arm call that returns with no task id and
  no visible error reads as armed while nothing is watching — the CLAUDE.md WP-152 trap. Check for a retry
  and an explicit failure path, not just the call site.
- **A kill or signal path that can hit more than its target.** BSD `pkill`/`pgrep` treat options placed after
  the pattern as more patterns — `-f … -n` becomes its own match and SIGTERMs everything, the CLAUDE.md
  WP-109 trap. Check that kills go by a recorded pid, not a command-line pattern.
- **A retry with no backoff or cap.** A loop that retries immediately and indefinitely turns a transient
  failure into sustained load, or spins forever on a permanent one.
- **A timeout that does not actually bound the call.** A value passed to a library option that library does
  not honour, or a timeout race that leaves the underlying operation still running after the caller gives up.
- **A child process with no recorded pid.** A process started and not tracked cannot be cleanly killed later
  without falling back to a pattern match, which is the previous bullet's trap.
- **A launchd plist or service restart with no idempotency check.** A restart triggered from more than one
  path, or one that does not check whether a previous instance is still shutting down.
- **A cache or task-hash guard whose failure is silent.** A guard that should stop a stale pass from running
  but degrades to "run anyway" when its own check errors.

## Rules

- Verify against the actual arm/kill/retry code, not the surrounding comment describing intent.
- Say which pid, task id, or process handle you traced.
- A `settled:` decision is the user's; challenge it only as something that cannot work.

## done =

Every arm, retry, kill and timeout path in the target traced to its actual failure behaviour — confirmed,
not assumed from the surrounding prose — and every kill path checked against the BSD pattern-after-options
trap.

## Don't flag

- A retry with no explicit cap when the underlying call already has its own timeout that bounds each attempt
  and the loop is user-triggered (not a background daemon) — the operator can interrupt it.
- A kill path that already goes through this pack's `wt-agents/bin` PATH shims or an equivalent recorded-pid
  helper — verify the helper is actually used before flagging the call site as unsafe.

## Return

Findings ranked by severity. Each: the mechanism, the concrete operational failure, and whether anything
would surface it happening.

Write findings per `references/reviewer-contract.md` and SKILL.md's schema — JSON to
`<scratchpad>/findings/reliability.json`, a one-line count and the worst one in your reply. The caller groups
duplicates and checks every finding against the file it cites, and both read this file — a prose reply means
neither runs.
