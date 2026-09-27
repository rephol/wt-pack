#!/bin/sh
# Prints how agents get their MCP servers: "lean" (per-role set, --strict-mcp-config, Jev picks at handoff)
# or "full" (claude's normal set). $WT_AGENTS_MCP wins; else, with --cwd DIR, that project's own setting
# (dashboard Settings › Projects, WP-107); else WT_AGENTS_MCP= in ~/.config/wt-dashboard/env (the global
# Settings switch); else full.
p=
[ "$1" = --cwd ] && [ -n "$2" ] && p=$(node "$(dirname "$0")/project-setting.mjs" get WT_AGENTS_MCP --cwd "$2" 2>/dev/null)
m=${WT_AGENTS_MCP:-${p:-$(sed -n 's/^[[:space:]]*\(export[[:space:]]\{1,\}\)\{0,1\}WT_AGENTS_MCP=//p' "${WT_DASHBOARD_ENV:-$HOME/.config/wt-dashboard/env}" 2>/dev/null | tail -1 | tr -d "\"' ")}}
[ "$m" = lean ] && echo lean || echo full
