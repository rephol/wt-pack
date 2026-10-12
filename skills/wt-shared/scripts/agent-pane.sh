#!/bin/sh
# WP-348: the dashboard's agents-table row for an agent, by name or pane id. Source it, then:
#   agent_row <name|pane>   # prints {name,pane,state,session,cwd,role,project,...}; nothing when the dashboard is down or has no row
#   agent_state <name|pane> # prints running|idle|paused|exited|missing, or nothing
# Callers fall back to herdr when this prints nothing (the dashboard being down must not stop a handoff).
agent_row() {
  curl -fsS --max-time 2 ${HERDR_PANE_ID:+-H "x-herdr-pane: $HERDR_PANE_ID"} ${WT_PANE_KEY:+-H "x-wt-pane-key: $WT_PANE_KEY"} \
    "${HERDR_DASH_URL:-http://127.0.0.1:7777}/api/agents/by-name/$1" 2>/dev/null
}
agent_state() { agent_row "$1" | jq -r '.state // empty' 2>/dev/null; }
