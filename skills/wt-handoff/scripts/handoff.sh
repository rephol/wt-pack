#!/bin/sh
# Hand a prompt to a herdr agent, instead of the clipboard.
#
#   handoff.sh --list <cwd>                              # free workers, one per line
#   handoff.sh [--pane <id>|--new] [--role worker|planner|reviewer] [--persona <name>] [--team <name>] [--pr N --sha X] [--clear] [--no-goal] [--task "<TICKET> <title>"] [--mcp a,b] [--skill name] [--kind k] [--from name] [--dry-run] <cwd> [prompt-file]
#   handoff.sh ... [--request-id <id>] ...               # WP-251: a repeat of the same id prints the first run's output and sends nothing
#   handoff.sh --reply <pane> ["text"]                   # answer a wt-message (text or stdin), kind=reply
#   handoff.sh --cancel <pane|name> ["why"]               # stop a /goal-driven agent: escape, end its goal,
#                                                          # clear task/ticket tokens, return its card if assigned
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
# --skill names the caller's own skill for model routing (WP-129: routing/tuning stats key
# on this, not a guess scraped from the task text); without it, routing sees "wt-handoff".
#
# WP-143: a routed hand-off reuses a free worker only when its `model`/`effort` pane tokens already match the
# picked tier (else a fresh one is spawned on it). WT_WORKERS_MAX (project setting or env, worker role only) caps
# the pool: at the cap, exits 3 with "pool full: <n>/<cap> workers in <repo>" and sends nothing (no queue —
# dispatch's card stays in Ready and retries later).
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
persona=
team=
pane_arg=
clear=0
kind=handoff
from_arg=
reply=
cancel=
PANE_RE='^[A-Za-z0-9:_][A-Za-z0-9:_-]*$'
WTMSG="$(cd "$(dirname "$0")" && pwd)/../../wt-shared/scripts/wt-message-cli.mjs"
# WP-122: the path the target runs to reply — this install's own handoff.sh (symlinks or the plugin cache).
SELF="$(cd "$(dirname "$0")" && pwd -P)/handoff.sh"
goal=1
task=
mcp=
pr=
sha=
skill=
dry=0
buddy_arg=
request_id=
RECEIPTS="$(dirname "$0")/../../wt-shared/scripts/receipts.mjs"
ack_id=; ack_state=acknowledged
# WP-257: write the envelope to the dashboard's message record (best effort: never blocks or fails a send).
# A server-run handoff proves itself with its token, an agent with its pane id (like /api/deliveries).
record_message() { # <pane> <text> <state>
  command -v curl >/dev/null && command -v jq >/dev/null || return 0
  [ -n "${deliver_token:-}${HERDR_PANE_ID:-}" ] || return 0
  jq -n --arg p "$1" --arg t "$2" --arg s "$3" --arg r "$request_id" '{target:$p,body:$t,state:$s} + (if $r == "" then {} else {requestId:$r} end)' \
    | curl -sS --max-time 3 -X POST -H "$( [ -n "${deliver_token:-}" ] && echo "x-wt-server: $deliver_token" || echo "x-herdr-pane: ${HERDR_PANE_ID:-}")" \
      -H 'content-type: application/json' --data @- "${HERDR_DASH_URL:-http://127.0.0.1:7777}/api/messages" >/dev/null 2>&1 || true
}
while :; do
  case "${1:-}" in
    -h|--help) sed -n "2,/^[^#]/{/^#/s/^# \{0,1\}//p;}" "$0"; exit 0 ;;
    --list)  mode=list; shift ;;
    --new)   mode=new; shift ;;
    --clear) clear=1; shift ;;
    --pane)  pane_arg=$2; mode=pane; shift 2
             printf '%s' "$pane_arg" | grep -qE "$PANE_RE" || { echo "--pane: bad pane id" >&2; exit 2; } ;;
    --ack) ack_id=$2; shift 2 ;;   # WP-257: acknowledge a wt-message by its id (add --answered once it is dealt with)
    --answered) ack_state=answered; shift ;;
    --reply) reply=$2; shift 2
             printf '%s' "$reply" | grep -qE "$PANE_RE" || { echo "--reply: bad pane id" >&2; exit 2; } ;;
    --cancel) cancel=$2; shift 2
             printf '%s' "$cancel" | grep -qE "$PANE_RE" || { echo "--cancel: bad pane id or name" >&2; exit 2; } ;;
    --kind)  kind=$2; shift 2
             case "$kind" in handoff|dispatch|routine|reply|system) ;; *) echo "--kind: handoff, dispatch, routine, reply or system" >&2; exit 2 ;; esac ;;
    --from)  from_arg=$2; shift 2 ;;
    --no-goal) goal=0; shift ;;
    --task)  task=$2; shift 2 ;;
    --role)  role=$2; shift 2
             case "$role" in worker|planner|reviewer) ;; *) echo "--role: worker, planner or reviewer" >&2; exit 2 ;; esac ;;
    --persona) persona=$2; shift 2   # WP-204: only agents tagged persona=<name>, or a spawn of that persona
             printf '%s' "$persona" | grep -qE '^[a-z][a-z0-9-]{0,23}$' || { echo "--persona: a name like frontend-worker" >&2; exit 2; } ;;
    --team)  team=$2; shift 2   # WP-238: only agents tagged team=<name> (a plain handoff skips team agents), spawns join it
             printf '%s' "$team" | grep -qE '^[a-z][a-z0-9-]{0,23}$' || { echo "--team: a team name like web" >&2; exit 2; } ;;
    --pr)    pr=$2; shift 2 ;;   # WP-121: pr=/sha= on the wt-message (wt-watch-prs dispatch)
    --sha)   sha=$2; shift 2 ;;
    --mcp)   mcp=$2; shift 2 ;;
    --skill) skill=$2; shift 2 ;;   # WP-129: the caller's own skill name, for routing/tuning stats
    --dry-run) dry=1; shift ;;
    --request-id) request_id=$2; shift 2 ;;   # WP-251
    --buddy) buddy_arg=$2; shift 2 ;;   # WP-147: pane id, or "self" for the sending pane

    *) break ;;
  esac
