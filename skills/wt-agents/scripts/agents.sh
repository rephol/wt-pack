#!/bin/sh
# Manage the named agent pools this pack hands work to (on hc, herdr-core; WP-378).
#
#   agents.sh list [role] [--json]         # name, terminal id, status, cwd, dnd (+until), pair (--json adds tokens,
#                                            plus structured dnd:{on,until} and pair, and claude's session + pid)
#   agents.sh spawn <role|persona> [cwd] [--mcp a,b] [--model haiku|sonnet|opus] [--effort low|medium|high|xhigh|max]
#                                            # -> prints "<name> <terminal id>"; --mcp adds servers from mcp/catalog.json;
#                                            --model starts claude on that tier (WP-128), pinned to its explicit
#                                            model id (WP-158) rather than the bare alias; --effort sets its
#                                            effort (WP-137); either missing falls back to the role's routing
#                                            floor; the final tier/effort actually spawned are written as labels
#                                            model/effort (WP-143, tier not id), for reuse-matching and
#                                            idle retirement
#   agents.sh dnd <name|id> [on [--for 2h]|off]  # set/clear/query the `dnd` label (WP-147, WP-173):
#                                            DND agents are skipped by every free-agent pick (wt-handoff
#                                            candidates(), retireIdle, routines) — target one explicitly with
#                                            --pane to bypass the skip. `on` with no --for never auto-clears
#                                            (dnd=1); `on --for <Nh|Nm|Nd|Ns>` writes an expiry (dashboard's own
#                                            format, ISO time), auto-cleared by the dashboard's tick. No on/off
#                                            argument prints the current state instead of changing it.
#   agents.sh rm <name|id> [--force]       # ends the agent's terminal and removes its record
#   agents.sh respawn <name|id>|--stale [--force] # new terminal (current PATH shims + plugin guard), same name, role,
#                                            cwd, labels and claude session (model/effort labels re-applied as
#                                            --model/--effort so the respawn keeps its tier, not the role floor);
#                                            --stale: every pool agent lacking either
#   agents.sh spawn --team <name> [cwd]    # WP-237: bring a whole team up (.wt-pack/teams/<name>.md, see wt-roles team):
#                                            one `spawn <persona> [cwd] --team <name>` per member x count, prints each
#                                            (WP-247: only the seats not already taken; a single spawn into a team refuses a
#                                            non-member persona (exit 2) and a full seat (exit 3))
#                                            "<name> <id>"; `spawn <role|persona> --team <name>` adds ONE agent to a
#                                            team. Every member terminal gets the display-only `team` label.
#   agents.sh spawn --headless <role> [cwd] [--prompt "<text>"] [--model m] [--effort e] [--name n] [--permission-mode m]
#                                            # WP-293: asks wt-dashboard ($HERDR_DASH_URL, default 127.0.0.1:7777) to
#                                            run a headless agent (no terminal); prints "<name> <id> <state>" (state
#                                            may be queued). cwd defaults to $PWD. Exit 1 on a dashboard error.
#   agents.sh list --headless              # the dashboard's headless runs: "<name> <id> <state> <cwd> <role>"
#   agents.sh send --headless <name|id> '<text>'   # WP-317: the run's next user message (text or stdin); live run wins over an ended one of the same name
#   agents.sh spawn --headless <role> [cwd] --reuse ...   # an idle run of the same role + cwd gets --prompt instead of a new run: prints "<name> <id> idle reused"
#   agents.sh rm|stop --headless <id>      # stop a headless run (WP-317: an agent terminal may stop the runs it spawned, an orchestrator any; else 403)
#   agents.sh context                      # WP-312: the caller's own context window as JSON {used,window,pct,model}: a terminal agent
#                                            ($HC_TERMINAL_ID) or a headless run ($WT_HEADLESS_ID) looked up in the dashboard's
#                                            /api/agents `info` (the WP-201 rule); exit 1 when the dashboard or the row is missing
#   agents.sh mcp-args <role> [cwd] [--mcp a,b] # the claude MCP args spawn would use (nothing = full set)
#   agents.sh mcp-file <role> <cwd> <label>    # writes spawn's MCP config for <label>, prints its claude args (resume)
#
# A pool is the label wt.pool="<repo>-<role>s" (e.g. <repo>-workers, <repo>-planners); $WT_AGENTS_WORKSPACE overrides it.
# herdr-app shows a terminal only when it carries herdr.space=<id>, so every REPO gets one herdr-app space (all its roles share it, one named tab per agent), looked up by
# name or made under a per-pool lock (agents-hc.mjs space); when herdr-app is missing or fails the agent runs hidden and the
# spawn still succeeds. A persona (WP-204: a name with a project-role
# file <repo>/.wt-pack/roles/<name>.md or, at user level, ~/.config/wt-pack/projects/<repo>/roles/<name>.md; the repo
# folder wins when both exist; `wt-roles where` prints both) spawns into its BASE role's pool, labelled role=<base> persona=<name>. Any role name works
# ([a-z][a-z0-9-]*); workers are spawned in <cwd> (a worktree, usually), every other
# role in the main checkout unless a cwd is given (a planner's first job is to MAKE a
# worktree). Each new agent gets hc labels (display-only): role, project, spawned_by ($WT_AGENTS_SPAWNED_BY, default wt-agents), created.
#
# Every agent is NAMED, at the start: `hc run --name` takes 1-32 of [a-z0-9_-], unique among live terminals, and hc cannot rename.
# The same name is passed to `claude --name`, so the session itself is named too. Numbering takes the lowest free
# <repo>-<role>-NN over every name hc still knows plus the dashboard's agents table; a lost race (name_taken) takes the next number.
# The program is scripts/hc-launch (login+interactive shell, pack values re-applied, denylist scrubbed): see that file. Secrets
# (GH_TOKEN, WT_PANE_KEY) travel in the terminal.run request body, never in argv or a file.
set -eu

