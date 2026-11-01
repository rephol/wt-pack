#!/bin/sh
# WP-70: run by launchd (id.local.wtdashboard.watchdog) every 2 minutes, outside the server. Notifies once when
# /api/health stops answering and once when it answers again; the state file remembers which it last said.
# ponytail: fixed port 7777 (the server's default); pass another URL as $1 if that ever changes.
URL="${1:-http://127.0.0.1:7777/api/health}"
STATE="$HOME/.cache/wt-dashboard/probe-down"
mkdir -p "$(dirname "$STATE")"
if curl -sf -m 5 -o /dev/null "$URL"; then
  [ -f "$STATE" ] && rm -f "$STATE" && osascript -e 'display notification "Answering again." with title "wt-dashboard server is back"'
else
  [ -f "$STATE" ] || { date > "$STATE"; osascript -e 'display notification "/api/health did not answer. npm run service:status in skills/wt-dashboard; log ~/Library/Logs/wt-dashboard/server.log" with title "wt-dashboard server is down"'; }
fi
# WP-378: the hc core is only WATCHED here, never started (the dashboard and its probe never start it: `hc server status`, `hc ls` and `hc get`
# all start a stopped core on macOS). core.lock holds the core's socket path; a connect says up or down. One line in the server log per
# change, no notification (the dashboard shows the banner and the watchdog its finding).
CORE_LOG="$HOME/Library/Logs/wt-dashboard/server.log"
CORE_STATE="$HOME/.cache/wt-dashboard/probe-core-down"
LOCK="${XDG_STATE_HOME:-$HOME/.local/state}/herdr-core/${HC_SESSION:-default}/core.lock"
SOCK=""; [ -s "$LOCK" ] && SOCK=$(cat "$LOCK")
if [ -n "$SOCK" ] && { : | nc -U -w 1 "$SOCK"; } >/dev/null 2>&1; then
  [ -f "$CORE_STATE" ] && rm -f "$CORE_STATE" && { mkdir -p "$(dirname "$CORE_LOG")"; echo "$(date) hc core is running again" >> "$CORE_LOG"; }
else
  [ -f "$CORE_STATE" ] || { date > "$CORE_STATE"; mkdir -p "$(dirname "$CORE_LOG")"; echo "$(date) hc core is not running (the probe does not start it)" >> "$CORE_LOG"; }
fi
exit 0
