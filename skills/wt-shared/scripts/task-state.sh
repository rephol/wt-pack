#!/bin/sh
# A planner's task label and its lifecycle, as herdr pane tokens (source wt-dashboard, shown as
# "task · task_state" in the dashboard):
#
#   task-state.sh own "<TICKET> <title>" [state]   # this pane: task (cut to 80) + task_state (default planning)
#   task-state.sh state "<state>"                   # this pane: task_state only (e.g. "handed to <worker>")
#   task-state.sh planner "<state>"                 # from a worker: the planner that handed this work over
#   task-state.sh planner --clear                   # … clear that planner's task + task_state
#
# `planner` finds the planner through this pane's handoff_from_pane token (role=planner only) and changes it only while
# the planner's task is still this work: it starts with the same ticket (ENG-123 or WP-12), or, without one,
# is the same label. Every failure is silent and exits 0 (not in herdr, pane gone, old herdr).
[ -n "${HERDR_PANE_ID:-}" ] && command -v herdr >/dev/null && command -v jq >/dev/null || exit 0

tokens() { herdr pane get "$1" 2>/dev/null | jq -c '.result.pane.tokens // {}' 2>/dev/null; }
tok() { printf '%s' "$1" | jq -r --arg k "$2" '.[$k] // empty' 2>/dev/null; }
meta() { p=$1; shift; herdr pane report-metadata "$p" --source wt-dashboard "$@" >/dev/null 2>&1 || true; }
cut80() { printf '%.80s' "$1"; }

# HERDR_PANE_ID may be herdr's stable id; the tokens live on the pane id.
me=$(herdr pane get "$HERDR_PANE_ID" 2>/dev/null | jq -r '.result.pane.pane_id // empty' 2>/dev/null)
[ -n "$me" ] || exit 0

case "${1:-}" in
  own)
    [ -n "${2:-}" ] || exit 0
    meta "$me" --token "task=$(cut80 "$2")" --token "task_state=$(cut80 "${3:-planning}")"
    ;;
  state)
    [ -n "${2:-}" ] && meta "$me" --token "task_state=$(cut80 "$2")"
    ;;
  planner)
    mine=$(tokens "$me")
    planner=$(tok "$mine" handoff_from_pane)
    [ -n "$planner" ] || exit 0
    theirs=$(tokens "$planner")
    [ "$(tok "$theirs" role)" = planner ] || exit 0   # an orchestrator's handoff is not a planner's to relabel
    ptask=$(tok "$theirs" task)
    [ -n "$ptask" ] || exit 0
    task=$(tok "$mine" task)
    # <TEAM>-N for a Linear team in WT_LINEAR_TEAMS, or a local board key (wt-ticket keys; empty when the server
    # is down) — the same rule as wt-handoff's handoff.sh.
    T="$(cd "$(dirname "$0")" && pwd)/../../wt-ticket/scripts/wt-ticket"
    teams=$(sed -n 's/^[[:space:]]*WT_LINEAR_TEAMS=//p' "$HOME/.config/wt-dashboard/env" 2>/dev/null | tail -1 | tr -d '"' | tr ',' '\n' \
      | sed 's/=.*//; s/[[:space:]]//g' | grep -E '^[A-Za-z][A-Za-z0-9]*$' | tr '\n' '|' || true)
    keys=$( [ -x "$T" ] && "$T" keys 2>/dev/null | tr '\n' '|' || true)
    all="$teams$keys"
    ticket=$( [ -n "$all" ] && printf '%s\n%s\n' "$(tok "$mine" ticket)" "$task" | grep -oiE "(^|[^a-z])(${all%|})-[0-9]+" | grep -oiE '[a-z]+-[0-9]+$' | head -1 | tr '[:lower:]' '[:upper:]' || true)
    if [ -n "$ticket" ]; then
      case "$(printf '%s' "$ptask" | tr '[:lower:]' '[:upper:]')" in "$ticket"*) ;; *) exit 0 ;; esac
    else
      [ "$ptask" = "$task" ] || exit 0
    fi
    if [ "${2:-}" = --clear ]; then meta "$planner" --clear-token task --clear-token task_state
    elif [ -n "${2:-}" ]; then meta "$planner" --token "task_state=$(cut80 "$2")"
    fi
    ;;
esac
exit 0