# WP-293: --headless goes to wt-dashboard's /api/headless, never to the terminal core. Prints the body; exit 1 on a non-2xx or no answer.
hl_call() { # method path [json]
  hl_out=$(curl -sS --max-time 10 -X "$1" ${HC_TERMINAL_ID:+-H "x-herdr-pane: $HC_TERMINAL_ID"} ${WT_PANE_KEY:+-H "x-wt-pane-key: $WT_PANE_KEY"} -H 'content-type: application/json' \
    ${3:+--data "$3"} -w '\n%{http_code}' "${HERDR_DASH_URL:-http://127.0.0.1:7777}/api/headless$2" 2>/dev/null) \
    || { echo "wt-dashboard not reachable at ${HERDR_DASH_URL:-http://127.0.0.1:7777}" >&2; exit 1; }
  hl_code=$(printf '%s' "$hl_out" | tail -n1); hl_body=$(printf '%s' "$hl_out" | sed '$d')
  case "$hl_code" in 2??) printf '%s' "$hl_body" ;; *)
    err=$(printf '%s' "$hl_body" | jq -r '.error // empty' 2>/dev/null || true)
    if [ "$hl_code" = 403 ]; then # WP-330: the server names its rule (default mode only, project-rooted, spawner/orchestrator/user); the old generic line keeps its hint
      case "$err" in ''|'dashboard only') err="refused (403): ${err:-dashboard only} — only the pane that spawned the run (or an orchestrator) may stop it, else the dashboard" ;; *) err="refused (403): $err" ;; esac
    fi
    echo "wt-dashboard: ${err:-HTTP $hl_code}" >&2; exit 1 ;; esac
}
case " $* " in *" --headless "*)
  hl_cmd=$1; shift
  case "$hl_cmd" in
  spawn)
    role=; cwd=; prompt=; model=; effort=; name=; pmode=; reuse=0
    while [ $# -gt 0 ]; do v=$1; case "$v" in
      --headless) shift ;;
      --reuse) reuse=1; shift ;;
      --prompt|--model|--effort|--name|--permission-mode) [ $# -ge 2 ] || { echo "$v needs a value" >&2; exit 2; }
        case "$v" in --prompt) prompt=$2 ;; --model) model=$2 ;; --effort) effort=$2 ;; --name) name=$2 ;; --permission-mode) pmode=$2 ;; esac; shift 2 ;;
      *) if [ -z "$role" ]; then role=$v; elif [ -z "$cwd" ]; then cwd=$v; else echo "spawn --headless: unexpected $v" >&2; exit 2; fi; shift ;;
    esac; done
    [ -n "$role" ] || { echo "spawn --headless <role> [cwd] [--prompt text] [--model m] [--effort e] [--name n] [--permission-mode m]" >&2; exit 2; }
    cwd=$(cd "${cwd:-$PWD}" 2>/dev/null && pwd) || { echo "spawn --headless: no such directory" >&2; exit 2; }
    if [ "$reuse" = 1 ]; then # WP-317: an idle run of the same role + cwd takes the prompt instead of a duplicate being spawned
      hl_res=$(hl_call GET "") || exit 1
      hl_hit=$(printf '%s' "$hl_res" | jq -r --arg r "$role" --arg c "$cwd" '[.[] | select(.role == $r and .cwd == $c and .state == "idle")][0] | if . then "\(.id) \(.name)" else empty end')
      if [ -n "$hl_hit" ]; then
        [ -z "$prompt" ] || hl_call POST "/${hl_hit%% *}/message" "$(jq -n --arg text "$prompt" '{$text}')" >/dev/null || exit 1
        echo "${hl_hit#* } ${hl_hit%% *} idle reused"; exit 0
      fi
    fi
    hl_res=$(hl_call POST "" "$(jq -n --arg role "$role" --arg cwd "$cwd" --arg prompt "$prompt" --arg model "$model" --arg effort "$effort" --arg name "$name" --arg permissionMode "$pmode" \
      '{$role, $cwd} + ({$prompt, $model, $effort, $name, $permissionMode} | with_entries(select(.value != "")))')") || exit 1
    printf '%s' "$hl_res" | jq -r '"\(.name) \(.id) \(.state)"' ;;
  list) hl_res=$(hl_call GET "") || exit 1; printf '%s' "$hl_res" | jq -r '.[] | "\(.name) \(.id) \(.state) \(.cwd) \(.role // "-")"' ;; # state: idle = free to reuse, working = busy (WP-317: role is the 5th column)
  send) # WP-317: send --headless <name|id> '<text>' (or text on stdin) → the run's next user message; a live run beats an ended one of the same name
    [ "$1" = --headless ] && shift
    [ $# -ge 1 ] || { echo "send --headless <name|id> '<text>'" >&2; exit 2; }
    to=$1; shift; text=${1:-}; [ -n "$text" ] || { [ -t 0 ] && { echo "send --headless: no text" >&2; exit 2; }; text=$(cat); }
    [ -n "$text" ] || { echo "send --headless: no text" >&2; exit 2; }
    hl_res=$(hl_call GET "") || exit 1
    hl_id=$(printf '%s' "$hl_res" | jq -r --arg t "$to" '[.[] | select(.state != "ended" and .state != "failed")] as $l | ([$l[] | select(.id == $t or .name == $t)] | if length > 0 then . else [$l[] | select(.id | startswith($t))] end) | if length == 1 then .[0].id else empty end')
    [ -n "$hl_id" ] || { echo "send --headless: no live headless run (or ambiguous): $to" >&2; exit 1; }
    hl_call POST "/$hl_id/message" "$(jq -n --arg text "$text" '{$text}')" >/dev/null || exit 1
    echo "sent $hl_id" ;;
  rm|stop)
    [ $# -eq 2 ] || { echo "rm --headless <id>" >&2; exit 2; }
    id=$1; [ "$id" = --headless ] && id=$2; case "$id" in hl-*) ;; *) echo "rm --headless: not a headless id: $id" >&2; exit 2 ;; esac
    case "$id" in *[!A-Za-z0-9_-]*) echo "rm --headless: bad id" >&2; exit 2 ;; esac
    hl_res=$(hl_call POST "/$id/stop" '{}') || exit 1; printf '%s' "$hl_res" | jq -r '"\(.name) \(.id) \(.state)"' ;;
  *) echo "--headless works with spawn, list, send and rm" >&2; exit 2 ;;
  esac
  exit 0 ;;
