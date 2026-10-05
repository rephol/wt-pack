#!/bin/sh
# Manage the named agent pools this pack hands work to.
#
#   agents.sh list [role] [--json]         # name, pane, status, cwd, dnd (+until), pair (--json adds tokens,
#                                            plus structured dnd:{on,until} and pair)
#   agents.sh spawn <role|persona> [cwd] [--mcp a,b] [--model haiku|sonnet|opus] [--effort low|medium|high|xhigh|max]
#                                            # -> prints "<name> <pane>"; --mcp adds servers from mcp/catalog.json;
#                                            --model starts claude on that tier (WP-128), pinned to its explicit
#                                            model id (WP-158) rather than the bare alias; --effort sets its
#                                            effort (WP-137); either missing falls back to the role's routing
#                                            floor; the final tier/effort actually spawned are written as pane
#                                            tokens model/effort (WP-143, tier not id), for reuse-matching and
#                                            idle retirement
#   agents.sh dnd <name|pane> [on [--for 2h]|off]  # set/clear/query the `dnd` pane token (WP-147, WP-173):
#                                            DND agents are skipped by every free-agent pick (wt-handoff
#                                            candidates(), retireIdle, routines) — target one explicitly with
#                                            --pane to bypass the skip. `on` with no --for never auto-clears
#                                            (dnd=1); `on --for <Nh|Nm|Nd|Ns>` writes an expiry (dashboard's own
#                                            format, ISO time), auto-cleared by the dashboard's tick. No on/off
#                                            argument prints the current state instead of changing it.
#   agents.sh rm <name|pane> [--force]     # closes the tab
#   agents.sh respawn <name|pane>|--stale [--force] # new tab (current PATH shims + plugin guard), same name, role,
#                                            cwd, tokens and claude session (model/effort tokens re-applied as
#                                            --model/--effort so the respawn keeps its tier, not the role floor);
#                                            --stale: every pool agent lacking either
#   agents.sh spawn --team <name> [cwd]    # WP-237: bring a whole team up (.wt-pack/teams/<name>.md, see wt-roles team):
#                                            one `spawn <persona> [cwd] --team <name>` per member x count, prints each
#                                            (WP-247: only the seats not already taken; a single spawn into a team refuses a
#                                            non-member persona (exit 2) and a full seat (exit 3))
#                                            "<name> <pane>"; `spawn <role|persona> --team <name>` adds ONE agent to a
#                                            team. Every member pane gets the display-only `team` token.
#   agents.sh mcp-args <role> [cwd] [--mcp a,b] # the claude MCP args spawn would use (nothing = full set)
#   agents.sh mcp-file <role> <cwd> <label>    # writes spawn's MCP config for <label>, prints its claude args (resume)
#
# A pool is a herdr workspace, "<repo>-<role>s" (e.g. <repo>-workers, <repo>-planners),
# created on demand; $WT_AGENTS_WORKSPACE overrides the label. A persona (WP-204: a name with a project-role
# file .wt-pack/roles/<name>.md) spawns into its BASE role's pool, tagged role=<base> persona=<name>. Any role name works
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

