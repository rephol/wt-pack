#!/bin/sh
# Hand a prompt to a herdr agent, instead of the clipboard.
#
#   handoff.sh --list <cwd>                              # free workers, one per line
#   handoff.sh [--pane <id>|--new] [--role worker|planner|reviewer] [--pr N --sha X] [--clear] [--no-goal] [--task "<TICKET> <title>"] [--mcp a,b] [--kind k] [--from name] [--dry-run] <cwd> [prompt-file]
#   handoff.sh --reply <pane> ["text"]                   # answer a wt-message (text or stdin), kind=reply
#
# WP-104: every prompt goes out wrapped as <wt-message id=… kind=handoff|dispatch|routine|reply|system from="…"
# [ticket=…]>…</wt-message> (skills/wt-shared/scripts/wt-message.mjs), so the target knows it is wt-pack traffic,
# not its user. --kind (default handoff) and --from (default: the sender's agent name) are for server callers.
#
# Handoff agents live in their own herdr workspace, "<repo>-workers" (override
# with HANDOFF_WORKSPACE), created on demand. That workspace IS the pool: an
# agent is eligible when it is in there, FREE (idle or done — a worker that
# finished a job reports "done", not "idle"), and sitting in the main checkout
# of <cwd>'s repo. Panes in your own project workspace are never touched, and
# neither is a worker parked inside a worktree — that is work already in flight.
#
# --list prints "<pane-id>\t<tab label>\t<cwd>" per candidate, so the caller can
# offer the choice instead of guessing. --clear sends /clear to the chosen agent
# first. NOTE: /clear drops the conversation, but a SessionStart memory hook
# (claude-mem here) re-injects project context right after — so treat --clear as
# "drop this thread", not as amnesia.
#
# --mcp a,b is passed to `agents.sh spawn` when a new worker is created (servers from
# skills/wt-agents/mcp/catalog.json); a reused worker keeps the MCP set it started with.
# Without --mcp (and without --pane), Jev picks them from the prompt (jev-mcp.mjs: one yes/no per
# catalog server, kept at >= 0.7, 2s timeout, any failure = no picks). A free worker is reused only if
# it already has every pick; otherwise a new one is spawned with them. WT_HANDOFF_JEV=off skips Jev;
# so does full MCP mode (the default: skills/wt-shared/scripts/mcp-mode.sh), where every worker has every server.
# --dry-run prints the target and the picks, and sends, tags and spawns nothing.
#
# Routing (auto mode, no --role): with WT_JEV_ROUTE on (default; env or the dashboard's Settings switch), Jev
# judges whether the prompt needs a plan first (jev-route.mjs, >= 0.75, WT_JEV_ROUTE_MIN); if so the target is a
# planner from "<repo>-planners" (reused if free, else spawned in the main checkout), and "route: planner (p=…)"
# is printed after the target lines. A prompt starting "Use wt-work" (wt-plan's own handoff) is never re-routed.
# --role worker|planner forces the role (also with --new). --pane and --list are untouched.
#
# --task labels the target pane (herdr token `task`, shown by wt-dashboard); without it the
# ticket is taken from <cwd>'s branch (ENG-123 or WP-12). Both panes are told about each other through
# tokens (target: task, ticket, handoff_from[_pane], handoff_at; sender: handoff_to[_pane]), and
# the prompt gets a footer naming the sender so the target can answer it.
#
# Prints "reused <pane>" or "created <label> <pane>" on the FIRST line (callers parse it), then
# "target <name> <pane>" and the command that reaches it. Exits non-zero without
# prompting if claude never came up, so the caller can fall back to printing the
# prompt for a human to paste.
set -eu

