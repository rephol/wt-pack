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
# WP-218: herdr's headless server, if nobody started it since boot (`herdr status` gates it: never a second one).
PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
if command -v herdr >/dev/null 2>&1 && ! herdr status server 2>/dev/null | grep -q '^status: running'; then
  nohup herdr server >/dev/null 2>&1 &
  echo "$(date) herdr server was not running — started it" >> "$HOME/Library/Logs/wt-dashboard/server.log"
fi
exit 0
