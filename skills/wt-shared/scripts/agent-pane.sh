#!/bin/sh
# WP-348: the dashboard's agents-table row for an agent, by name or pane id. Source it, then:
#   agent_row <name|pane>   # prints {name,pane,state,session,cwd,role,project,...}; nothing when the dashboard is down or has no row
#   agent_state <name|pane> # prints running|idle|paused|exited|missing, or nothing
# Callers fall back to herdr when this prints nothing (the dashboard being down must not stop a handoff).
agent_row() {
  curl -fsS --max-time 2 ${HERDR_PANE_ID:+-H "x-herdr-pane: $HERDR_PANE_ID"} ${WT_PANE_KEY:+-H "x-wt-pane-key: $WT_PANE_KEY"} \
    "${HERDR_DASH_URL:-http://127.0.0.1:7777}/api/agents/by-name/$(printf %s "$1" | jq -sRr @uri)" 2>/dev/null
}
# agent_paused_in_team <team> <persona-or-role>: how many PAUSED agents the dashboard holds for that team seat (they have no pane, so a pane count misses them)
agent_paused_in_team() {
  _n=$(curl -fsS --max-time 2 ${HERDR_PANE_ID:+-H "x-herdr-pane: $HERDR_PANE_ID"} ${WT_PANE_KEY:+-H "x-wt-pane-key: $WT_PANE_KEY"} \
    "${HERDR_DASH_URL:-http://127.0.0.1:7777}/api/agents" 2>/dev/null \
    | jq --arg t "$1" --arg p "$2" '[.[]? | select(.state == "paused" and .tags.team == $t and (.tags.persona // .tags.role) == $p)] | length' 2>/dev/null)
  case "$_n" in ''|*[!0-9]*) echo 0 ;; *) echo "$_n" ;; esac # always a number: the dashboard being down counts as none
}
agent_state() { agent_row "$1" | jq -r '.state // empty' 2>/dev/null; }