mode=auto
role=
pane_arg=
clear=0
kind=handoff
from_arg=
reply=
PANE_RE='^[A-Za-z0-9:_][A-Za-z0-9:_-]*$'
WTMSG="$(cd "$(dirname "$0")" && pwd)/../../wt-shared/scripts/wt-message-cli.mjs"
# WP-122: the path the target runs to reply — this install's own handoff.sh (symlinks or the plugin cache).
SELF="$(cd "$(dirname "$0")" && pwd -P)/handoff.sh"
goal=1
task=
mcp=
pr=
sha=
dry=0
while :; do
  case "${1:-}" in
    -h|--help) sed -n "2,/^[^#]/{/^#/s/^# \{0,1\}//p;}" "$0"; exit 0 ;;
    --list)  mode=list; shift ;;
    --new)   mode=new; shift ;;
    --clear) clear=1; shift ;;
    --pane)  pane_arg=$2; mode=pane; shift 2
             printf '%s' "$pane_arg" | grep -qE "$PANE_RE" || { echo "--pane: bad pane id" >&2; exit 2; } ;;
    --reply) reply=$2; shift 2
             printf '%s' "$reply" | grep -qE "$PANE_RE" || { echo "--reply: bad pane id" >&2; exit 2; } ;;
    --kind)  kind=$2; shift 2
             case "$kind" in handoff|dispatch|routine|reply|system) ;; *) echo "--kind: handoff, dispatch, routine, reply or system" >&2; exit 2 ;; esac ;;
    --from)  from_arg=$2; shift 2 ;;
    --no-goal) goal=0; shift ;;
    --task)  task=$2; shift 2 ;;
    --role)  role=$2; shift 2
             case "$role" in worker|planner|reviewer) ;; *) echo "--role: worker, planner or reviewer" >&2; exit 2 ;; esac ;;
    --pr)    pr=$2; shift 2 ;;   # WP-121: pr=/sha= on the wt-message (wt-watch-prs dispatch)
    --sha)   sha=$2; shift 2 ;;
    --mcp)   mcp=$2; shift 2 ;;
    --dry-run) dry=1; shift ;;
    *) break ;;
  esac
done



command -v herdr >/dev/null || { echo "herdr not on PATH" >&2; exit 1; }

# Who is sending: $HERDR_PANE_ID may be herdr's stable id, so resolve it to the pane id
# `agent list` uses. Outside herdr there is no sender and no sender-side tokens.
pane_of() { herdr pane get "$1" 2>/dev/null | jq -r '.result.pane.pane_id // empty'; }
name_of() { herdr agent list | jq -r --arg p "$1" '.result.agents[] | select(.pane_id == $p) | .name // empty' | head -1; }

# --reply: a plain answer to whoever sent us a wt-message — no /goal, no tokens, no worker selection.
if [ -n "$reply" ]; then
  text=${1:-}
  [ -n "$text" ] || { [ -t 0 ] && { echo "--reply <pane> \"text\" (or text on stdin)" >&2; exit 2; }; text=$(cat); }
  [ -n "$text" ] || { echo "--reply: no text" >&2; exit 2; }
  me=$( [ -n "${HERDR_PANE_ID:-}" ] && pane_of "$HERDR_PANE_ID" || true)
  nm=$( [ -n "$me" ] && name_of "$me" || true)
  msg=$(printf '%s' "$text" | node "$WTMSG" --kind reply --from "${from_arg:-${nm:-${me:-wt-handoff}}}") || { echo "wt-message wrap failed" >&2; exit 1; }
  [ "$dry" -eq 1 ] && { echo "dry-run: would reply to $reply"; echo "send: $msg"; exit 0; }
  herdr agent prompt "$reply" "$msg" >/dev/null
  echo "replied $reply"
  exit 0
fi

cwd=$1
[ "$mode" = list ] || prompt=$(cat "${2:-/dev/stdin}")
[ -d "$cwd" ] || { echo "no such directory: $cwd" >&2; exit 1; }

# The main checkout of this repo: a worktree's git-common-dir points back at the
# main .git, so this resolves to the same path from a worktree or from the
# checkout itself.
main_checkout=$(dirname "$(git -C "$cwd" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" 2>/dev/null || echo "")

ws_label=${HANDOFF_WORKSPACE:-$(basename "${main_checkout:-$cwd}")-workers}

