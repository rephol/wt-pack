#!/bin/sh
# Courier Stop hook: wait up to 20s for a queued "<to>\t<text>" line, then block the stop with a SendMessage instruction.
H="$(dirname "$0")"; Q="$H/queue.tsv"; cat >/dev/null
i=0; while [ ! -s "$Q" ] && [ $i -lt 20 ]; do sleep 1; i=$((i+1)); done
[ -s "$Q" ] || { echo "$(date +%T) idle-timeout" >> "$H/hook.log"; exit 0; }
line=$(head -1 "$Q"); sed -i '' 1d "$Q"; to=${line%%	*}; text=${line#*	}
echo "$(date +%T) deliver to=$to" >> "$H/hook.log"
python3 - "$to" "$text" <<'PY'
import json,sys
print(json.dumps({"decision":"block","reason":f"Courier job: call SendMessage with to={sys.argv[1]!r} and message exactly: {sys.argv[2]}  Then end your turn with no other output."}))
PY