done



# WP-251: a repeated request id returns the earlier output (a lost Enter, a restart, Dispatch re-evaluating a card).
[ -z "$request_id" ] || [ "$dry" -eq 1 ] || ! node "$RECEIPTS" get "$request_id" 2>/dev/null || exit 0

command -v herdr >/dev/null || { echo "herdr not on PATH" >&2; exit 1; }

# Who is sending: $HERDR_PANE_ID may be herdr's stable id, so resolve it to the pane id
# `agent list` uses. Outside herdr there is no sender and no sender-side tokens.
pane_of() { herdr pane get "$1" 2>/dev/null | jq -r '.result.pane.pane_id // empty'; }
name_of() { herdr agent list | jq -r --arg p "$1" '.result.agents[] | select(.pane_id == $p) | .name // empty' | head -1; }
pane_of_name() { herdr agent list | jq -r --arg n "$1" '.result.agents[] | select(.name == $n) | .pane_id' | head -1; }

# --ack <id> [--answered]: tell the dashboard this agent has the message (WP-257). Needs a pane (HERDR_PANE_ID).
if [ -n "$ack_id" ]; then
  case "$ack_id" in *[!A-Za-z0-9_-]*) echo "--ack: bad id" >&2; exit 2 ;; esac
  [ -n "${HERDR_PANE_ID:-}" ] || { echo "--ack needs a herdr pane (HERDR_PANE_ID)" >&2; exit 2; }
  curl -sS --max-time 5 -X POST -H "x-herdr-pane: $HERDR_PANE_ID" -H 'content-type: application/json' \
    --data "$(jq -n --arg s "$ack_state" '{state:$s}')" "${HERDR_DASH_URL:-http://127.0.0.1:7777}/api/messages/$ack_id/ack" | jq -r 'if .error then "ack failed: " + .error else "\(.id) \(.state)" end'
  exit 0
fi

# --reply: a plain answer to whoever sent us a wt-message — no /goal, no tokens, no worker selection.
if [ -n "$reply" ]; then
  text=${1:-}
  [ -n "$text" ] || { [ -t 0 ] && { echo "--reply <pane> \"text\" (or text on stdin)" >&2; exit 2; }; text=$(cat); }
  [ -n "$text" ] || { echo "--reply: no text" >&2; exit 2; }
  me=$( [ -n "${HERDR_PANE_ID:-}" ] && pane_of "$HERDR_PANE_ID" || true)
  nm=$( [ -n "$me" ] && name_of "$me" || true)
  msg=$(printf '%s' "$text" | node "$WTMSG" --kind reply --from "${from_arg:-${nm:-${me:-wt-handoff}}}") || { echo "wt-message wrap failed" >&2; exit 1; }
  [ "$dry" -eq 1 ] && { echo "dry-run: would reply to $reply"; echo "send: $msg"; exit 0; }
  # WP-210: a target whose wt-deliver-mod is live takes the reply through the dashboard queue (the mod submits it as a
  # prompt); any failure, or a pane without the mod, pastes as before. Only a pane-identified sender can ask.
  if [ -n "${HERDR_PANE_ID:-}" ] && command -v curl >/dev/null; then
    q=$(jq -n --arg p "$reply" --arg t "$msg" '{pane:$p,text:$t}' | curl -sS --max-time 3 -X POST -H "x-herdr-pane: $HERDR_PANE_ID" \
      -H 'content-type: application/json' --data @- "${HERDR_DASH_URL:-http://127.0.0.1:7777}/api/deliveries" 2>/dev/null | jq -r '.queued // false' 2>/dev/null) || q=false
    [ "$q" = true ] && { record_message "$reply" "$msg" queued; echo "replied $reply (queued)"; exit 0; }
  fi
  herdr agent prompt "$reply" "$msg" >/dev/null
  record_message "$reply" "$msg" delivered
  echo "replied $reply"
  exit 0