# Resolve the worker workspace, creating it on first use. Never focus it: the
# point is that work lands somewhere out of the way, not that it steals the view.
worker_ws() {
  id=$(herdr workspace list \
    | jq -r --arg l "$ws_label" '.result.workspaces[] | select(.label == $l) | .workspace_id' \
    | head -1)
  [ -n "$id" ] || [ "$dry" -eq 1 ] || id=$(herdr workspace create --label "$ws_label" --cwd "$main_checkout" --no-focus \
    | jq -r '.result.workspace.workspace_id')
  echo "$id"
}

# Every free agent (idle or done) whose own toplevel IS that main checkout, as
# "<pane-id>\t<tab label>\t<cwd>".
candidates() {
  [ -n "$main_checkout" ] || return 0
  tab=$(printf '\t')
  ws=$(worker_ws)
  herdr agent list \
    | jq -r --arg ws "$ws" '.result.agents[] | select(.agent_status == "idle" or .agent_status == "done") | select(.workspace_id == $ws) | .pane_id + "\t" + .tab_id + "\t" + .cwd' \
    | while read -r line; do
        # Parameter expansion, not IFS+read: a two-field read splits on the
        # shell's IFS, and getting that wrong silently leaves the cwd empty —
        # which makes `git -C ""` answer for the CURRENT directory and every
        # agent look eligible.
        # Target by PANE ID, not name: an agent started by hand rather than by
        # `herdr agent start <name>` has an empty name, and most do.
        id=${line%%"$tab"*}
        rest=${line#*"$tab"}
        tid=${rest%%"$tab"*}
        acwd=${rest#*"$tab"}
        [ -n "$id" ] && [ -n "$acwd" ] && [ "$acwd" != "$rest" ] || continue
        [ -d "$acwd" ] || continue
        top=$(git -C "$acwd" rev-parse --show-toplevel 2>/dev/null) || continue
        [ "$top" = "$main_checkout" ] || continue
        tlabel=$(herdr tab get "$tid" 2>/dev/null | jq -r '.result.tab.label // "?"')
        printf '%s\t%s\t%s\n' "$id" "$tlabel" "$acwd"
      done
}

[ "$mode" = list ] && { candidates; exit 0; }

# MCP picks from Jev (before the footer is added: it judges the task, not the routing).
jev=
# Only in lean mode: a full-set worker already has every server, so there is nothing to pick.
if [ -z "$mcp" ] && [ "$mode" != pane ] && [ "${WT_HANDOFF_JEV:-on}" != off ] && [ "${role:-worker}" = worker ] \
  && [ "$("$(dirname "$0")/../../wt-shared/scripts/mcp-mode.sh" --cwd "${main_checkout:-$cwd}")" = lean ]; then
  jev=$(printf '%s' "$prompt" | node "$(dirname "$0")/jev-mcp.mjs" 2>/dev/null || true)
  mcp=$(printf '%s' "$jev" | jq -r '(.picks // []) | join(",")' 2>/dev/null || true)
fi
# Worker or planner? Decided before the footer (Jev judges the request, not the routing) and before any reuse,
# because reuse is restricted to the chosen role's pool.
routed=
if [ -z "$role" ] && [ "$mode" = auto ]; then
  case "$prompt" in
    "Use wt-work"*|"/goal Use wt-work"*) role=worker ;;
    *) r=$(printf "%s" "$prompt" | node "$(dirname "$0")/jev-route.mjs" 2>/dev/null || true)
       role=$(printf '%s' "$r" | jq -r '.role // "worker"' 2>/dev/null || echo worker)
       p=$(printf '%s' "$r" | jq -r '.p // empty' 2>/dev/null || true)
       [ -n "$p" ] && routed="route: $role (p=$p)" ;;
  esac
fi
role=${role:-worker}
# Every role but worker has its own pool "<repo>-<role>s" and starts in the main checkout (as `agents.sh spawn
# <role>` does): a planner makes its own worktree, a reviewer (WP-121) reviews by SHA without one.
[ "$role" = worker ] || ws_label=${HANDOFF_WORKSPACE:-$(basename "${main_checkout:-$cwd}")-${role}s}
spawn_cwd=$cwd
[ "$role" = worker ] || [ -z "$main_checkout" ] || spawn_cwd=$main_checkout