# WP-222: a tab named after an agent whose claude is gone (herdr drops it from `agent list`) is a bare shell
# (one pane, agent_status unknown) — close it, so rm/respawn/spawn never leave one beside the live agent.
close_bare_tabs() {  # <label> [workspace-id]
  herdr tab list ${2:+--workspace "$2"} 2>/dev/null | jq -r --arg l "$1" \
    '.result.tabs[] | select(.label == $l and .pane_count == 1 and .agent_status == "unknown") | .tab_id' \
  | while IFS= read -r t; do herdr tab close "$t" >/dev/null 2>&1 || true; done
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
    # dnd token -> {on, until}: absent = off; "1" = on, no expiry; anything else = on until that ISO time
    # (WP-147's dashboard format, matched by `dnd on --for`).
    if [ -n "$json" ]; then
      # Tokens live on panes, not on the agent list.
      herdr agent list | jq -c --arg ws "$ws" --argjson panes "$(herdr pane list | jq '[.result.panes[] | {key: .pane_id, value: (.tokens // {})}] | from_entries')" \
        '.result.agents[] | select(.workspace_id == $ws) | ($panes[.pane_id] // {}) as $t |
         {name, pane: .pane_id, status: .agent_status, cwd, tokens: $t,
          dnd: (if ($t.dnd // "") == "" then {on:false,until:null} elif $t.dnd == "1" then {on:true,until:null} else {on:true,until:$t.dnd} end),
          pair: ($t.pair // null)}'
    else
      herdr agent list | jq -r --arg ws "$ws" --argjson panes "$(herdr pane list | jq '[.result.panes[] | {key: .pane_id, value: (.tokens // {})}] | from_entries')" \
        '.result.agents[] | select(.workspace_id == $ws) | ($panes[.pane_id] // {}) as $t |
         [.name, .pane_id, .agent_status, .cwd,
          (if ($t.dnd // "") == "" then "-" elif $t.dnd == "1" then "dnd" else "dnd until " + $t.dnd end),
          ($t.pair // "-")] | @tsv'
    fi
  done
  ;;

spawn|mcp-args|mcp-file)
  # --mcp a,b may sit anywhere; the rest stay positional (role, cwd).
  # --label/--resume are respawn's (WP-125): keep the old name, resume its claude session.
  extra=; model=; effort=; fixed=; resume=; team=; n=$#
  while [ "$n" -gt 0 ]; do
    a=$1; shift; n=$((n - 1))
    if [ "$a" = --mcp ]; then extra=$1; shift; n=$((n - 1))
    elif [ "$a" = --model ]; then model=$1; shift; n=$((n - 1))
    elif [ "$a" = --effort ]; then effort=$1; shift; n=$((n - 1))
    elif [ "$a" = --label ]; then fixed=$1; shift; n=$((n - 1))
    elif [ "$a" = --resume ]; then resume=$1; shift; n=$((n - 1))
    elif [ "$a" = --team ]; then team=$1; shift; n=$((n - 1))
    else set -- "$@" "$a"; fi
  done
  if [ -n "$team" ] && { [ "${#team}" -gt 24 ] || case "$team" in [a-z]*) case "$team" in *[!a-z0-9-]*) true ;; *) false ;; esac ;; *) true ;; esac; }; then
    echo "--team: a team name ([a-z][a-z0-9-]*, <= 24 chars)" >&2; exit 2
  fi
  # WP-237: `spawn --team <name> [path]` (no role; a path is absolute, ./ or ../) spawns every member of the team file, one process per agent.
  if [ -n "$team" ] && [ "$cmd" = spawn ] && { [ $# -eq 0 ] || case "$1" in /*|.|./*|../*|~*) [ -d "$1" ] ;; *) false ;; esac; }; then
    tcwd=$(cd "${1:-$PWD}" 2>/dev/null && pwd) || { echo "no such directory: ${1:-}" >&2; exit 1; }
    members=$(node "$(dirname "$0")/../../wt-shared/scripts/teams.mjs" members "$team" --cwd "$tcwd") || { echo "team $team: not found or invalid (wt-roles team check)" >&2; exit 1; }
    # a here-doc, not a pipe: the loop stays in this shell so a failed member fails the call (the rest still start)
    fail=0
    while IFS= read -r m; do
      [ -n "$m" ] || continue
      # WP-247: only missing seats are filled — a seat already taken makes the single spawn exit 3 (team full), which is not a failure
      WT_AGENTS_SPAWNED_BY="${WT_AGENTS_SPAWNED_BY:-wt-agents}" "$0" spawn "$m" "$tcwd" --team "$team" ${model:+--model "$model"} ${effort:+--effort "$effort"} ${extra:+--mcp "$extra"} < /dev/null || { [ $? -eq 3 ] || { echo "team $team: spawning $m failed" >&2; fail=1; }; }
    done <<TEAM_MEMBERS
$members
TEAM_MEMBERS
    exit $fail
  fi
  role=${1:?role required, e.g. worker|planner}
  # WP-204: a name that is not a base role but has a project-role file (.wt-pack/roles/<name>.md) is a PERSONA: it
  # spawns into its BASE role's pool with role=<base> and a persona token, so retire, DND/pair gates and Dispatch
  # still see it. Its model/effort/mcp are defaults (explicit flags win; model is floored below like any spawn).
  persona=
  case "$role" in orchestrator|planner|worker|auditor|reviewer) ;; *)
    if pj=$(node "$(dirname "$0")/../../wt-shared/scripts/roles.mjs" resolve "$role" --cwd "$(cd "${2:-$PWD}" 2>/dev/null && pwd)" 2>/dev/null); then
      persona=$role; role=$(printf '%s' "$pj" | jq -r .base)
      [ -n "$model" ] || model=$(printf '%s' "$pj" | jq -r '.model // empty')
      [ -n "$effort" ] || effort=$(printf '%s' "$pj" | jq -r '.effort // empty')
      pm=$(printf '%s' "$pj" | jq -r '.mcp | join(",")')
      if [ -n "$pm" ]; then
        # a persona's servers are added to --mcp picks, de-duplicated
        extra=$(printf '%s,%s' "$extra" "$pm" | tr ',' '\n' | sed '/^$/d' | awk '!s[$0]++' | paste -sd, -)
      fi
    fi ;;
  esac
  lrole=${persona:-$role}
  # WP-205: `frontend-worker` with no valid role file would silently become a brand-new role and pool.
  if [ -z "$persona" ] && [ "$cmd" = spawn ]; then case "$role" in orchestrator|planner|worker|auditor|reviewer) ;;
    *-orchestrator|*-planner|*-worker|*-auditor|*-reviewer) echo "warning: no valid .wt-pack/roles/$role.md (wt-roles check); spawning \"$role\" as a plain role with its own pool" >&2 ;; esac; fi
  case "$model" in ''|haiku|sonnet|opus) ;; *) echo "--model: haiku, sonnet or opus" >&2; exit 2 ;; esac
  case "$effort" in ''|low|medium|high|xhigh|max) ;; *) echo "--effort: low, medium, high, xhigh or max" >&2; exit 2 ;; esac
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
  # WP-199: the pool, the name's slug and the project token follow the TARGET directory's repo — not the caller's.
  # Spawning `orchestrator ~/Work/projects/other` from this checkout made wt-pack-orchestrator-NN in wt-pack's pool.
  tmain=$(repo_root "$cwd"); case "$tmain" in ''|.) ;; *) main=$tmain; repo=$(basename "$main") ;; esac

  # WP-247: a spawn that names a team joins it only as a persona/role the team file has, and only into a free seat
  # (the same checks and messages as handoff.sh --team). exit 2: not a member; exit 3: roster full.
  if [ -n "$team" ] && [ "$cmd" = spawn ]; then
    want=$lrole
    seats=$(node "$(dirname "$0")/../../wt-shared/scripts/teams.mjs" seats "$team" "$want" --cwd "$cwd" 2>/dev/null) || seats=0
    [ "${seats:-0}" -gt 0 ] || { echo "team $team has no $want member (wt-roles team check)" >&2; exit 2; }
    have=$(herdr pane list 2>/dev/null | jq --arg t "$team" --arg p "$want" '[(.result.panes // [])[] | select(.tokens.team == $t and (.tokens.persona // .tokens.role) == $p)] | length' 2>/dev/null) || have=0
    [ "${have:-0}" -lt "$seats" ] || { echo "team full: $have/$seats $want in $team" >&2; exit 3; }
  fi

  [ "$cmd" != spawn ] || {
  # WP-216: a workspace herdr creates here comes with a default tab "1" (a plain shell); remember it to close below.
  fresh_tab= fresh_new=
  herdr workspace list | jq -e --arg l "$(role_label "$role" "$repo")" '.result.workspaces[] | select(.label == $l)' >/dev/null || fresh_new=1
  ws=$(pool_ws "$(role_label "$role" "$repo")" "$main")
  [ -z "${fresh_new:-}" ] || fresh_tab=$(herdr tab list --workspace "$ws" | jq -r '.result.tabs[0].tab_id // ""')
  sync_names "$ws"

  # Number from existing AGENT NAMES across all pools: herdr names are GLOBAL,
  # so two repos numbering from 1 collide on the second pool with
  # agent_name_taken and the agent never starts.
  slug=$(repo_slug "$main")
  # herdr names are <= 32: a persona's longer role part shortens the repo part ("-" + role + "-NN").
  [ -z "$persona" ] || slug=$(printf '%s' "$slug" | cut -c1-$((28 - ${#persona})))
  # WP-120: plus the names of exited agents the watchdog remembers — herdr drops them from its list, and
  # reusing one blocks that agent's Resume ("already running in pane …"). A deliberate `rm` (or the WP-143
  # idle retirement, which also runs `rm`) drops its own name from watchdog.json below, so only a crash-gone
  # agent still occupies a number here.
  # WP-148: pick the LOWEST unoccupied number rather than max+1, so numbers freed by removal get reused.
  wd="${WT_DASHBOARD_DATA:-$HOME/.local/share/wt-dashboard}/data/watchdog.json"
  used=$({ herdr agent list | jq -r '.result.agents[].name // empty'
    [ -r "$wd" ] && jq -r '.lastSeen // {} | .[] | select(.goneAt) | .name // empty' "$wd" 2>/dev/null; } \
    | sed -n "s/^$slug-$lrole-0*\([0-9][0-9]*\)$/\1/p" | sort -nu)
  num=$(printf '%s\n' "$used" | awk 'BEGIN{n=1} NF{if ($1==n) n++} END{print n}')
  label=$(printf '%s-%s-%02d' "$slug" "$lrole" "$num")
  [ -z "$fixed" ] || label=$fixed
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
  # WP-120: pkill/pgrep/killall shims first on PATH (refuse options after the pattern and too-broad -f patterns).
  # CLAUDE_ENV_FILE is sourced before every Bash command, so rc files that prepend to PATH cannot bury the shims.
  # A per-agent copy of env.sh: hooks may append to CLAUDE_ENV_FILE, which must not write into the checkout.
  shim=$(cd "$(dirname "$0")/../bin" && pwd)
  envf="${XDG_CACHE_HOME:-$HOME/.cache}/wt-agents/env-$label.sh"
  mkdir -p "$(dirname "$envf")" && cp "$shim/env.sh" "$envf"
  set -- "$@" --env "PATH=$shim:$PATH" --env "WT_KILL_SHIM_DIR=$shim" --env "CLAUDE_ENV_FILE=$envf"
  # WP-122: mcp/<role>.json run ${WT_MEMORY_MCP:-~/.claude/skills/…}; a plugin-only install has no such link.
  set -- "$@" --env "WT_MEMORY_MCP=$(cd "$shim/../../wt-memory/mcp" && pwd)/server.mjs"
  close_bare_tabs "$label" "$ws"
  pane=$(herdr tab create --workspace "$ws" --label "$label" --cwd "$cwd" --no-focus "$@" \
    | jq -r .result.root_pane.pane_id)
  # Close that default tab once the agent's tab exists — only while it is still an idle shell (no agent in it).
  [ -z "$fresh_tab" ] || [ "$(herdr tab get "$fresh_tab" 2>/dev/null | jq -r '.result.tab | "\(.pane_count) \(.agent_status)"')" != "1 unknown" ] \
    || herdr tab close "$fresh_tab" >/dev/null 2>&1 || true

  # Tags go on the pane BEFORE claude starts: wt-memory's SessionStart hook reads the
  # role token from this pane, and a tag set after start arrives too late for it.
  # (Best effort: an older herdr has no report-metadata.)
  herdr pane report-metadata "$pane" --source wt-dashboard --token "role=$role" --token "project=$repo" \
    --token "spawned_by=${WT_AGENTS_SPAWNED_BY:-wt-agents}" --token "created=$(date +%F)" ${persona:+--token "persona=$persona"} ${team:+--token "team=$team"} >/dev/null 2>&1 || true

  # A fresh pane is not at its shell prompt the instant `tab create` returns.
  n=0
  # Two names, two layers: `agent start <NAME>` names the agent to HERDR, while
  # `claude --name` sets the session's own display name. Setting only the first
  # leaves the session itself unnamed wherever claude lists its own sessions.
  set -- --name "$label"
  [ -z "$resume" ] || set -- "$@" --resume "$resume"
  if [ -n "$mcp_file" ]; then set -- "$@" $strict --mcp-config "$mcp_file"; fi
  # WP-128/137: an explicit tier/effort wins; else the role floor and its effort (WP-160: in every routing
  # mode, not just live — spawn has no task to route in the first place). WP-158: floor also returns the
  # tier's explicit model id (its own loadConfig() already has the map in scope) — one call regardless of
  # what's missing, not a second `model-id` process on top.
  # --model here (when the caller already gave one) is passed through so floor computes effort/id for the
  # tier actually being spawned, not the role's own floor tier when the two diverge.
  floor=$(node "$(dirname "$0")/../../wt-shared/scripts/model-route.mjs" floor --role "$role" ${model:+--model "$model"} --cwd "$main" --json 2>/dev/null || true)
  model_id=$(printf '%s' "$floor" | jq -r '.model // empty' 2>/dev/null || true)
  [ -n "$model" ] || model=$(printf '%s' "$floor" | jq -r '.tier // empty' 2>/dev/null || true)
  [ -n "$effort" ] || effort=$(printf '%s' "$floor" | jq -r '.effort // empty' 2>/dev/null || true)
  # claude --model <tier> lets Claude Code resolve the bare alias to whatever it currently treats as that
  # tier; pin the explicit model id instead. $model itself stays the tier below (pane token, reuse match).
  [ -z "$model" ] || set -- "$@" --model "${model_id:-$model}"
  [ -z "$effort" ] || set -- "$@" --effort "$effort"
  # WP-143: record what this pane actually runs (post-floor), so reuse and idle-retirement can match on it.
  herdr pane report-metadata "$pane" --source wt-dashboard ${model:+--token "model=$model"} ${effort:+--token "effort=$effort"} >/dev/null 2>&1 || true
  while ! herdr agent start "$label" --kind claude --pane "$pane" -- "$@" >/dev/null 2>&1; do
    n=$((n + 1))
    [ "$n" -ge 3 ] && { echo "claude did not come up in $label (pane $pane)" >&2; exit 1; }
    sleep 3
  done
  herdr agent rename "$pane" "$label" >/dev/null 2>&1 || true
  echo "$label $pane"
  ;;

dnd)
  target=${1:?name or pane required}; shift
  state=${1:-}
  case "$state" in on|off) shift ;; '') ;; *) echo "dnd: on, off, or omit to query" >&2; exit 2 ;; esac
  for_dur=
  while [ $# -gt 0 ]; do case "$1" in --for) for_dur=${2:?--for needs a duration}; shift 2 ;;
    *) echo "dnd: unknown argument: $1" >&2; exit 2 ;; esac; done
  [ -z "$for_dur" ] || [ "$state" = on ] || { echo "dnd: --for only valid with on" >&2; exit 2; }
  pane=$(herdr agent list | jq -r --arg t "$target" \
    '.result.agents[] | select(.name == $t or .pane_id == $t) | .pane_id' | head -1)
  [ -n "$pane" ] || { echo "no such agent: $target" >&2; exit 1; }
  if [ -z "$state" ]; then
    v=$(herdr pane get "$pane" | jq -r '.result.pane.tokens.dnd // empty')
    if [ -z "$v" ]; then echo "dnd off: $target ($pane)"
    elif [ "$v" = 1 ]; then echo "dnd on: $target ($pane), no expiry"
    else echo "dnd on: $target ($pane) until $v"; fi
    exit 0
  fi
  if [ "$state" = on ]; then
    value=1
    if [ -n "$for_dur" ]; then
      # Same expiry format the dashboard writes (WP-147): an ISO time, auto-cleared by its tick once past.
      value=$(node -e '
        const m = process.argv[1].match(/^([0-9]+)([smhd])?$/)
        if (!m) { console.error("dnd: bad --for duration, e.g. 2h, 30m, 1d"); process.exit(1) }
        const ms = { s: 1e3, m: 60e3, h: 3_600_000, d: 86_400_000 }[m[2] || "h"]
        console.log(new Date(Date.now() + Number(m[1]) * ms).toISOString())
      ' "$for_dur") || exit 1
    fi
    herdr pane report-metadata "$pane" --source wt-dashboard --token "dnd=$value" >/dev/null
  else
    herdr pane report-metadata "$pane" --source wt-dashboard --clear-token dnd >/dev/null
  fi
  echo "dnd $state: $target ($pane)"
  ;;

rm)
  target=${1:?name or pane required}; force=${2:-}
  pane=$(herdr agent list | jq -r --arg t "$target" \
    '.result.agents[] | select(.name == $t or .pane_id == $t) | .pane_id' | head -1)
  if [ -z "$pane" ]; then
    # WP-222: its claude exited, so herdr no longer lists it — still close the bare tab left under its name.
    [ -n "$(herdr tab list | jq -r --arg l "$target" '.result.tabs[] | select(.label == $l and .pane_count == 1 and .agent_status == "unknown") | .tab_id')" ] \
      || { echo "no such agent: $target" >&2; exit 1; }
    close_bare_tabs "$target"; echo "removed $target (bare shell tab)"; exit 0
  fi
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
  # WP-148: a deliberate rm is not a crash to resume, so drop its name from the watchdog's memory too —
  # otherwise WP-120's Resume-collision guard keeps the number reserved forever and numbering only climbs.
  wd="${WT_DASHBOARD_DATA:-$HOME/.local/share/wt-dashboard}/data/watchdog.json"
  if [ -n "$name" ] && [ -r "$wd" ]; then
    tmp_wd="$wd.tmp.$$"
    jq --arg n "$name" '.lastSeen |= with_entries(select(.value.name != $n))' "$wd" > "$tmp_wd" \
      && mv "$tmp_wd" "$wd" || rm -f "$tmp_wd"
  fi
  echo "removed $target ($pane, was $status)"
  ;;

respawn)
  # WP-125: the kill shims are pane ENV, set only at tab create, so a same-pane restart (the dashboard's Resume)
  # would not pick them up — close the tab and spawn a new one under the same name (herdr names are global).
  self=$(cd "$(dirname "$0")" && pwd)/$(basename "$0")
  force=; stale=; target=
  for a in "$@"; do case "$a" in --force) force=--force ;; --stale) stale=1 ;; *) target=$a ;; esac; done
  respawn_one() {  # <name|pane> -> prints "<name> <new-pane>"
    row=$(herdr agent list | jq -c --arg t "$1" '[.result.agents[] | select(.name == $t or .pane_id == $t)][0] // empty')
    [ -n "$row" ] || { echo "no such agent: $1" >&2; return 1; }
    name=$(printf '%s' "$row" | jq -r '.name // empty'); old=$(printf '%s' "$row" | jq -r .pane_id)
    r=$(printf '%s' "$row" | jq -r '.tokens.role // empty'); dir=$(printf '%s' "$row" | jq -r '.cwd // empty')
    sess=$(printf '%s' "$row" | jq -r '.agent_session.value // empty')
    m=$(printf '%s' "$row" | jq -r '.tokens.model // empty'); e=$(printf '%s' "$row" | jq -r '.tokens.effort // empty')
    [ -n "$name" ] && [ -n "$r" ] && [ -n "$dir" ] || { echo "$1: needs a name, a role token and a cwd to respawn" >&2; return 1; }
    [ -n "$sess" ] || { echo "$1: no claude session id to resume" >&2; return 1; }
    [ -d "$dir" ] || { echo "$1: its cwd $dir is gone; not closing it" >&2; return 1; }
    if [ "$(printf '%s' "$row" | jq -r .agent_status)" = working ] && [ -z "$force" ]; then
      echo "$1 is working; re-run with --force to respawn it anyway" >&2; return 1
    fi
    # A session that never took a prompt has no transcript, and `claude --resume` on it dies: start fresh instead.
    if [ -z "$(find "$HOME/.claude/projects" -name "$sess.jsonl" 2>/dev/null | head -1)" ]; then
      echo "$name: no transcript for session $sess; starting fresh" >&2; sess=
    fi
    # WP-204: a persona agent respawns as its persona while that role file still resolves; otherwise as its base role
    # (spawn would take the bare persona name for a brand-new role and pool).
    pn=$(printf '%s' "$row" | jq -r '.tokens.persona // empty')
    if [ -n "$pn" ] && node "$(dirname "$0")/../../wt-shared/scripts/roles.mjs" resolve "$pn" --cwd "$dir" >/dev/null 2>&1; then r=$pn; fi
    "$self" rm "$old" --force >/dev/null || return 1
    out=$(cd "$dir" && "$self" spawn "$r" "$dir" --label "$name" ${sess:+--resume "$sess"} ${m:+--model "$m"} ${e:+--effort "$e"}) || return 1
    new=${out#* }
    # Spawn writes its own role/project/spawned_by/created/model/effort; carry the rest (task, ticket, task_state …) over.
    printf '%s' "$row" | jq -r '.tokens // {} | del(.role, .persona, .project, .spawned_by, .created, .model, .effort) | to_entries[] | "\(.key)=\(.value)"' \
    | while IFS= read -r kv; do
        herdr pane report-metadata "$new" --source wt-dashboard --token "$kv" >/dev/null 2>&1 || true
      done
    echo "$out"
  }
  if [ -z "$stale" ]; then respawn_one "${target:?name, pane or --stale required}"; exit; fi

  # --stale: every agent in this repo's pools whose claude lacks the PATH shim or predates the installed plugin guard.
  main=$(repo_root "$PWD"); repo=$(basename "$main")
  me=; [ -z "${HERDR_PANE_ID:-}" ] || me=$(herdr pane get "$HERDR_PANE_ID" 2>/dev/null | jq -r '.result.pane.pane_id // empty')
  ip=$(node -e 'try{console.log(require(process.argv[1]).plugins["wt-memory@wt-pack"][0].installPath)}catch{}' "$HOME/.claude/plugins/installed_plugins.json" 2>/dev/null || true)
  g=0; [ -n "$ip" ] && [ -d "$ip" ] && g=$(stat -c %W "$ip" 2>/dev/null || stat -f %B "$ip" 2>/dev/null || echo 0)
  # WP-213: no installed plugin but the checkout loaded as the plugin (CLAUDE_CODE_PLUGIN_DIRS): its hooks file's mtime.
  if [ "$g" = 0 ]; then
    pd=$(node -e 'try{const e=require(process.argv[1]).env?.CLAUDE_CODE_PLUGIN_DIRS||"";console.log(e.split(":").filter(Boolean)[0]||"")}catch{}' "$HOME/.claude/settings.json" 2>/dev/null || true)
    [ -n "$pd" ] && [ -f "$pd/hooks/hooks.json" ] && g=$(stat -c %Y "$pd/hooks/hooks.json" 2>/dev/null || stat -f %m "$pd/hooks/hooks.json" 2>/dev/null || echo 0)
  fi
  wss=$(herdr workspace list | jq -c --arg p "$repo-" '[.result.workspaces[] | select(.label | startswith($p) and endswith("s")) | .workspace_id]')
  found=0
  for name in $(herdr agent list | jq -r --argjson w "$wss" --arg me "$me" \
      '.result.agents[] | select((.workspace_id as $x | $w | index($x)) and .pane_id != $me and (.name // "") != "") | .name'); do
    # Never pgrep/pkill here (WP-109): read the process table and match claude's own --name.
    pid=$(ps -axo pid=,command= | awk -v n="$name" '{ for (i = 2; i < NF; i++) if ($i == "--name" && $(i+1) == n && $2 ~ /(^|\/)claude$/) { print $1; exit } }')
    [ -n "$pid" ] || continue
    why=
    case "$(ps eww -o command= -p "$pid" 2>/dev/null)" in *WT_KILL_SHIM_DIR=*) ;; *) why="no kill shim" ;; esac
    if [ "$g" -gt 0 ]; then
      # etime ([[dd-]hh:]mm:ss) is the one elapsed-time field both BSD and procps ps print; lstart needs BSD-only date -j.
      st=$(ps -o etime= -p "$pid" 2>/dev/null | awk -v now="$(date +%s)" '{ n = split($1, a, /[-:]/); s = 0; for (i = 1; i <= n; i++) s = s * (i == 2 && n == 4 ? 24 : 60) + a[i]; if (n) print now - s }')
      st=${st:-0}
      [ "$st" = 0 ] || [ "$st" -ge "$g" ] || why="${why:+$why, }predates the plugin guard"
    fi
    [ -n "$why" ] || continue
    found=1
    if out=$(respawn_one "$name" 2>&1); then echo "respawned $out ($why)"; else echo "skipped $name: $out"; fi
  done
  [ "$found" = 1 ] || echo "no stale agents"
  ;;

*) sed -n '2,10p' "$0" >&2; exit 2 ;;
esac