esac

# WP-312: the caller's own context usage, from the dashboard's AgentInfo (no transcript parsing here).
if [ "${1:-}" = context ]; then
  me=${WT_HEADLESS_ID:-}
  [ -n "$me" ] || me=${HC_TERMINAL_ID:-}
  [ -n "$me" ] || { echo "context: not an hc terminal or headless run (no HC_TERMINAL_ID / WT_HEADLESS_ID)" >&2; exit 1; }
  rows=$(curl -sS --max-time 10 ${HC_TERMINAL_ID:+-H "x-herdr-pane: $HC_TERMINAL_ID"} ${WT_PANE_KEY:+-H "x-wt-pane-key: $WT_PANE_KEY"} "${HERDR_DASH_URL:-http://127.0.0.1:7777}/api/agents" 2>/dev/null) \
    || { echo "wt-dashboard not reachable at ${HERDR_DASH_URL:-http://127.0.0.1:7777}" >&2; exit 1; }
  printf '%s' "$rows" | jq -e --arg me "$me" '[.[]? | select(.info.pane.id == $me or .info.run.id == $me or .id == $me)][0] // empty
    | select(.info.contextUsed != null) | {used: .info.contextUsed, window: .info.contextWindow, pct: .info.contextPct, model: (.info.model.id // .info.model.name)}' \
    || { echo "context: no usage known for $me yet (no assistant turn in its transcript)" >&2; exit 1; }
  exit 0
fi

command -v hc >/dev/null || { echo "hc (herdr-core) not on PATH" >&2; exit 1; }
here=$(cd "$(dirname "$0")" && pwd)
hcjs="$here/../../wt-shared/scripts/hc.mjs"   # spawn + core-up
ah="$here/agents-hc.mjs"                        # reads, herdr-app space, labels
launcher="$here/hc-launch"

# A stopped core is STARTED by `hc ls|get|connect|server status` (spike S5): never touch hc while it is down (D4).
core_up() { node "$hcjs" core-up || { echo "hc core is down — ask the user to start it (hc server start)" >&2; exit 1; }; }
# WP-378 F5: rm/respawn end a terminal, and `agents-hc.mjs find` resolves ANY hc terminal: a user's shell or a dashboard shell must never be
# one. A pack agent has a role label or a (non -shells) wt.pool label, or the dashboard's agents table holds a row for its name (a kept
# shell at an agent's address has no labels, D8). Prints the refusal and exits 1 otherwise. <find-row-json> <target-as-typed>
require_pack_agent() {
  _role=$(printf '%s' "$1" | jq -r '.tokens.role // empty' 2>/dev/null); _pool=$(printf '%s' "$1" | jq -r '.tokens["wt.pool"] // empty' 2>/dev/null)
  [ -z "$_role" ] || return 0
  case "$_pool" in ''|*-shells) ;; *) return 0 ;; esac
  . "$here/../../wt-shared/scripts/agent-pane.sh"
  _n=$(printf '%s' "$1" | jq -r '.name // empty' 2>/dev/null)
  [ -z "$(agent_row "${_n:-$2}" | jq -r '.name // empty' 2>/dev/null)" ] || return 0
  echo "$2 is not a pack agent (no role or pool label, no agents-table row): refusing to end it; only pack agents can be removed or respawned here (the user closes other terminals in herdr-app)" >&2
  return 1
}

# hc names allow only [a-z0-9_-.], up to 32 chars; "<repo>-<role>-NN" must fit, so the repo part is cut to 20.
repo_slug() { basename "$1" | LC_ALL=C tr ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz | LC_ALL=C tr -c 'a-z0-9_\n-' '-' | cut -c1-20; }

repo_root() {
  dirname "$(git -C "$1" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" 2>/dev/null
}

role_label() {  # <role> <repo> -> the pool (label wt.pool)
  case "$1" in
    ''|*[!a-z0-9-]*|[!a-z]*) echo "bad role: $1 (lowercase letters, digits, dashes)" >&2; exit 2 ;;
  esac
  echo "${WT_AGENTS_WORKSPACE:-$2-$1s}"
}

