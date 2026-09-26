#!/bin/sh
# Hand a prompt to a herdr agent, instead of the clipboard.
#
#   handoff.sh --list <cwd>                              # free workers, one per line
#   handoff.sh [--pane <id>|--new] [--clear] [--no-goal] [--task "<TICKET> <title>"] [--mcp a,b] <cwd> [prompt-file]
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
# wt-agents/mcp/catalog.json); a reused worker keeps the MCP set it started with.
#
# --task labels the target pane (herdr token `task`, shown by wt-dashboard); without it the
# ticket is taken from <cwd>'s branch (UMK-NNN). Both panes are told about each other through
# tokens (target: task, ticket, handoff_from[_pane], handoff_at; sender: handoff_to[_pane]), and
# the prompt gets a footer naming the sender so the target can answer it.
#
# Prints "reused <pane>" or "created <label> <pane>" on the FIRST line (callers parse it), then
# "target <name> <pane>" and the command that reaches it. Exits non-zero without
# prompting if claude never came up, so the caller can fall back to printing the
# prompt for a human to paste.
set -eu

mode=auto
pane_arg=
clear=0
goal=1
task=
mcp=
while :; do
  case "${1:-}" in
    --list)  mode=list; shift ;;
    --new)   mode=new; shift ;;
    --clear) clear=1; shift ;;
    --pane)  pane_arg=$2; mode=pane; shift 2 ;;
    --no-goal) goal=0; shift ;;
    --task)  task=$2; shift 2 ;;
    --mcp)   mcp=$2; shift 2 ;;
    *) break ;;
  esac
done



command -v herdr >/dev/null || { echo "herdr not on PATH" >&2; exit 1; }

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
  [ -n "$id" ] || id=$(herdr workspace create --label "$ws_label" --cwd "$main_checkout" --no-focus \
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

hand_to() {
  # /clear is the user's call, never a default: a reused agent's prior context
  # can be exactly what makes it the right one to continue in.
  if [ "$clear" -eq 1 ]; then
    herdr agent prompt "$1" "/clear" >/dev/null || true
    sleep 2
  fi
  herdr agent prompt "$1" "$send" >/dev/null
}

# Who is sending: $HERDR_PANE_ID may be herdr's stable id, so resolve it to the pane id
# `agent list` uses. Outside herdr there is no sender and no sender-side tokens.
pane_of() { herdr pane get "$1" 2>/dev/null | jq -r '.result.pane.pane_id // empty'; }
name_of() { herdr agent list | jq -r --arg p "$1" '.result.agents[] | select(.pane_id == $p) | .name // empty' | head -1; }
from_pane=$( [ -n "${HERDR_PANE_ID:-}" ] && pane_of "$HERDR_PANE_ID" || true)
from_name=$( [ -n "$from_pane" ] && name_of "$from_pane" || true)
[ -n "$from_pane" ] && prompt="$prompt

Handed off by ${from_name:-$from_pane} (pane $from_pane). To reach it: herdr agent prompt $from_pane \"...\""

# The task label starts with the ticket when there is one, and is cut to herdr's 80 characters here.
ticket=$(printf '%s\n%s\n' "$task" "$(git -C "$cwd" rev-parse --abbrev-ref HEAD 2>/dev/null)" \
  | grep -oiE 'umk-[0-9]+' | head -1 | tr '[:lower:]' '[:upper:]' || true)
case "$(printf '%s' "$task" | tr '[:lower:]' '[:upper:]')" in
  "$ticket"*) ;;
  *) task=$(printf '%s %s' "$ticket" "$task" | sed 's/^ *//; s/ *$//') ;;
esac
task=$(printf '%.80s' "$task")

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
  echo "$line"
  echo "target ${to_name:-?} $to${task:+ — $task}"
  echo "reach: herdr agent prompt $to \"...\""
}

if [ "$mode" = pane ]; then
  hand_to "$pane_arg"
  finish "reused $pane_arg" "$pane_arg"
  exit 0
fi

if [ "$mode" = auto ]; then
  reuse=$(candidates | head -1 | cut -f1)
  if [ -n "$reuse" ]; then
    hand_to "$reuse"
    finish "reused $reuse" "$reuse"
    exit 0
  fi
fi

# Spawning, the numbering and the naming all live in agents.sh, so the pool has
# one definition of what a worker is called.
created=$("$(dirname "$0")/../../wt-agents/scripts/agents.sh" spawn worker "$cwd" ${mcp:+--mcp "$mcp"})
label=${created%% *}
pane=${created##* }

clear=0   # a fresh agent has nothing to clear
hand_to "$pane"
finish "created $label $pane" "$pane"
