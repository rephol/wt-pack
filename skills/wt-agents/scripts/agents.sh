#!/bin/sh
# Manage the named agent pools this pack hands work to.
#
#   agents.sh list [role] [--json]         # name, pane, status, cwd (--json adds tokens)
#   agents.sh spawn <role> [cwd] [--mcp a,b] # -> prints "<name> <pane>"; --mcp adds servers from mcp/catalog.json
#   agents.sh rm <name|pane> [--force]     # closes the tab
#   agents.sh mcp-args <role> [cwd] [--mcp a,b] # the claude MCP args spawn would use (nothing = full set)
#   agents.sh mcp-file <role> <cwd> <label>    # writes spawn's MCP config for <label>, prints its claude args (resume)
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

# herdr names allow only [a-z0-9_-], up to 32 chars; "<repo>-<role>-NN" must fit, so the repo part is cut to 20.
repo_slug() { basename "$1" | LC_ALL=C tr ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz | LC_ALL=C tr -c 'a-z0-9_\n-' '-' | cut -c1-20; }

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

spawn|mcp-args|mcp-file)
  # --mcp a,b may sit anywhere; the rest stay positional (role, cwd).
  extra=; n=$#
  while [ "$n" -gt 0 ]; do
    a=$1; shift; n=$((n - 1))
    if [ "$a" = --mcp ]; then extra=$1; shift; n=$((n - 1)); else set -- "$@" "$a"; fi
  done
  role=${1:?role required, e.g. worker|planner}
  # Check --mcp names before anything is created.
  dir=$(cd "$(dirname "$0")/.." && pwd)/mcp
  if [ -n "$extra" ]; then
    picks=$(printf '%s' "$extra" | jq -R 'split(",") | map(select(. != ""))')
    missing=$(jq -r --argjson p "$picks" '[$p[] as $n | select(.mcpServers[$n] == null) | $n] | join(",")' "$dir/catalog.json")
    [ -n "$missing" ] && { echo "unknown MCP server(s): $missing (see $dir/catalog.json)" >&2; exit 1; }
  fi
  main=$(repo_root "$PWD"); repo=$(basename "$main")
  # A planner makes its own worktree, so it starts in the main checkout; so does any other role without a cwd.
  case "$role" in worker) cwd=${2:-$PWD} ;; *) cwd=${2:-$main} ;; esac
  [ -d "$cwd" ] || { echo "no such directory: $cwd" >&2; exit 1; }
  # Absolutise: herdr resolves a relative --cwd against the DAEMON's directory,
  # not the caller's, so `spawn worker .` silently lands the agent outside the
  # repo — where it still works, but `git rev-parse` finds nothing and the
  # handoff candidate filter can never see it again.
  cwd=$(cd "$cwd" && pwd)

  [ "$cmd" != spawn ] || {
  ws=$(pool_ws "$(role_label "$role" "$repo")" "$main")
  sync_names "$ws"

  # Number from existing AGENT NAMES across all pools: herdr names are GLOBAL,
  # so two repos numbering from 1 collide on the second pool with
  # agent_name_taken and the agent never starts.
  slug=$(repo_slug "$main")
  # WP-120: plus the names of exited agents the watchdog remembers — herdr drops them from its list, and
  # reusing one blocks that agent's Resume ("already running in pane …").
  wd="${WT_DASHBOARD_DATA:-$HOME/.local/share/wt-dashboard}/data/watchdog.json"
  next=$({ herdr agent list | jq -r '.result.agents[].name // empty'
    [ -r "$wd" ] && jq -r '.lastSeen // {} | .[] | select(.goneAt) | .name // empty' "$wd" 2>/dev/null; } \
    | sed -n "s/^$slug-$role-0*\([0-9][0-9]*\)$/\1/p" | sort -n | tail -1)
  label=$(printf '%s-%s-%02d' "$slug" "$role" "$(( ${next:-0} + 1 ))")
  }
  [ "$cmd" = mcp-args ] && label=args-$$
  if [ "$cmd" = mcp-file ]; then
    label=${3:?label required}
    case "$label" in *[!a-z0-9_-]*) echo "bad label: $label" >&2; exit 1 ;; esac
  fi

  # Lean MCP: only the servers in mcp/<role>.json (--strict-mcp-config also drops plugin and claude.ai
  # servers — context-mode, claude-mem, railway, plan… — each a node process per session).
  # Only in lean mode (dashboard Settings switch, or WT_AGENTS_MCP=lean; default full). Full mode, or a role
  # without a file, keeps the full set (still adding any --mcp picks).
  mcp_file=; strict=; files=
  if [ "$("$(dirname "$0")/../../wt-shared/scripts/mcp-mode.sh" --cwd "$cwd")" = lean ] && [ -f "$dir/$role.json" ]; then
    strict=--strict-mcp-config; files=$dir/$role.json
    top=$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null)
    for f in "$top/.mcp.json" "$main/.mcp.json"; do [ -f "$f" ] && { files="$files
$f"; break; }; done
  fi
  if [ -n "$extra" ]; then
    mkdir -p "${TMPDIR:-/tmp}/wt-agents"
    jq --argjson p "$picks" '{mcpServers: (.mcpServers | with_entries(select(.key as $k | $p | index($k))))}' "$dir/catalog.json" \
      > "${TMPDIR:-/tmp}/wt-agents/picks-$$.json"
    files="$files
${TMPDIR:-/tmp}/wt-agents/picks-$$.json"
  fi
  if [ -n "$files" ]; then
    mkdir -p "${XDG_CACHE_HOME:-$HOME/.cache}/wt-agents"
    mcp_file=${XDG_CACHE_HOME:-$HOME/.cache}/wt-agents/mcp-$label.json
    # Later files win on a name clash: role < repo < --mcp.
    printf '%s\n' "$files" | sed '/^$/d' | tr '\n' '\0' | xargs -0 jq -s '{mcpServers: (map(.mcpServers // {}) | add)}' > "$mcp_file"
    rm -f "${TMPDIR:-/tmp}/wt-agents/picks-$$.json"
  fi
  if [ "$cmd" = mcp-args ]; then
    [ -n "$mcp_file" ] && { echo ${strict:+$strict }--mcp-config; jq -c '.mcpServers | keys' "$mcp_file"; rm -f "$mcp_file"; }
    exit 0
  fi
  if [ "$cmd" = mcp-file ]; then
    [ -n "$mcp_file" ] && echo ${strict:+$strict }--mcp-config "$mcp_file"
    exit 0
  fi

  # A path claude has never seen opens the first-run trust dialog and blocks,
  # and `agent start` then fails with agent_not_ready. Seed the flag first.
  conf="$HOME/.claude.json"
  [ -f "$conf" ] || echo '{}' > "$conf"
  jq --arg d "$cwd" '.projects[$d].hasTrustDialogAccepted = true' "$conf" > "$conf.tmp" && mv "$conf.tmp" "$conf"

  # WP-107: a project with a GitHub account (dashboard Settings › Projects) gets that account's token in the pane
  # env, so gh and git push inside it act as that account. From gh's keyring; never `gh auth switch` (global).
  # The token is a snapshot: a changed account or rotated token needs a respawn.
  # ponytail: the token rides herdr's argv for the one tab-create call; the pane env (ps eww) already exposes it
  # for the agent's life, accepted on a single-user Mac (plan risk). herdr has no env-file option to avoid either.
  set --
  acct=$(node "$(dirname "$0")/../../wt-shared/scripts/project-setting.mjs" get githubAccount --cwd "$main" 2>/dev/null)
  if [ -n "$acct" ]; then
    if tok=$(gh auth token --user "$acct" 2>/dev/null) && [ -n "$tok" ]; then
      set -- --env "GH_TOKEN=$tok"
      git -C "$main" config credential.https://github.com.username "$acct" 2>/dev/null || true
    else
      echo "warning: no gh token for $acct (gh auth login --hostname github.com, as $acct); spawning with gh's active account" >&2
    fi
  fi
  pane=$(herdr tab create --workspace "$ws" --label "$label" --cwd "$cwd" --no-focus "$@" \
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
  set -- --name "$label"
  if [ -n "$mcp_file" ]; then set -- "$@" $strict --mcp-config "$mcp_file"; fi
  while ! herdr agent start "$label" --kind claude --pane "$pane" -- "$@" >/dev/null 2>&1; do
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
  name=$(herdr agent get "$pane" | jq -r '.result.agent.name // empty')
  herdr tab close "$tab" >/dev/null
  [ -n "$name" ] && rm -f "${XDG_CACHE_HOME:-$HOME/.cache}/wt-agents/mcp-$name.json"
  echo "removed $target ($pane, was $status)"
  ;;

*) sed -n '2,8p' "$0" >&2; exit 2 ;;
esac
