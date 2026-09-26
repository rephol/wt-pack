#!/bin/sh
# Manage the named agent pools this pack hands work to.
#
#   agents.sh list [role] [--json]         # name, pane, status, cwd (--json adds tokens)
#   agents.sh spawn <role> [cwd]           # -> prints "<name> <pane>"
#   agents.sh rm <name|pane> [--force]     # closes the tab
#
# A pool is a herdr workspace, "<repo>-<role>s" (e.g. <repo>-workers, <repo>-planners),
# created on demand; $WT_AGENTS_WORKSPACE overrides the label. Any role name works
# ([a-z][a-z0-9-]*); workers are spawned in <cwd> (a worktree, usually), every other
# role in the main checkout unless a cwd is given (a planner's first job is to MAKE a
# worktree). Each new agent gets herdr pane tokens (source "wt-dashboard", display-
# only): role, project, spawned_by ($WT_AGENTS_SPAWNED_BY, default wt-agents), created.
#
# Every agent is NAMED. `herdr agent start <NAME>` only names what it actually
# starts — when it instead DETECTS a claude already running in the pane (the
# path a timeout-and-retry takes) it reports success and the name never lands,
# which is how this pool ended up with four unnamed agents. So the name is
# always set with an explicit `agent rename` afterwards; it is idempotent.
set -eu

command -v herdr >/dev/null || { echo "herdr not on PATH" >&2; exit 1; }

repo_root() {
  dirname "$(git -C "$1" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" 2>/dev/null
}

pool_ws() {  # <label> <cwd-for-new-workspace>
  id=$(herdr workspace list | jq -r --arg l "$1" \
    '.result.workspaces[] | select(.label == $l) | .workspace_id' | head -1)
  [ -n "$id" ] || id=$(herdr workspace create --label "$1" --cwd "$2" --no-focus \
    | jq -r '.result.workspace.workspace_id')
  echo "$id"
}

# Backfill any agent in the pool whose name never landed, from its tab label.
# Cheap, and it keeps `rm <name>` usable for agents started before this script.
sync_names() {  # <workspace-id>
  herdr agent list | jq -r --arg ws "$1" \
    '.result.agents[] | select(.workspace_id == $ws and (.name // "") == "") | .pane_id + "\t" + .tab_id' \
  | while IFS="$(printf '\t')" read -r pane tab; do
      [ -n "$pane" ] && [ -n "$tab" ] || continue
      label=$(herdr tab get "$tab" 2>/dev/null | jq -r '.result.tab.label // ""')
      case "$label" in ''|'?') continue ;; esac
      herdr agent rename "$pane" "$label" >/dev/null 2>&1 || true
    done
}

role_label() {  # <role> <repo>
  case "$1" in
    ''|*[!a-z0-9-]*|[!a-z]*) echo "bad role: $1 (lowercase letters, digits, dashes)" >&2; exit 2 ;;
  esac
  echo "${WT_AGENTS_WORKSPACE:-$2-$1s}"
}

cmd=${1:-list}; shift 2>/dev/null || true

case "$cmd" in
list)
  json=; role=
  for a in "$@"; do case "$a" in --json) json=1 ;; *) role=$a ;; esac; done
  main=$(repo_root "$PWD"); repo=$(basename "$main")
  for r in ${role:-worker planner}; do
    ws=$(pool_ws "$(role_label "$r" "$repo")" "$main")
    sync_names "$ws"
    if [ -n "$json" ]; then
      # Tokens live on panes, not on the agent list.
      herdr agent list | jq -c --arg ws "$ws" --argjson panes "$(herdr pane list | jq '[.result.panes[] | {key: .pane_id, value: (.tokens // {})}] | from_entries')" \
        '.result.agents[] | select(.workspace_id == $ws) | {name, pane: .pane_id, status: .agent_status, cwd, tokens: ($panes[.pane_id] // {})}'
    else
      herdr agent list | jq -r --arg ws "$ws" \
        '.result.agents[] | select(.workspace_id == $ws) | [.name, .pane_id, .agent_status, .cwd] | @tsv'
    fi
  done
  ;;

