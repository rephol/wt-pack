#!/bin/sh
# Stop hook: pop the first queued message; if any, block the stop and feed it as the next turn.
Q="$(dirname "$0")/queue.txt"; echo "$(date +%T) stop-hook fired" >> "$(dirname "$0")/hook.log"
cat >/dev/null
[ -s "$Q" ] || exit 0
msg=$(head -1 "$Q"); sed -i '' 1d "$Q"
echo "$(date +%T) delivered: $msg" >> "$(dirname "$0")/hook.log"
printf '{"decision":"block","reason":%s}\n' "$(printf '%s' "Queued message: $msg" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')"
