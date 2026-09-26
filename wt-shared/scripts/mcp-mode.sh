#!/bin/sh
# Prints how agents get their MCP servers: "lean" (per-role set, --strict-mcp-config, Jev picks at handoff)
# or "full" (claude's normal set). $WT_AGENTS_MCP wins; else WT_AGENTS_MCP= in ~/.config/wt-dashboard/env
# (the dashboard's Settings switch); else full.
m=${WT_AGENTS_MCP:-$(sed -n 's/^[[:space:]]*\(export[[:space:]]\{1,\}\)\{0,1\}WT_AGENTS_MCP=//p' "${WT_DASHBOARD_ENV:-$HOME/.config/wt-dashboard/env}" 2>/dev/null | tail -1 | tr -d "\"' ")}
[ "$m" = lean ] && echo lean || echo full