spawn)
  role=${1:?role required, e.g. worker|planner}
  main=$(repo_root "$PWD"); repo=$(basename "$main")
  # A planner makes its own worktree, so it starts in the main checkout; so does any other role without a cwd.
  case "$role" in worker) cwd=${2:-$PWD} ;; *) cwd=${2:-$main} ;; esac
  [ -d "$cwd" ] || { echo "no such directory: $cwd" >&2; exit 1; }
  # Absolutise: herdr resolves a relative --cwd against the DAEMON's directory,
  # not the caller's, so `spawn worker .` silently lands the agent outside the
  # repo — where it still works, but `git rev-parse` finds nothing and the
  # handoff candidate filter can never see it again.
  cwd=$(cd "$cwd" && pwd)

  ws=$(pool_ws "$(role_label "$role" "$repo")" "$main")
  sync_names "$ws"

  # Number from existing AGENT NAMES across all pools: herdr names are GLOBAL,
  # so two repos numbering from 1 collide on the second pool with
  # agent_name_taken and the agent never starts.
  next=$(herdr agent list | jq -r '.result.agents[].name // empty' \
    | sed -n "s/^$repo-$role-0*\([0-9][0-9]*\)$/\1/p" | sort -n | tail -1)
  label=$(printf '%s-%s-%02d' "$repo" "$role" "$(( ${next:-0} + 1 ))")

  # A path claude has never seen opens the first-run trust dialog and blocks,
  # and `agent start` then fails with agent_not_ready. Seed the flag first.
  conf="$HOME/.claude.json"
  [ -f "$conf" ] || echo '{}' > "$conf"
  jq --arg d "$cwd" '.projects[$d].hasTrustDialogAccepted = true' "$conf" > "$conf.tmp" && mv "$conf.tmp" "$conf"

  pane=$(herdr tab create --workspace "$ws" --label "$label" --cwd "$cwd" --no-focus \
    | jq -r .result.root_pane.pane_id)

  # Tags go on the pane BEFORE claude starts: wt-memory's SessionStart hook reads the
  # role token from this pane, and a tag set after start arrives too late for it.
  # (Best effort: an older herdr has no report-metadata.)
  herdr pane report-metadata "$pane" --source wt-dashboard --token "role=$role" --token "project=$repo" \
    --token "spawned_by=${WT_AGENTS_SPAWNED_BY:-wt-agents}" --token "created=$(date +%F)" >/dev/null 2>&1 || true

  # A fresh pane is not at its shell prompt the instant `tab create` returns.
  n=0
  # Two names, two layers: `agent start <NAME>` names the agent to HERDR, while
  # `claude --name` sets the session's own display name. Setting only the first
  # leaves the session itself unnamed wherever claude lists its own sessions.
  while ! herdr agent start "$label" --kind claude --pane "$pane" -- --name "$label" >/dev/null 2>&1; do
    n=$((n + 1))
    [ "$n" -ge 3 ] && { echo "claude did not come up in $label (pane $pane)" >&2; exit 1; }
    sleep 3
  done
  herdr agent rename "$pane" "$label" >/dev/null 2>&1 || true
  echo "$label $pane"
  ;;

rm)
  target=${1:?name or pane required}; force=${2:-}
  pane=$(herdr agent list | jq -r --arg t "$target" \
    '.result.agents[] | select(.name == $t or .pane_id == $t) | .pane_id' | head -1)
  [ -n "$pane" ] || { echo "no such agent: $target" >&2; exit 1; }
  status=$(herdr agent get "$pane" | jq -r '.result.agent.agent_status')
  # Closing a working agent discards a turn in flight, and its work is only in
  # that pane until it commits. Refuse unless the caller says otherwise.
  if [ "$status" = working ] && [ "$force" != "--force" ]; then
    echo "$target is working; re-run with --force to close it anyway" >&2
    exit 1
  fi
  tab=$(herdr agent get "$pane" | jq -r '.result.agent.tab_id')
  herdr tab close "$tab" >/dev/null
  echo "removed $target ($pane, was $status)"
  ;;

*) sed -n '2,8p' "$0" >&2; exit 2 ;;
esac