# A worker has the picks if it runs the full set (no lean config) or its config lists them all.
has_picks() {
  [ -n "$mcp" ] || return 0
  f=${XDG_CACHE_HOME:-$HOME/.cache}/wt-agents/mcp-$1.json
  [ -f "$f" ] || return 0
  jq -e --arg p "$mcp" '($p | split(",")) - (.mcpServers | keys) == []' "$f" >/dev/null 2>&1
}

hand_to() {
  # /clear is the user's call, never a default: a reused agent's prior context
  # can be exactly what makes it the right one to continue in.
  if [ "$clear" -eq 1 ]; then
    herdr agent prompt "$1" "/clear" >/dev/null || true
    sleep 2
  fi
  herdr agent prompt "$1" "$send" >/dev/null
}

from_pane=$( [ -n "${HERDR_PANE_ID:-}" ] && pane_of "$HERDR_PANE_ID" || true)
from_name=$( [ -n "$from_pane" ] && name_of "$from_pane" || true)
[ -n "$from_pane" ] && prompt="$prompt

Handed off by ${from_name:-$from_pane} (pane $from_pane). To reply: $SELF --reply $from_pane \"...\""

# The task label starts with the ticket when there is one, and is cut to herdr's 80 characters here.
# A ticket is <TEAM>-N for a Linear team in WT_LINEAR_TEAMS (~/.config/wt-dashboard/env) or <KEY>-N for a local
# board key (wt-ticket keys; empty when the server is down).
T="$(cd "$(dirname "$0")" && pwd)/../../wt-ticket/scripts/wt-ticket"
teams=$(sed -n 's/^[[:space:]]*WT_LINEAR_TEAMS=//p' "$HOME/.config/wt-dashboard/env" 2>/dev/null | tail -1 | tr -d '"' | tr ',' '\n' \
  | sed 's/=.*//; s/[[:space:]]//g' | grep -E '^[A-Za-z][A-Za-z0-9]*$' | tr '\n' '|' || true)
keys=$( [ -x "$T" ] && "$T" keys 2>/dev/null | tr '\n' '|' || true)
ticket=$(printf '%s\n%s\n' "$task" "$(git -C "$cwd" rev-parse --abbrev-ref HEAD 2>/dev/null)" \
  | { all="$teams$keys"; [ -n "$all" ] && grep -oiE "(^|[^a-z])(${all%|})-[0-9]+" || true; } | grep -oiE '[a-z]+-[0-9]+$' | head -1 | tr '[:lower:]' '[:upper:]' || true)
# A Linear ticket has no local card to move.
local_ticket=$ticket; case "|$(printf '%s' "$teams" | tr '[:lower:]' '[:upper:]')" in *"|${ticket%%-*}|"*) local_ticket= ;; esac
case "$(printf '%s' "$task" | tr '[:lower:]' '[:upper:]')" in
  "$ticket"*) ;;
  *) task=$(printf '%s %s' "$ticket" "$task" | sed 's/^ *//; s/ *$//') ;;
esac
task=$(printf '%.80s' "$task")

# Wrap once, before the goal/no-goal split (so --no-goal is tagged too); a failed wrap never sends untagged.
prompt=$(printf '%s' "$prompt" | node "$WTMSG" --kind "$kind" --from "${from_arg:-${from_name:-${from_pane:-wt-handoff}}}" ${ticket:+--ticket "$ticket"} ${pr:+--pr "$pr"} ${sha:+--sha "$sha"}) \
  || { echo "wt-message wrap failed" >&2; exit 1; }

# The goal IS the directive: setting one starts a turn with the condition as the
# instruction, so this is a single message, not a prompt followed by a goal.
# A slash command must be ONE line — a multi-line /goal is silently treated as an
# ordinary prompt and no goal is set — so the prompt is flattened, and the 4000
# character cap is checked here (after the footer) rather than letting the command be rejected.
if [ "$goal" -eq 1 ]; then
  flat=$(printf '%s' "$prompt" | tr '\n' ' ' | tr -s ' ')
  if [ "$(printf '%s' "$flat" | wc -c)" -gt 4000 ]; then
    echo "goal condition is over Claude Code's 4000-character cap" >&2
    exit 1
  fi
  send="/goal $flat"
