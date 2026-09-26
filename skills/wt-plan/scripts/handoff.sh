#!/bin/sh
# Moved to wt-handoff; kept so existing callers keep working.
exec "$(dirname "$0")/../../wt-handoff/scripts/handoff.sh" "$@"