fi

# --cancel: stop a /goal-driven agent for real. A herdr /goal keeps the agent working toward its
# condition regardless of what's typed at it (WP-131 incident: told to stop, kept going) — so this
# escapes whatever it's mid-doing, then ends the goal itself, verifying that the agent actually went
# idle; a goal that doesn't let go (or an agent already blocked past escape) falls back to /clear.
if [ -n "$cancel" ]; then
  why=${1:-}
  case "$cancel" in
    *:*) pane=$(pane_of "$cancel" || true) ;;
    *)   pane= ;;
  esac
  [ -n "$pane" ] || pane=$(pane_of_name "$cancel")
  [ -n "$pane" ] || { echo "--cancel: no such pane or agent: $cancel" >&2; exit 1; }

  [ "$dry" -eq 1 ] && { echo "dry-run: would cancel $cancel ($pane)${why:+: $why}"; exit 0; }

  info=$(herdr pane get "$pane" 2>/dev/null || true)
  task=$(printf '%s' "$info" | jq -r '.result.pane.tokens.task // empty' 2>/dev/null || true)
  ticket=$(printf '%s' "$info" | jq -r '.result.pane.tokens.ticket // empty' 2>/dev/null || true)

  herdr agent send-keys "$pane" esc >/dev/null 2>&1 || true
  if herdr agent prompt "$pane" "/goal clear" --wait --until idle --until done --timeout 8000 >/dev/null 2>&1; then
    cleared="goal cleared"
  elif herdr agent prompt "$pane" "/clear" >/dev/null 2>&1; then
    cleared="goal clear unverified, sent /clear"
  else
    cleared="goal clear unverified, /clear also rejected (agent still blocked?)"
  fi

  herdr pane report-metadata "$pane" --source wt-dashboard --clear-token task --clear-token ticket >/dev/null 2>&1 || true

  T="$(cd "$(dirname "$0")" && pwd)/../../wt-ticket/scripts/wt-ticket"
  board=
  if [ -n "$ticket" ]; then
    if [ -x "$T" ]; then
      row=$("$T" show "$ticket" --json 2>/dev/null) && {
        assignee_pane=$(printf '%s' "$row" | jq -r '.assignee.pane // empty' 2>/dev/null || true)
        if [ "$assignee_pane" = "$pane" ]; then
          "$T" assign "$ticket" none >/dev/null 2>&1 || true
          "$T" move "$ticket" ready --note "cancelled${why:+: $why}" >/dev/null 2>&1 || true
          board="returned $ticket to ready"
        fi
      }
    else
      echo "wt-ticket missing" >&2
    fi
  fi

  name=$(name_of "$pane")
  echo "cancelled ${name:-$pane} ($pane): $cleared${task:+, cleared task=\"$task\"}${board:+, $board}"
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
# "<pane-id>\t<tab label>\t<cwd>\t<model token>\t<effort token>".
candidates() {
  [ -n "$main_checkout" ] || return 0
  tab=$(printf '\t')
  ws=$(worker_ws)
  panes=$(herdr pane list | jq -c '[(.result.panes // [])[] | {key: .pane_id, value: (.tokens // {})}] | from_entries')
  # WP-225: an agent already holding an open card (its assignee, or its task/ticket token names one) is never
  # a candidate. Best-effort: no board (server down, Linear key) → [] and nobody is excluded, as before.
  held=$(cd "$main_checkout" && "$(dirname "$0")/../../wt-ticket/scripts/wt-ticket" list --json 2>/dev/null \
    | jq -c '[.tickets[]? | select(.column != "done") | {id, a: (.assignee.name // "")}]' 2>/dev/null) || held=
  [ -n "$held" ] || held='[]'
  herdr agent list \
    | jq -r --arg ws "$ws" --arg persona "$persona" --arg team "$team" --argjson panes "$panes" \
      '.result.agents[] | select(.agent_status == "idle" or .agent_status == "done") | select(.workspace_id == $ws)
       | . as $a | ($panes[$a.pane_id] // {}) as $t
       | select(($t.dnd // "") == "") | select(($t.pair // "") == "")
       | select(($t.persona // "") == $persona) | select(($t.team // "") == $team)
       | [$a.pane_id, $a.tab_id, $a.cwd, ($t.model // ""), ($t.effort // "")] | @tsv' \
    | while IFS="$tab" read -r id tid acwd amodel aeffort; do
        # Target by PANE ID, not name: an agent started by hand rather than by
        # `herdr agent start <name>` has an empty name, and most do.
        [ -n "$id" ] && [ -n "$acwd" ] || continue
        [ -d "$acwd" ] || continue
        tk=$(printf '%s' "$panes" | jq -r --arg p "$id" '(.[$p].task // .[$p].ticket // "") | split(" ")[0]')
        nm=$(name_of "$id")
        printf '%s' "$held" | jq -e --arg tk "$tk" --arg nm "$nm" \
          'any(.[]; ($tk != "" and .id == $tk) or ($nm != "" and .a == $nm))' >/dev/null && continue
        # WP-221: herdr can still say idle/done after claude exits; the shell back in the foreground means a dead pane.
        herdr pane process-info --pane "$id" 2>/dev/null \
          | jq -e '.result.process_info | .shell_pid != null and .foreground_process_group_id == .shell_pid
            and all(.foreground_processes[]?; (.name // .argv0 // "") | test("^-?(zsh|bash|fish|sh|dash|ksh|tcsh)$"))' >/dev/null && continue
        top=$(git -C "$acwd" rev-parse --show-toplevel 2>/dev/null) || continue
        [ "$top" = "$main_checkout" ] || continue
        tlabel=$(herdr tab get "$tid" 2>/dev/null | jq -r '.result.tab.label // "?"')
        printf '%s\t%s\t%s\t%s\t%s\n' "$id" "$tlabel" "$acwd" "$amodel" "$aeffort"
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
# WP-204: a persona's base role comes from its project-role file when --role is not given.
if [ -n "$persona" ] && [ -z "$role" ]; then
  role=$(node "$(dirname "$0")/../../wt-shared/scripts/roles.mjs" resolve "$persona" --cwd "$cwd" 2>/dev/null | jq -r '.base // empty' 2>/dev/null || true)
  case "$role" in worker|planner|reviewer) ;; *) echo "--persona $persona: no .wt-pack/roles/$persona.md with a worker, planner or reviewer base" >&2; exit 2 ;; esac
elif [ -n "$persona" ]; then
  pbase=$(node "$(dirname "$0")/../../wt-shared/scripts/roles.mjs" resolve "$persona" --cwd "$cwd" 2>/dev/null | jq -r '.base // empty' 2>/dev/null || true)
  [ -z "$pbase" ] || [ "$pbase" = "$role" ] || { echo "--persona $persona is a $pbase, not a $role" >&2; exit 2; }
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

# WP-242: taken once and unset, so the agents this script spawns never inherit it.
deliver_token=${WT_DELIVER_TOKEN:-}; unset WT_DELIVER_TOKEN
# WP-248: a session that has just spawned is still loading its start-up context and drops typed input, so wait until
# it is registered and idle before typing (a missed registration is nudged once with a rename), and after typing
# check the text left the input box (Enter again if not). Env knobs: WT_READY_TIMEOUT s, WT_SUBMIT_SETTLE_MS.
PANE_SUBMIT="$(dirname "$0")/../../wt-shared/scripts/pane-submit.mjs"
fresh=0; fresh_label=
wait_ready() { # <pane>
  node "$PANE_SUBMIT" ready "$1" --timeout "${WT_READY_TIMEOUT:-60}" 2>/dev/null && return 0
  [ -z "$fresh_label" ] || herdr agent rename "$1" "$fresh_label" >/dev/null 2>&1 || true
  node "$PANE_SUBMIT" ready "$1" --timeout "$(( ${WT_READY_TIMEOUT:-60} / 6 ))" 2>/dev/null \
    || echo "warning: $1 not ready after ${WT_READY_TIMEOUT:-60}s, sending anyway" >&2
}
hand_to() {
  # WP-249: a reused agent that never registered (absent from `agent list`) gets the fresh-spawn treatment: renamed
  # to its tab label, then waited on until ready.
  if [ "$fresh" -eq 0 ] && [ -z "$(name_of "$1")" ]; then
    tab_id=$(herdr pane get "$1" 2>/dev/null | jq -r '.result.pane.tab_id // empty')
    fresh_label=$(herdr tab list 2>/dev/null | jq -r --arg t "$tab_id" '.result.tabs[] | select(.tab_id == $t) | .label // empty' | head -1)
    [ -z "$fresh_label" ] || herdr agent rename "$1" "$fresh_label" >/dev/null 2>&1 || true
    fresh=1
  fi
  [ "$fresh" -eq 0 ] || wait_ready "$1"
  # /clear is the user's call, never a default: a reused agent's prior context
  # can be exactly what makes it the right one to continue in.
  if [ "$clear" -eq 1 ]; then
    herdr agent prompt "$1" "/clear" >/dev/null || true
    sleep 2
  fi
  # WP-240/243: herdr's prompt pastes, and so does any long burst of typed text, which Claude Code hands the model as
  # pasted content it will not act on. So the message goes to a mode-600 file and only a SHORT /goal line naming it is
  # typed: no queue, no ordering (a queue only drains between turns, and /goal's Stop hook keeps the turn open).
  if [ "$goal" -eq 1 ] && msgfile=$(save_message) && herdr pane send-text "$1" "$goal_line $msgfile; reporting what it asks for is the goal" >/dev/null 2>&1; then
    sleep 0.4 # an Enter sent in the same instant as the text is dropped
    herdr pane send-keys "$1" enter >/dev/null
  else
    # WP-267: say why the whole message is pasted instead of the short /goal line (it was silent before)
    [ "$goal" -eq 1 ] && echo "warning: could not type the /goal line into $1 (message file or send-text failed): pasting the full message" >&2
    herdr agent prompt "$1" "${send_full:-$send}" >/dev/null
  fi
  node "$PANE_SUBMIT" confirm "$1" --settle "${WT_SUBMIT_SETTLE_MS:-1500}" 2>/dev/null \
    || { echo "prompt not submitted: it is still in the input box of $1" >&2; exit 1; }
}

# WP-243: the wt-message as a file under the dashboard's data dir (7-day prune); prints its path.
save_message() {
  d=${WT_MESSAGES_DIR:-$HOME/.local/share/wt-dashboard/messages}
  id=$(printf '%s' "$send" | sed -n '1s/^<wt-message id=\([^ >]*\).*/\1/p'); id=${id:-$(date +%s)$$}
  (umask 077; mkdir -p "$d" && printf '%s\n' "$send" > "$d/$id.md") || return 1
  find "$d" -name '*.md' -mtime +7 -delete 2>/dev/null || true
  printf '%s' "$d/$id.md"
}

# WP-210 queue: true when the target's wt-deliver-mod is live and took the text (needs a pane-identified sender).
queue_prompt() { # <pane> <text>
  command -v curl >/dev/null || return 1
  # A server-run handoff (Dispatch, routines) has no pane id: it proves itself with the dashboard's private token instead.
  set -- "$1" "$2" -H "$( [ -n "$deliver_token" ] && echo "x-wt-server: $deliver_token" || echo "x-herdr-pane: ${HERDR_PANE_ID:-}")"
  [ -n "$deliver_token${HERDR_PANE_ID:-}" ] || return 1
  [ "$(jq -n --arg p "$1" --arg t "$2" '{pane:$p,text:$t}' | curl -sS --max-time 3 -X POST "$3" "$4" \
    -H 'content-type: application/json' --data @- "${HERDR_DASH_URL:-http://127.0.0.1:7777}/api/deliveries" 2>/dev/null | jq -r '.queued // false' 2>/dev/null)" = true ]
}

task_text=$prompt  # the request itself, before the footer: what model routing judges (WP-128)
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

# WP-147: a follow-up addressed to a paired ticket (--task WP-N, no --pane) goes straight to its pair — the
# worker, or the buddy for a review round (--role reviewer) — instead of picking a free agent.
if [ "$mode" = auto ] && [ -n "$local_ticket" ]; then
  pair_json=$([ -x "$T" ] && "$T" show "$local_ticket" --json 2>/dev/null | jq -c '.pair // empty' 2>/dev/null || true)
  if [ -n "$pair_json" ] && [ "$pair_json" != "null" ]; then
    if [ "$role" = reviewer ]; then pair_pane=$(printf '%s' "$pair_json" | jq -r '.buddy.pane // empty')
    else pair_pane=$(printf '%s' "$pair_json" | jq -r '.worker.pane // empty'); fi
    [ -n "$pair_pane" ] && { mode=pane; pane_arg=$pair_pane; }
  fi
fi

# WP-128 model routing (wt-shared/scripts/model-route.mjs; shadow by default = logged, nothing applied). A ticket
# escalated by dispatch ("routing: escalate opus" in its history) is an explicit tier. Reuse is fine when the free
# worker already runs that tier (its `model`/`effort` pane tokens, WP-143); otherwise a fresh agent spawns with
# --model to get on it.
# WP-137: route_effort rides the same live-only gate as route_tier (an escalated tier still gets its own computed
# effort, not the escalation's — the escalation is a tier override only).
# WP-157: --session — this pick decides a fresh SESSION's own tier (a handoff spawn), so it never lands below
# the session floor (sonnet), unlike a subagent pick (wt-review/wt-research), which may still choose haiku.
route_tier=; route_effort=; route_line=
if [ "$mode" != pane ]; then
  esc=$( [ -n "$local_ticket" ] && [ -x "$T" ] && "$T" show "$local_ticket" --json 2>/dev/null \
    | jq -r '[.history[]? | .text // "" | capture("^routing: escalate (?<t>haiku|sonnet|opus)").t] | last // empty' 2>/dev/null || true)
  r=$(printf '%s' "$task_text" | node "$(dirname "$0")/../../wt-shared/scripts/model-route.mjs" pick --json --skill "${skill:-wt-handoff}" --role "$role" --session \
    ${esc:+--model "$esc"} $([ "$dry" -eq 1 ] && echo --no-log) --cwd "${main_checkout:-$cwd}" 2>/dev/null || true)
  rmode=$(printf '%s' "$r" | jq -r '.mode // "off"' 2>/dev/null || echo off)
  [ "$rmode" = live ] || esc= # an escalation applies only while routing is live
  route_tier=${esc:-$(printf '%s' "$r" | jq -r '.apply // empty' 2>/dev/null || true)}
  [ "$rmode" = live ] && route_effort=$(printf '%s' "$r" | jq -r '.applyEffort // empty' 2>/dev/null || true)
  [ "$rmode" = off ] || route_line=$(printf '%s' "$r" | jq -r '"routing: \(.tier // "none") (\(.mode), \(.source)\(if .ref then ", ref " + .ref else "" end))"' 2>/dev/null || true)
  [ -z "$esc" ] || route_line="routing: $esc (escalated)"
else
  # WP-168: a `--pane`/paired hand-off (dispatch to an already-running worker) skipped routing entirely, so
  # that ticket got no decision logged and no `outcome` ref — an eval sweep can't see it and can't mark it
  # ok/send-back/returned. The worker's tier is already fixed (nothing will be applied), so this logs it as
  # source=reuse with no Jev call, purely for the ref. Left empty when the target has no model token (e.g. a
  # worker started without an explicit tier) — there is nothing known to log.
  pmodel=$(herdr pane get "$pane_arg" 2>/dev/null | jq -r '.result.pane.tokens.model // empty')
  case "$pmodel" in
    haiku|sonnet|opus)
      r=$(printf '%s' "$task_text" | node "$(dirname "$0")/../../wt-shared/scripts/model-route.mjs" pick --json --skill "${skill:-wt-handoff}" --role "$role" \
        --model "$pmodel" --reuse $([ "$dry" -eq 1 ] && echo --no-log) --cwd "${main_checkout:-$cwd}" 2>/dev/null || true)
      rmode=$(printf '%s' "$r" | jq -r '.mode // "off"' 2>/dev/null || echo off)
      [ "$rmode" = off ] || route_line=$(printf '%s' "$r" | jq -r '"routing: \(.tier // "none") (\(.mode), \(.source)\(if .ref then ", ref " + .ref else "" end))"' 2>/dev/null || true)
      ;;
  esac
fi

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
  send=$prompt                # sent as a normal prompt after the short line (WP-242)
  send_full="/goal $flat"     # fallback when the line cannot be typed
  goal_line="/goal ${ticket:+$ticket: }do the task in"
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
  record_message "$to" "$send" delivered # WP-257: hand_to confirmed the prompt was submitted
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
  # The routing ref rides the ticket's history (dispatch records are cleared on a return), for outcome tuning.
  if [ -n "$local_ticket" ] && [ -n "$route_line" ] && [ -x "$T" ]; then "$T" comment "$local_ticket" "$route_line" >/dev/null 2>&1 || true; fi
  # WP-147: --buddy <pane|self> pairs the worker and the buddy on this ticket — a `pair` pane token on both
  # (self = the sending pane), and a best-effort PATCH of the local ticket's own `pair` field (needs a real
  # sender pane for auth, so it silently no-ops from a server-side dispatch — dispatch.mjs sets that directly).
  if [ -n "$buddy_arg" ] && [ -n "$ticket" ]; then
    bpane=$buddy_arg
    [ "$bpane" != self ] || bpane=$( [ -n "${HERDR_PANE_ID:-}" ] && pane_of "$HERDR_PANE_ID" || true)
    if [ -n "$bpane" ]; then
      tag "$to" --token "pair=$ticket"
      tag "$bpane" --token "pair=$ticket"
      if [ -n "$local_ticket" ]; then
        brole=$(herdr pane get "$bpane" 2>/dev/null | jq -r '.result.pane.tokens.role // "reviewer"')
        bname=$(name_of "$bpane")
        payload=$(node -e 'const[w,wp,b,bp,br]=process.argv.slice(1);console.log(JSON.stringify({pair:{worker:{name:w,pane:wp},buddy:{name:b,pane:bp,role:br}}}))' \
          "${to_name:-$to}" "$to" "${bname:-$bpane}" "$bpane" "$brole")
        curl -sS --max-time 5 -X PATCH -H "x-herdr-pane: ${HERDR_PANE_ID:-}" -H 'content-type: application/json' \
          --data "$payload" "${HERDR_DASH_URL:-http://127.0.0.1:7777}/api/tickets/$local_ticket" >/dev/null 2>&1 || true
      fi
    fi
  fi
  out=$(echo "$line"
    [ -z "$route_line" ] || echo "$route_line"
    echo "target ${to_name:-?} $to${task:+ — $task}"
    echo "reach: $SELF --reply $to \"...\""
    [ -z "$routed" ] || echo "$routed")
  printf '%s\n' "$out"
  [ -z "$request_id" ] || printf '%s\n' "$out" | node "$RECEIPTS" put "$request_id" 2>/dev/null || true
}

dry() {  # <what would happen>
  echo "dry-run: $1"
  echo "send: $send"
  echo "ticket=${ticket:-none}"
  [ -n "$local_ticket" ] && [ "$role" = worker ] && echo "board: would move $local_ticket building + assign the worker"
  echo "mcp: ${mcp:-none}${jev:+ (jev: $jev)}"
  [ -z "$routed" ] || echo "$routed"
  [ -z "$route_line" ] || echo "$route_line"
  exit 0
}

# WP-204: a persona's own model/effort (its role file, applied by agents.sh spawn) outranks the routed tier, so a
# persona agent is reused by persona, never by tier.
[ -z "$persona" ] || { route_tier=; route_effort=; }

if [ "$mode" = pane ]; then
  # WP-247: a card belongs to one team (or none); its work goes to that team's agents (or a teamless one). Same rule and
  # wording as the dashboard's buddy route. No board reachable (server down, Linear key) → no check, as for the pair lookup.
  if [ -n "$local_ticket" ] && [ -x "$T" ]; then
    card_json=$("$T" show "$local_ticket" --json 2>/dev/null || true)
    if printf '%s' "$card_json" | jq -e '.id' >/dev/null 2>&1; then
      card_team=$(printf '%s' "$card_json" | jq -r '.team // empty')
      agent_team=$(herdr pane get "$pane_arg" 2>/dev/null | jq -r '.result.pane.tokens.team // empty')
      if [ "$card_team" != "$agent_team" ]; then
        who=$(name_of "$pane_arg"); who=${who:-$pane_arg}
        [ -n "$agent_team" ] && at="on team $agent_team" || at="not on a team"
        [ -n "$card_team" ] && ct="team $card_team's" || ct="teamless"
        cross="$who is $at; $local_ticket is $ct"
        [ "$dry" -eq 1 ] && dry "$cross"
        echo "$cross" >&2
        exit 2
      fi
    fi
  fi
  target_dnd=$(herdr pane get "$pane_arg" 2>/dev/null | jq -r '.result.pane.tokens.dnd // empty')
  [ -z "$target_dnd" ] || echo "warning: $(name_of "$pane_arg") is DND" >&2
  [ "$dry" -eq 1 ] && dry "would hand to pane $pane_arg"
  hand_to "$pane_arg"
  finish "reused $pane_arg" "$pane_arg"
  exit 0
fi

if [ "$mode" = auto ]; then
  tab=$(printf '\t')
  reuse=$(candidates | while IFS="$tab" read -r p _ _ cmodel ceffort; do
    [ -z "$route_tier" ] || { [ "$cmodel" = "$route_tier" ] && { [ -z "$route_effort" ] || [ "$ceffort" = "$route_effort" ]; }; } || continue
    has_picks "$(name_of "$p")" && { echo "$p"; break; }
  done)
  if [ -n "$reuse" ]; then
    [ "$dry" -eq 1 ] && dry "would reuse $role $(name_of "$reuse") ($reuse)${route_tier:+ (model $route_tier)}"
    hand_to "$reuse"
    finish "reused $reuse" "$reuse"
    exit 0
  fi
fi

# WP-143: a pool cap, worker role only. $WT_WORKERS_MAX wins over the project setting (as $WT_AGENTS_MCP does);
# unset/non-numeric = no cap (today's behaviour). No queue: the caller (dispatch) keeps the card in Ready and
# retries it on its next pass (dispatch.mjs's existing 3-strikes rule applies here too — a pool that stays full
# for ~3 backoff cycles holds the card for a manual retry, same as any other repeated dispatch failure).
if [ "$role" = worker ] && [ -z "$team" ]; then # a team is capped by its roster below, not by the plain pool cap
  cap=${WT_WORKERS_MAX:-$(node "$(dirname "$0")/../../wt-shared/scripts/project-setting.mjs" get WT_WORKERS_MAX --cwd "${main_checkout:-$cwd}" 2>/dev/null)}
  case "$cap" in ''|*[!0-9]*) cap= ;; esac
  if [ -n "$cap" ]; then
    # WP-205: the cap counts the agents this handoff could otherwise have reused — the same persona token (none for
    # a plain handoff) — so idle persona agents never fill the cap against a plain ticket, nor the reverse.
    # WP-247: team members do not count — a team is capped by its own roster, so its workers must not fill the plain pool.
    pt=$(herdr pane list 2>/dev/null | jq -c '[(.result.panes // [])[] | select(.pane_id != null) | {key: .pane_id, value: (.tokens.persona // "")}] | from_entries' 2>/dev/null) || pt=
    [ -n "$pt" ] || pt='{}'
    tm=$(herdr pane list 2>/dev/null | jq -c '[(.result.panes // [])[] | select(.pane_id != null and (.tokens.team // "") != "") | .pane_id]' 2>/dev/null) || tm=
    [ -n "$tm" ] || tm='[]'
    n=$(herdr agent list | jq --arg ws "$(worker_ws)" --arg persona "$persona" --argjson pt "$pt" --argjson tm "$tm" \
      '[.result.agents[] | select(.workspace_id == $ws) | select(.pane_id as $p | $tm | index($p) | not) | select(($pt[.pane_id // ""] // "") == $persona)] | length')
    if [ "$n" -ge "$cap" ]; then
      full="pool full: $n/$cap ${persona:-plain} workers in $(basename "${main_checkout:-$cwd}")"
      [ "$dry" -eq 1 ] && dry "$full"
      echo "$full" >&2
      exit 3
    fi
  fi
fi

# WP-238: a team never grows past its roster — the spawn below would add a member beyond the team file's count for this persona.
if [ -n "$team" ]; then
  want=${persona:-$role}
  seats=$(node "$(dirname "$0")/../../wt-shared/scripts/teams.mjs" seats "$team" "$want" --cwd "${main_checkout:-$cwd}" 2>/dev/null) || seats=0
  [ "${seats:-0}" -gt 0 ] || { echo "team $team has no $want member (wt-roles team check)" >&2; exit 2; }
  have=$(herdr pane list 2>/dev/null | jq --arg t "$team" --arg p "$want" '[(.result.panes // [])[] | select(.tokens.team == $t and (.tokens.persona // .tokens.role) == $p)] | length' 2>/dev/null) || have=0
  if [ "${have:-0}" -ge "$seats" ]; then
    full="team full: $have/$seats $want in $team"
    [ "$dry" -eq 1 ] && dry "$full"
    echo "$full" >&2
    exit 3
  fi
fi

[ "$dry" -eq 1 ] && dry "would spawn a ${persona:+$persona }$role in $spawn_cwd${mcp:+ with --mcp $mcp}${route_tier:+ with --model $route_tier}${route_effort:+ --effort $route_effort}"
# Spawning, the numbering and the naming all live in agents.sh, so the pool has
# one definition of what a worker is called. It names the repo from $PWD, so run it from the target.
created=$(cd "$spawn_cwd" && "$(cd "$(dirname "$0")" && pwd)/../../wt-agents/scripts/agents.sh" spawn "${persona:-$role}" "$spawn_cwd" ${mcp:+--mcp "$mcp"} ${route_tier:+--model "$route_tier"} ${route_effort:+--effort "$route_effort"} ${team:+--team "$team"})
label=${created%% *}
pane=${created##* }

clear=0   # a fresh agent has nothing to clear
fresh=1; fresh_label=$label
hand_to "$pane"
finish "created $label $pane" "$pane"