else
  send=$prompt
fi

# Display-only tokens under the source wt-dashboard reads (best effort: an older herdr has no
# report-metadata). handoff_at tells the dashboard these are newer than its mirrored ticket.
tag() { p=$1; shift; herdr pane report-metadata "$p" --source wt-dashboard "$@" >/dev/null 2>&1 || true; }
finish() {  # <first output line> <target pane>
  to=$(pane_of "$2"); to=${to:-$2}
  to_name=$(name_of "$to")
  set -- "$1" "$to" --token "handoff_at=$(date +%s)"
  [ -n "$task" ] && set -- "$@" --token "task=$task"
  [ -n "$ticket" ] && set -- "$@" --token "ticket=$ticket"
  [ -n "$from_pane" ] && set -- "$@" --token "handoff_from=${from_name:-$from_pane}" --token "handoff_from_pane=$from_pane"
  line=$1; shift
  tag "$@"
  [ -n "$from_pane" ] && tag "$from_pane" --token "handoff_to=${to_name:-$to}" --token "handoff_to_pane=$to"
  # A planner handing its plan over: its task label moves on to "handed to <worker>".
  if [ -n "$from_pane" ] && [ "$(herdr pane get "$from_pane" 2>/dev/null | jq -r '.result.pane.tokens.role // empty')" = planner ]; then
    tag "$from_pane" --token "task_state=handed to ${to_name:-$to}"
  fi
  # A local board ticket handed to a worker moves to Building, assigned to it (never blocks the handoff).
  if [ -n "$local_ticket" ] && [ "$role" = worker ]; then
    if [ -x "$T" ]; then "$T" move "$local_ticket" building >/dev/null || true; [ -n "$to_name" ] && { "$T" assign "$local_ticket" "$to_name" >/dev/null || true; }
    else echo "wt-ticket missing" >&2; fi
  fi
  echo "$line"
  echo "target ${to_name:-?} $to${task:+ — $task}"
  echo "reach: $SELF --reply $to \"...\""
  [ -z "$routed" ] || echo "$routed"
}

dry() {  # <what would happen>
  echo "dry-run: $1"
  echo "send: $send"
  echo "ticket=${ticket:-none}"
  [ -n "$local_ticket" ] && [ "$role" = worker ] && echo "board: would move $local_ticket building + assign the worker"
  echo "mcp: ${mcp:-none}${jev:+ (jev: $jev)}"
  [ -z "$routed" ] || echo "$routed"
  exit 0
}

if [ "$mode" = pane ]; then
  [ "$dry" -eq 1 ] && dry "would hand to pane $pane_arg"
  hand_to "$pane_arg"
  finish "reused $pane_arg" "$pane_arg"
  exit 0
fi

if [ "$mode" = auto ]; then
  reuse=$(candidates | while IFS= read -r c; do p=${c%%"$(printf '\t')"*}; has_picks "$(name_of "$p")" && { echo "$p"; break; }; done)
  if [ -n "$reuse" ]; then
    [ "$dry" -eq 1 ] && dry "would reuse $role $(name_of "$reuse") ($reuse)"
    hand_to "$reuse"
    finish "reused $reuse" "$reuse"
    exit 0
  fi
fi

[ "$dry" -eq 1 ] && dry "would spawn a $role in $spawn_cwd${mcp:+ with --mcp $mcp}"
# Spawning, the numbering and the naming all live in agents.sh, so the pool has
# one definition of what a worker is called. It names the repo from $PWD, so run it from the target.
created=$(cd "$spawn_cwd" && "$(cd "$(dirname "$0")" && pwd)/../../wt-agents/scripts/agents.sh" spawn "$role" "$spawn_cwd" ${mcp:+--mcp "$mcp"})
label=${created%% *}
pane=${created##* }

clear=0   # a fresh agent has nothing to clear
hand_to "$pane"
finish "created $label $pane" "$pane"