dash_curl() { curl -sS --max-time 3 ${HC_TERMINAL_ID:+-H "x-herdr-pane: $HC_TERMINAL_ID"} ${WT_PANE_KEY:+-H "x-wt-pane-key: $WT_PANE_KEY"} "$@"; }

cmd=${1:-list}; shift 2>/dev/null || true

case "$cmd" in
list)
  json=; role=
  for a in "$@"; do case "$a" in --json) json=1 ;; *) role=$a ;; esac; done
  core_up
  main=$(repo_root "$PWD"); repo=$(basename "$main")
  for r in ${role:-worker planner}; do
    node "$ah" list "$(role_label "$r" "$repo")" ${json:+--json}
  done
  ;;

spawn|mcp-args|mcp-file)
  # --mcp a,b may sit anywhere; the rest stay positional (role, cwd).
  # --label/--resume are respawn's (WP-125): keep the old name, resume its claude session.
  extra=; model=; effort=; fixed=; resume=; team=; agent=; n=$#
  while [ "$n" -gt 0 ]; do
    a=$1; shift; n=$((n - 1))
    if [ "$a" = --mcp ]; then extra=$1; shift; n=$((n - 1))
    elif [ "$a" = --model ]; then model=$1; shift; n=$((n - 1))
    elif [ "$a" = --effort ]; then effort=$1; shift; n=$((n - 1))
    elif [ "$a" = --label ]; then fixed=$1; shift; n=$((n - 1))
    elif [ "$a" = --resume ]; then resume=$1; shift; n=$((n - 1))
    elif [ "$a" = --team ]; then team=$1; shift; n=$((n - 1))
    elif [ "$a" = --agent ]; then agent=$1; shift; n=$((n - 1))
    else set -- "$@" "$a"; fi
  done
  # WP-368: --agent <name> starts claude as that agent definition (e.g. wt-pack:wt-lead); only the `lead` role takes it.
  if [ -n "$agent" ]; then
    case "$agent" in ''|*[!A-Za-z0-9:_.-]*|[!A-Za-z0-9]*) echo "--agent: an agent name ([A-Za-z0-9][A-Za-z0-9:_.-]*)" >&2; exit 2 ;; esac
  fi
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
  # still see it. Its model/effort/mcp are defaults (explicit flags win; a persona model only raises the floor, WP-298).
  persona= pmodel=
  case "$role" in orchestrator|planner|worker|auditor|reviewer|lead) ;; *)
    if pj=$(node "$(dirname "$0")/../../wt-shared/scripts/roles.mjs" resolve "$role" --cwd "$(cd "${2:-$PWD}" 2>/dev/null && pwd)" 2>/dev/null); then
      persona=$role; role=$(printf '%s' "$pj" | jq -r .base)
      # WP-298: the persona's model is only a request to `floor` (--persona-model): it may raise its base role's floor, never lower it.
      pmodel=$(printf '%s' "$pj" | jq -r '.model // empty')
      [ -n "$effort" ] || effort=$(printf '%s' "$pj" | jq -r '.effort // empty')
      pm=$(printf '%s' "$pj" | jq -r '.mcp | join(",")')
      if [ -n "$pm" ]; then
        # a persona's servers are added to --mcp picks, de-duplicated
        extra=$(printf '%s,%s' "$extra" "$pm" | tr ',' '\n' | sed '/^$/d' | awk '!s[$0]++' | paste -sd, -)
      fi
    fi ;;
  esac
  lrole=${persona:-$role}
  [ -z "$agent" ] || [ "$role" = lead ] || { echo "--agent: only for the lead role (spawn lead --agent <name>)" >&2; exit 2; }
  # WP-205: `frontend-worker` with no valid role file would silently become a brand-new role and pool.
  if [ -z "$persona" ] && [ "$cmd" = spawn ]; then case "$role" in orchestrator|planner|worker|auditor|reviewer|lead) ;;
    *-orchestrator|*-planner|*-worker|*-auditor|*-reviewer|*-lead) echo "warning: no valid .wt-pack/roles/$role.md (wt-roles check); spawning it as a plain role with its own pool" >&2
      # WP-289: say where personas are looked up and which exist, so a user-level persona is not mistaken for absent
      rr=$(cd "${2:-$PWD}" 2>/dev/null && node "$(dirname "$0")/../../wt-shared/scripts/roles.mjs" roots 2>/dev/null | jq -r '"searched: \(.repo) and \(.user) (in effect: \(.in_effect))"') && echo "  $rr" >&2
      kp=$(cd "${2:-$PWD}" 2>/dev/null && node "$(dirname "$0")/../../wt-shared/scripts/roles.mjs" list 2>/dev/null | jq -r '[.[] | select(.base != .name) | .name] | join(", ")') && echo "  known personas: ${kp:-none}" >&2
      tn=$(cd "${2:-$PWD}" 2>/dev/null && node "$(dirname "$0")/../../wt-shared/scripts/roles.mjs" notice 2>/dev/null) ; [ -n "$tn" ] && echo "  $tn" >&2 ;; esac; fi # WP-334: why a repo persona is not found
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
  # Absolutise: hc resolves a relative --cwd against the CORE's directory (the API default),
  # not the caller's, so `spawn worker .` silently lands the agent outside the
  # repo — where it still works, but `git rev-parse` finds nothing and the
  # handoff candidate filter can never see it again.
  cwd=$(cd "$cwd" && pwd)
  # WP-199: the pool, the name's slug and the project token follow the TARGET directory's repo — not the caller's.
  # Spawning `orchestrator ~/Work/projects/other` from this checkout made wt-pack-orchestrator-NN in wt-pack's pool.
  tmain=$(repo_root "$cwd"); case "$tmain" in ''|.) ;; *) main=$tmain; repo=$(basename "$main") ;; esac


  [ "$cmd" != spawn ] || core_up
  # WP-247: a spawn that names a team joins it only as a persona/role the team file has, and only into a free seat
  # (the same checks and messages as handoff.sh --team). exit 2: not a member; exit 3: roster full.
  if [ -n "$team" ] && [ "$cmd" = spawn ]; then
    want=$lrole
    seats=$(node "$here/../../wt-shared/scripts/teams.mjs" seats "$team" "$want" --cwd "$cwd" 2>/dev/null) || seats=0
    [ "${seats:-0}" -gt 0 ] || { echo "team $team has no $want member (wt-roles team check)" >&2; exit 2; }
    have=$(node "$ah" team-count "$team" "$want" 2>/dev/null) || have=0
    . "$here/../../wt-shared/scripts/agent-pane.sh"; have=$(( ${have:-0} + $(agent_paused_in_team "$team" "$want") )) # WP-348: a paused member still holds its seat
    [ "${have:-0}" -lt "$seats" ] || { echo "team full: $have/$seats $want in $team" >&2; exit 3; }
  fi

  pool=$(role_label "$role" "$repo")
  # hc names are <= 32 ("<slug>-<role>-NN"): a long role or persona shortens the repo part.
  slug=$(repo_slug "$main" | cut -c1-$((28 - ${#lrole})))
  prefix=$slug-$lrole
  label=${fixed:-}
  # WP-120/148/348: number from every name hc still knows (live and finished: a finished one keeps its record until rm) plus the
  # dashboard's agents table (paused/exited/missing rows hold a number, a deliberate `rm` frees it). The LOWEST free number wins.
  names_taken() {
    { node "$ah" names; dash_curl "${HERDR_DASH_URL:-http://127.0.0.1:7777}/api/agents" 2>/dev/null | jq -r '.[]? | select(.local) | .name // empty' 2>/dev/null || true; } | paste -sd, -
  }
  [ "$cmd" != mcp-args ] || label=args-$$
  if [ "$cmd" = mcp-file ]; then
    label=${3:?label required}
    case "$label" in *[!a-z0-9_-]*) echo "bad label: $label" >&2; exit 1 ;; esac
  fi

  # Lean MCP: only the servers in mcp/<role>.json (--strict-mcp-config also drops plugin and claude.ai
  # servers — context-mode, claude-mem, railway, plan… — each a node process per session).
  # Only in lean mode (dashboard Settings switch, or WT_AGENTS_MCP=lean; default full). Full mode, or a role
  # without a file, keeps the full set (still adding any --mcp picks). Sets mcp_file/strict for the current $label.
  build_mcp() {
    mcp_file=; strict=; files=
    if [ "$("$here/../../wt-shared/scripts/mcp-mode.sh" --cwd "$cwd")" = lean ] && [ -f "$dir/$role.json" ]; then
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
  }
  if [ "$cmd" = mcp-args ]; then
    build_mcp
    [ -n "$mcp_file" ] && { echo ${strict:+$strict }--mcp-config; jq -c '.mcpServers | keys' "$mcp_file"; rm -f "$mcp_file"; }
    exit 0
  fi
  if [ "$cmd" = mcp-file ]; then
    build_mcp
    [ -n "$mcp_file" ] && echo ${strict:+$strict }--mcp-config "$mcp_file"
    exit 0
  fi

  # A path claude has never seen opens the first-run trust dialog and blocks. Seed the flag first.
  conf="$HOME/.claude.json"
  [ -f "$conf" ] || echo '{}' > "$conf"
  jq --arg d "$cwd" '.projects[$d].hasTrustDialogAccepted = true' "$conf" > "$conf.tmp" && mv "$conf.tmp" "$conf"

  # WP-107: a project with a GitHub account (dashboard Settings › Projects) gets that account's token in the agent's
  # env, so gh and git push inside it act as that account. From gh's keyring; never `gh auth switch` (global).
  # The token is a snapshot: a changed account or rotated token needs a respawn. WP-378 D3: it rides the terminal.run request
  # body (hc connect's stdin) — not argv, not a file; hc.mjs reads it from THIS call's environment (--env-names).
  gh_tok=
  acct=$(node "$here/../../wt-shared/scripts/project-setting.mjs" get githubAccount --cwd "$main" 2>/dev/null)
  if [ -n "$acct" ]; then
    if tok=$(gh auth token --user "$acct" 2>/dev/null) && [ -n "$tok" ]; then
      gh_tok=$tok
      git -C "$main" config credential.https://github.com.username "$acct" 2>/dev/null || true
    else
      echo "warning: no gh token for $acct (gh auth login --hostname github.com, as $acct); spawning with gh's active account" >&2
    fi
  fi
  # WP-120: pkill/pgrep/killall shims first on PATH (refuse options after the pattern and too-broad -f patterns): hc-launch
  # re-prepends WT_KILL_SHIM_DIR after the shell rc ran, and CLAUDE_ENV_FILE is sourced before every Bash command, so rc files
  # that prepend to PATH cannot bury the shims. A per-agent copy of env.sh: hooks may append to CLAUDE_ENV_FILE, which must not write into the checkout.
  shim=$(cd "$here/../bin" && pwd)
  # WP-327: a per-pane key (env + a 0600 file the dashboard reads) so x-herdr-pane alone is not identity. Never a label.
  pane_key=$(openssl rand -hex 32)
  # The names of the values this spawn sets in the terminal's env (hc-launch keeps exactly these and scrubs the rest of its
  # denylist): the pack's own, the role identity for wt-memory's hook, and any isolation variable the caller has set.
  env_names=WT_KILL_SHIM_DIR,CLAUDE_ENV_FILE,WT_MEMORY_MCP,WT_PANE_KEY,WT_ROLE,WT_PROJECT${persona:+,WT_PERSONA}${gh_tok:+,GH_TOKEN}
  for v in WT_DASHBOARD_DATA WT_TURN_DIR WT_MESSAGES_DIR WT_MEMORY_CACHE WT_RECEIPTS_DIR XDG_CACHE_HOME HERDR_DASH_URL; do
    eval "[ -z \"\${$v+x}\" ]" || env_names="$env_names,$v"
  done

  # WP-128/137: an explicit tier/effort wins; else the role floor and its effort (WP-160: in every routing
  # mode, not just live — spawn has no task to route in the first place). WP-158: floor also returns the
  # tier's explicit model id (its own loadConfig() already has the map in scope) — one call regardless of
  # what's missing, not a second `model-id` process on top.
  # --model here (when the caller already gave one) is passed through so floor computes effort/id for the
  # tier actually being spawned, not the role's own floor tier when the two diverge.
  floor=$(node "$here/../../wt-shared/scripts/model-route.mjs" floor --role "$role" ${model:+--model "$model"} ${pmodel:+--persona-model "$pmodel"} --cwd "$main" --json 2>/dev/null || true)
  model_id=$(printf '%s' "$floor" | jq -r '.model // empty' 2>/dev/null || true)
  [ -n "$model" ] || model=$(printf '%s' "$floor" | jq -r '.tier // empty' 2>/dev/null || true)
  [ -n "$effort" ] || effort=$(printf '%s' "$floor" | jq -r '.effort // empty' 2>/dev/null || true)
  # claude --model <tier> lets Claude Code resolve the bare alias to whatever it currently treats as that
  # tier; pin the explicit model id instead. $model itself stays the tier below (label, reuse match).
  # WP-143: the labels record what this agent actually runs (post-floor), so reuse and idle-retirement can match on it.

  # herdr-app: one space per pool (looked up by name, made under a lock). A failure runs the agent hidden, never fails the spawn.
  space_json=$(node "$ah" space "$repo" "$main" 2>&2) || space_json='{}'
  space_id=$(printf '%s' "$space_json" | jq -r '.space // empty' 2>/dev/null || true)
  stray=$(printf '%s' "$space_json" | jq -r '.stray // empty' 2>/dev/null || true)

  # One hc call starts the agent: all its labels exist before claude does (wt-memory's SessionStart hook reads the role),
  # and the env values travel in the request body. $label is the terminal name AND claude's --name.
  launch_once() {
    envf="${XDG_CACHE_HOME:-$HOME/.cache}/wt-agents/env-$label.sh"
    mkdir -p "$(dirname "$envf")" && cp "$shim/env.sh" "$envf"
    build_mcp
    set -- --name "$label"
    [ -z "$resume" ] || set -- "$@" --resume "$resume"
    [ -z "$agent" ] || set -- "$@" --agent "$agent"
    if [ -n "$mcp_file" ]; then set -- "$@" $strict --mcp-config "$mcp_file"; fi
    [ -z "$model" ] || set -- "$@" --model "${model_id:-$model}"
    [ -z "$effort" ] || set -- "$@" --effort "$effort"
    set -- spawn --name "$label" --cwd "$cwd" --label "wt.pool=$pool" --label "role=$role" --label "project=$repo" \
      --label "spawned_by=${WT_AGENTS_SPAWNED_BY:-wt-agents}" --label "created=$(date +%F)" ${persona:+--label "persona=$persona"} ${team:+--label "team=$team"} \
      ${model:+--label "model=$model"} ${effort:+--label "effort=$effort"} ${space_id:+--label "herdr.space=$space_id"} \
      --launch "$launcher" --env-names "$env_names" -- claude "$@"
    (
      export WT_KILL_SHIM_DIR="$shim" CLAUDE_ENV_FILE="$envf" WT_MEMORY_MCP="$(cd "$shim/../../wt-memory/mcp" && pwd)/server.mjs" WT_PANE_KEY="$pane_key" WT_ROLE="$role" WT_PROJECT="$repo"
      [ -z "$persona" ] || export WT_PERSONA="$persona"
      [ -z "$gh_tok" ] || export GH_TOKEN="$gh_tok"
      exec node "$hcjs" "$@"
    )
  }

  tries=0; errf=$(mktemp "${TMPDIR:-/tmp}/wt-agents-err.XXXXXX"); tk=$(names_taken)
  while :; do
    [ -n "$fixed" ] || label=$(node "$ah" next-name "$prefix" "$tk") || { rm -f "$errf"; exit 1; }
    if res=$(launch_once 2>"$errf"); then break; fi
    kind=$(jq -r '.error.kind // empty' "$errf" 2>/dev/null || true); msg=$(jq -r '.error.message // empty' "$errf" 2>/dev/null || true)
    rm -f "${XDG_CACHE_HOME:-$HOME/.cache}/wt-agents/mcp-$label.json" "${XDG_CACHE_HOME:-$HOME/.cache}/wt-agents/env-$label.sh"
    tries=$((tries + 1))
    # a lost numbering race: the next number (not for a fixed name — respawn needs exactly that one)
    if [ "$kind" = name_taken ] && [ -z "$fixed" ] && [ "$tries" -lt 3 ]; then tk="$tk,$label"; continue; fi
    [ -z "$stray" ] || node "$ah" retire-stray "$stray" >/dev/null 2>&1 || true
    echo "claude did not start in $label: ${msg:-$(cat "$errf")}" >&2
    rm -f "$errf"; exit 1
  done
  rm -f "$errf"
  pane=$(printf '%s' "$res" | jq -r .id)
  # Belt to hc-launch's own write: the key file exists before this call returns.
  keydir="${WT_DASHBOARD_DATA:-$HOME/.local/share/wt-dashboard}/pane-keys"
  (umask 077; mkdir -p "$keydir" && chmod 700 "$keydir" && printf '%s\n' "$pane_key" > "$keydir/.tmp.$$" && mv "$keydir/.tmp.$$" "$keydir/$pane") \
    || echo "warning: could not write the pane key for $pane (it will run in grace mode)" >&2
  # An id repeats across cores (t1.. on every one): drop keys of terminals that are no longer live (best effort; never on an empty list).
  live=$(node "$ah" live-ids 2>/dev/null || true)
  if [ -n "$live" ]; then
    for kf in "$keydir"/*; do
      [ -f "$kf" ] || continue; kn=$(basename "$kf")
      [ "$kn" = "$pane" ] || printf '%s\n' "$live" | grep -qxF "$kn" || rm -f "$kf"
    done
  fi
  # The shell herdr-app opened with a brand-new space: close it once the agent's tab exists, only while it is still a plain shell.
  [ -z "$stray" ] || node "$ah" retire-stray "$stray" >/dev/null 2>&1 || true
  # herdr-app names a new tab by its number: name it after the agent (a tab shared with other terminals keeps its name).
  [ -z "$space_id" ] || node "$ah" tab-name "$pane" "$label" >/dev/null 2>&1 || true
  echo "$label $pane"
  ;;

dnd)
  core_up
  target=${1:?name or id required}; shift
  state=${1:-}
  case "$state" in on|off) shift ;; '') ;; *) echo "dnd: on, off, or omit to query" >&2; exit 2 ;; esac
  for_dur=
  while [ $# -gt 0 ]; do case "$1" in --for) for_dur=${2:?--for needs a duration}; shift 2 ;;
    *) echo "dnd: unknown argument: $1" >&2; exit 2 ;; esac; done
  [ -z "$for_dur" ] || [ "$state" = on ] || { echo "dnd: --for only valid with on" >&2; exit 2; }
  row=$(node "$ah" find "$target" 2>/dev/null || true)
  pane=$(printf '%s' "$row" | jq -r 'select(.alive) | .pane_id // empty' 2>/dev/null)
  [ -n "$pane" ] || { echo "no such agent: $target" >&2; exit 1; }
  if [ -z "$state" ]; then
    v=$(printf '%s' "$row" | jq -r '.tokens.dnd // empty')
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
    node "$ah" label "$pane" "dnd=$value" >/dev/null
  else
    node "$ah" label "$pane" "dnd=" >/dev/null
  fi
  echo "dnd $state: $target ($pane)"
  ;;

rm)
  core_up
  # WP-348: --keep-row leaves the agents-table row (pause and respawn keep it); any other rm forgets it.
  target=; force=; keep_row=
  for a in "$@"; do case "$a" in --force) force=--force ;; --keep-row) keep_row=1 ;; *) [ -n "$target" ] || target=$a ;; esac; done
  : "${target:?name or id required}"
  row=$(node "$ah" find "$target" 2>/dev/null || true)
  [ -n "$row" ] || { echo "no such agent: $target" >&2; exit 1; }
  require_pack_agent "$row" "$target" || exit 1
  pane=$(printf '%s' "$row" | jq -r .pane_id); name=$(printf '%s' "$row" | jq -r '.name // empty'); status=$(printf '%s' "$row" | jq -r .agent_status)
  # Ending a working agent discards a turn in flight, and its work is only in that terminal until it commits.
  # Refuse unless the caller says otherwise.
  if [ "$status" = working ] && [ "$force" != "--force" ]; then
    echo "$target is working; re-run with --force to close it anyway" >&2
    exit 1
  fi
  node "$ah" retire "$pane" >/dev/null || { echo "could not end $target ($pane)" >&2; exit 1; } # kill + rm; a finished terminal only needs the rm
  if [ -n "$name" ]; then rm -f "${XDG_CACHE_HOME:-$HOME/.cache}/wt-agents/mcp-$name.json" "${XDG_CACHE_HOME:-$HOME/.cache}/wt-agents/env-$name.sh"; fi
  rm -f "${WT_DASHBOARD_DATA:-$HOME/.local/share/wt-dashboard}/pane-keys/$pane"
  # WP-148/348: a deliberate rm forgets the agent's row, so its number is free again (pause and respawn pass --keep-row).
  if [ -n "$name" ] && [ -z "$keep_row" ]; then
    dash_curl -X POST "${HERDR_DASH_URL:-http://127.0.0.1:7777}/api/agents/by-name/$name/forget" >/dev/null 2>&1 || true
  fi
  echo "removed $target ($pane, was $status)"
  ;;

respawn)
  core_up
  # WP-125: the kill shims and the launcher are the terminal's ENV/program, fixed at its start, so a respawn ends the terminal
  # and starts a new one under the same name (hc cannot start a program into an existing terminal; names are unique among live ones).
  self=$here/$(basename "$0")
  force=; stale=; target=
  for a in "$@"; do case "$a" in --force) force=--force ;; --stale) stale=1 ;; *) target=$a ;; esac; done
  respawn_one() {  # <name|id> -> prints "<name> <new-id>"
    . "$here/../../wt-shared/scripts/agent-pane.sh"
    row=$(node "$ah" find "$1" 2>/dev/null || true)
    if [ -z "$row" ]; then
      # WP-348: a missing agent (gone from hc) is respawnable from its agents-table row: name, role, cwd and session.
      row=$(agent_row "$1" | jq -c 'select(.state == "missing" or .state == "exited") | {name, pane_id: "", cwd, agent_status: "idle", agent_session: {value: .session}, tokens: ({role, persona, project, ticket} | with_entries(select(.value != null)))}' 2>/dev/null)
    fi
    [ -n "$row" ] || { echo "no such agent: $1" >&2; return 1; }
    require_pack_agent "$row" "$1" || return 1
    name=$(printf '%s' "$row" | jq -r '.name // empty'); old=$(printf '%s' "$row" | jq -r .pane_id)
    r=$(printf '%s' "$row" | jq -r '.tokens.role // empty'); dir=$(printf '%s' "$row" | jq -r '.cwd // empty')
    sess=$(printf '%s' "$row" | jq -r '.agent_session.value // empty')
    m=$(printf '%s' "$row" | jq -r '.tokens.model // empty'); e=$(printf '%s' "$row" | jq -r '.tokens.effort // empty')
    # D8: a terminal recovered by hc's keep is a shell with no labels, and claude's own list does not know a dead session:
    # the dashboard's agents-table row is the identity (role, cwd, session).
    if [ -z "$r" ] || [ -z "$sess" ]; then
      ar=$(agent_row "${name:-$1}" 2>/dev/null || true)
      [ -n "$r" ] || r=$(printf '%s' "$ar" | jq -r '.role // empty' 2>/dev/null || true)
      [ -n "$sess" ] || sess=$(printf '%s' "$ar" | jq -r '.session // empty' 2>/dev/null || true)
      [ -n "$dir" ] || dir=$(printf '%s' "$ar" | jq -r '.cwd // empty' 2>/dev/null || true)
    fi
    [ -n "$name" ] && [ -n "$r" ] && [ -n "$dir" ] || { echo "$1: needs a name, a role label and a cwd to respawn" >&2; return 1; }
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
    if [ -n "$pn" ] && node "$here/../../wt-shared/scripts/roles.mjs" resolve "$pn" --cwd "$dir" >/dev/null 2>&1; then r=$pn; fi
    [ -z "$old" ] || "$self" rm "$old" --force --keep-row >/dev/null || return 1
    out=$(cd "$dir" && "$self" spawn "$r" "$dir" --label "$name" ${sess:+--resume "$sess"} ${m:+--model "$m"} ${e:+--effort "$e"}) || return 1
    new=${out#* }
    # Spawn writes its own pool/role/project/spawned_by/created/model/effort; carry the rest (task, ticket, task_state, team …) over.
    carry=$(printf '%s' "$row" | jq -r '.tokens // {} | del(.role, .persona, .project, .spawned_by, .created, .model, .effort, ."wt.pool", ."herdr.space", ."herdr.tab") | to_entries[] | "\(.key)=\(.value)"')
    if [ -n "$carry" ]; then
      # one label call per pair keeps a value with spaces intact and a dropped pair from failing the rest
      printf '%s\n' "$carry" | while IFS= read -r kv; do node "$ah" label "$new" "$kv" >/dev/null 2>&1 || true; done
    fi
    echo "$out"
  }
  if [ -z "$stale" ]; then respawn_one "${target:?name, id or --stale required}"; exit; fi

  # --stale: every agent in this repo's pools whose claude lacks the PATH shim or predates the installed plugin guard.
  main=$(repo_root "$PWD"); repo=$(basename "$main")
  me=${HC_TERMINAL_ID:-}
  ip=$(node -e 'try{console.log(require(process.argv[1]).plugins["wt-memory@wt-pack"][0].installPath)}catch{}' "$HOME/.claude/plugins/installed_plugins.json" 2>/dev/null || true)
  g=0; [ -n "$ip" ] && [ -d "$ip" ] && g=$(stat -c %W "$ip" 2>/dev/null || stat -f %B "$ip" 2>/dev/null || echo 0)
  # WP-213: no installed plugin but the checkout loaded as the plugin (CLAUDE_CODE_PLUGIN_DIRS): its hooks file's mtime.
  if [ "$g" = 0 ]; then
    pd=$(node -e 'try{const e=require(process.argv[1]).env?.CLAUDE_CODE_PLUGIN_DIRS||"";console.log(e.split(":").filter(Boolean)[0]||"")}catch{}' "$HOME/.claude/settings.json" 2>/dev/null || true)
    [ -n "$pd" ] && [ -f "$pd/hooks/hooks.json" ] && g=$(stat -c %Y "$pd/hooks/hooks.json" 2>/dev/null || stat -f %m "$pd/hooks/hooks.json" 2>/dev/null || echo 0)
  fi
  found=0
  for name in $(node "$ah" pools "$repo-" "$me"); do
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
