#!/usr/bin/env bash
# wt-watch-prs (WP-116): the mechanical half of the PR reviewer loop. Judgement lives in ../SKILL.md.
#   preflight                        HARD fail / DEGRADED lines; exit 1 on any hard failure
#   identity                         reviewer login + token source; exit 1 when unresolved
#                                    (WT_REVIEWER_LOGIN / ~/.config/gh-reviewer-login: declared default-login reviewer)
#   gh <args…>                       run gh as the reviewer identity (the token never leaves this process)
#   poll-shas [--once]               "PR #n — new commits <sha> — …" / "PR #n — NO LONGER OPEN — …", every 60s
#   poll-replies --session S [--once]  human replies on holds this session placed, every 90s
#   claim N S | release N S          atomic per-PR claim (mkdir)
#   record N <sha40> <state> <outcome|-> S [--by NAME] [--coverage full|partial]   write reviewed[N] under the
#                                    state lock (- = outcome from stdin); --by remembers the reviewer agent for
#                                    re-dispatch (WP-121); --coverage flags a thin review for merge-time re-review (WP-176)
#   mode [dispatch|review|owner/repo]  dispatch | review | standalone (no arg: the pane's role token)
#   dispatch N --sha <40> --session D  claim under D, hand the head to a pool reviewer (never reads a diff);
#                                    exit 1 held or handoff failed, exit 3 queued at maxReviewers
#   gate N                           green | red | pending | none   (GitHub Actions check runs only)
#   describes N                      ok | no-body | branch-title
#   diff N S [--sha SHA]             pinned-ref diff: delta vs the recorded head when it is an ancestor, else full
#   register --session S              WP-187: from inside a repo checkout, add this repo/pane/cwd to the
#                                    background poller's watch list ($WT_WATCH_PRS_HOME/watchers.json)
#   unregister --session S            remove this repo/session from the watch list
#   poller-status                     exit 0 when the poller's launchd agent (Linux: systemd unit, if installed) is up and its heartbeat
#                                    ($WT_WATCH_PRS_HOME/poller.beat) is <3 min old; else exit 1
#   poller-install | poller-uninstall  WP-191: idempotently install/remove the poller as a launchd agent (macOS) or systemd
#                                    user unit (Linux) that runs the stable shim <state>/bin/watch-prs — works from a plugin-only
#                                    install (no ./setup); no sudo, prints linger advice; with no launchd/systemd (a container) WP-192
#                                    runs it detached under $WT_WATCH_PRS_HOME/poller.pid, killed by that pid on uninstall
#   serve [--once]                    WP-187: the poller itself — for each registered watcher, poll-shas/
#                                    poll-replies --once and deliver each line via handoff.sh --kind system;
#                                    run by launchd (id.local.wtpack.watchprs) or systemd (wt-watch-prs.service), never by an interactive session
# State: ${WT_WATCH_PRS_HOME:-~/.local/share/wt-watch-prs}/{watchers.json,poller.beat,unwatched.json,
#   <owner>-<repo>/{state.json,claims/,state.lock,poll/}}. poll/ (WP-187) persists poll-shas' and poll-replies'
# dedupe baselines across process restarts: shas.fired, replies-<S>.seen, replies-<S>.since (poll-shas' own
# vanished-PR baseline is reseeded from state.json each start instead, WP-188). The
# dashboard reads state.json for held PRs (Inbox pr-held) and unwatched.json for poller notices (Inbox server).
# Test knobs: WATCH_PRS_POLLS, WATCH_PRS_SLEEP, WATCH_PRS_TTL, WATCH_PRS_HANDOFF.
set -u
here=$(cd "$(dirname "$0")" && pwd)
die() { echo "watch-prs: $*" >&2; exit 1; }

repo() {
  local r; r=$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null) || r=""
  printf '%s\n' "$r" | grep -qE '^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$' || return 1
  echo "$r"
}
setup() {
  REPO=$(repo) || die "cannot resolve owner/repo (gh repo view in this checkout)"
  SD="${WT_WATCH_PRS_HOME:-$HOME/.local/share/wt-watch-prs}/${REPO/\//-}"
  STATE="$SD/state.json"; CLAIMS="$SD/claims"
  mkdir -p "$CLAIMS"; [ -s "$STATE" ] || echo '{"reviewed":{}}' > "$STATE"
}
num() { printf '%s' "$1" | grep -qE '^[0-9]+$' || die "bad PR number: $1"; }
sess() { printf '%s' "$1" | grep -qE '^[a-z0-9-]{4,16}$' || die "bad session id (want [a-z0-9-]{4,16}): $1"; }

# Reviewer token: project setting reviewerGithubAccount → gh keyring; else GH_REVIEWER_TOKEN_FILE; else none
# (default identity). Printed only into a variable, never to stdout of a subcommand.
token() {
  TOKSRC="default identity"
  local acct t f="${GH_REVIEWER_TOKEN_FILE:-$HOME/.config/gh-reviewer-token}"
  acct=$(node "$here/../../wt-shared/scripts/project-setting.mjs" get reviewerGithubAccount --cwd . 2>/dev/null)
  if [ -n "$acct" ]; then
    t=$(gh auth token --user "$acct" 2>/dev/null) && [ -n "$t" ] && { TOKSRC="account $acct"; printf '%s' "$t"; return 0; }
    TOKSRC="default identity (no gh token for $acct)"; return 1
  fi
  [ -s "$f" ] && { TOKSRC="token file"; tr -d '[:space:]' < "$f"; return 0; }
  return 1
}
# WP-126: a machine whose default gh login IS the reviewer account (e.g. a remote box with no dashboard) declares it:
# WT_REVIEWER_LOGIN (start.sh or the pane env), else ${GH_REVIEWER_LOGIN_FILE:-~/.config/gh-reviewer-login}.
# It only relabels the default identity after the login is checked; it never supplies a token.
declared() {
  local d=${WT_REVIEWER_LOGIN:-} f="${GH_REVIEWER_LOGIN_FILE:-$HOME/.config/gh-reviewer-login}"
  [ -n "$d" ] || { [ -s "$f" ] && d=$(tr -d '[:space:]' < "$f"); }
  printf '%s' "$d" | grep -qE '^[A-Za-z0-9-]{1,39}$' && printf '%s' "$d"
}
# resolve: sets SRC and WHO; a default identity that matches the declared reviewer is not degraded.
resolve() {
  local d; token >/dev/null; SRC=$TOKSRC; WHO=$(login)
  # Only the plain default: a configured account without a token stays degraded whatever is declared.
  case "$SRC" in "default identity") d=$(declared) || return 0
    if [ -n "$WHO" ] && [ "$WHO" = "$d" ]; then SRC="default identity (declared reviewer $d)"
    else SRC="$SRC — declared reviewer $d, but gh is ${WHO:-unresolved}"; fi;; esac
}
rgh() { local t; if t=$(token); then GH_TOKEN="$t" gh "$@"; else gh "$@"; fi; }
login() { rgh api user -q .login 2>/dev/null; }

cmd=${1:-}; shift || true
case "$cmd" in
preflight)
  hard=0
  for b in gh git jq; do command -v "$b" >/dev/null 2>&1 || { echo "HARD fail: $b not on PATH"; hard=1; }; done
  if [ "$hard" -eq 0 ]; then
    gh auth status >/dev/null 2>&1 || { echo "HARD fail: gh not authenticated (gh auth login)"; hard=1; }
    git rev-parse --git-dir >/dev/null 2>&1 || { echo "HARD fail: not inside a git repository"; hard=1; }
    [ "$hard" -eq 0 ] && { r=$(repo) || { echo "HARD fail: cannot resolve owner/repo (gh repo view)"; hard=1; }; }
  fi
  [ "$hard" -eq 0 ] || exit 1
  resolve; src=$SRC; who=$WHO
  case "$src" in *"(declared reviewer "*) ;; default*) echo "DEGRADED: no reviewer identity ($src) — posting as ${who:-?}: comment only, never approve";; esac
  [ -n "$who" ] || echo "DEGRADED: cannot read the posting login (gh api user)"
  date -u -v-15M +%Y >/dev/null 2>&1 || date -u -d '15 minutes ago' +%Y >/dev/null 2>&1 \
    || echo "DEGRADED: date has neither -v nor -d — reply backfill starts at now"
  echo "ok: $r as ${who:-?} ($src)"
  ;;
identity)
  resolve
  [ -n "$WHO" ] || die "reviewer identity unresolved ($SRC)"
  echo "$WHO $SRC"
  ;;
gh) case "${1:-}" in auth|extension|ext|alias|config) die "gh $1 is refused here (it could print or keep the reviewer token)";; esac; rgh "$@" ;;
claim|release)
  num "${1:-}"; sess "${2:-}"; setup; C="$CLAIMS/pr$1"
  if [ "$cmd" = release ]; then
    [ "$(head -1 "$C/owner" 2>/dev/null)" = "$2" ] || die "PR #$1 is not claimed by $2"
    rm -f "$C/owner" && rmdir "$C" && echo released; exit
  fi
  if mkdir "$C" 2>/dev/null; then printf '%s\n%s\n' "$2" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$C/owner"; echo claimed; exit 0; fi
  o=$(head -1 "$C/owner" 2>/dev/null); [ -n "$o" ] || { sleep 1; o=$(head -1 "$C/owner" 2>/dev/null); }
  echo "held by ${o:-UNKNOWN (empty owner — suspect a dead session)} since $(sed -n 2p "$C/owner" 2>/dev/null)"; exit 1
  ;;
record)
  [ $# -ge 5 ] || die "usage: record N <sha40> <state> <outcome|-> S [--by NAME] [--coverage full|partial]"
  n=$1; shaval=$2; st=$3; note=$4; s=$5; shift 5
  by=""; cov=""
  while [ $# -gt 0 ]; do case "$1" in
    --by|--coverage) [ $# -ge 2 ] || die "usage: record N <sha40> <state> <outcome|-> S [--by NAME] [--coverage full|partial]"
      [ "$1" = --by ] && by=$2 || cov=$2; shift 2;;
    *) die "usage: record N <sha40> <state> <outcome|-> S [--by NAME] [--coverage full|partial]";;
  esac; done
  num "$n"; sess "$s"; setup
  [ -z "$by" ] || printf '%s' "$by" | grep -qE '^[a-z0-9_-]{1,32}$' || die "bad --by agent name: $by"
  [ -z "$cov" ] || case "$cov" in full|partial) ;; *) die "bad --coverage: $cov";; esac
  printf '%s' "$shaval" | grep -qE '^[0-9a-f]{40}$' || die "record needs the full 40-char head SHA (gh pr view $n --json headRefOid)"
  case "$st" in approved|changes-requested|commented|merged|closed|open) ;; *) die "bad state: $st";; esac
  [ "$note" = - ] && note=$(cat)
  L="$SD/state.lock"; for _ in 1 2 3 4 5 6 7 8 9 10; do mkdir "$L" 2>/dev/null && break; sleep 1; done
  [ -d "$L" ] || die "state lock held (stale? check $L mtime and remove by hand)"
  trap 'rmdir "$L" 2>/dev/null' EXIT
  jq --arg n "$n" --arg sha "$shaval" --arg st "$st" --arg note "$note" --arg s "$s" --arg by "$by" --arg cov "$cov" \
    '.reviewed[$n] = ({sha: $sha, state: $st, outcome: $note, reviewer_session: $s} + (if $by == "" then {} else {reviewer: $by} end) + (if $cov == "" then {} else {coverage: $cov} end))' "$STATE" > "$STATE.tmp" \
    && mv "$STATE.tmp" "$STATE"
  ;;
gate)
  num "${1:-}"; setup
  gh pr view "$1" --repo "$REPO" --json statusCheckRollup 2>/dev/null | jq -r '
    [ .statusCheckRollup[]? | select(.__typename == "CheckRun") | select((.name | test("informational"; "i")) | not) ] as $c
    | if ($c | length) == 0 then "none"
      elif any($c[]; .conclusion | IN("FAILURE","TIMED_OUT","ACTION_REQUIRED","STARTUP_FAILURE")) then "red"
      elif any($c[]; .conclusion | IN("CANCELLED","SKIPPED","STALE","NEUTRAL")) then "pending"
      elif any($c[]; .status != "COMPLETED") then "pending"
      else "green" end' 2>/dev/null | grep . || echo none
  ;;
describes)
  num "${1:-}"; setup
  gh pr view "$1" --repo "$REPO" --json title,body,author 2>/dev/null | jq -r '
    if (.author.login | test("\\[bot\\]$|^app/")) then "ok"
    elif ((.body // "") | gsub("\\s"; "") | length) == 0 then "no-body"
    elif (.title | test("^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+")) then "branch-title"
    else "ok" end' 2>/dev/null | grep . || echo ok
  ;;
diff)
  num "${1:-}"; sess "${2:-}"; P=$1; S=$2; shift 2; want=""
  [ "${1:-}" = --sha ] && want=${2:-}
  setup
  MAIN=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")
  base=$(node "$here/../../wt-shared/scripts/project-setting.mjs" get baseBranch --cwd . 2>/dev/null)
  [ -n "$base" ] || base=$(git -C "$MAIN" symbolic-ref -q --short refs/remotes/origin/HEAD 2>/dev/null | sed 's|^origin/||')
  [ -n "$base" ] || base=main
  REF="refs/review/$S/pr-$P-head"; BASE="refs/review/$S/pr-$P-base"  # per PR: dispatched reviews share one session
  for i in 1 2 3; do git -C "$MAIN" fetch --no-tags -f -q origin "refs/pull/$P/head:$REF" "$base:$BASE" && break; sleep 2; done
  head=$(git -C "$MAIN" rev-parse -q --verify "$REF") || die "could not fetch refs/pull/$P/head"
  [ -z "$want" ] || [ "$head" = "$want" ] || die "ref $head != reported head $want — aborting"
  old=$(jq -r --arg n "$P" '.reviewed[$n].sha // ""' "$STATE")
  if [ -n "$old" ] && [ "$old" != "$head" ] && git -C "$MAIN" merge-base --is-ancestor "$old" "$REF" 2>/dev/null; then
    echo "# DELTA $old..$head (reviewed head is an ancestor)"; git -C "$MAIN" diff "$old" "$REF"
  else
    [ -n "$old" ] && [ "$old" != "$head" ] && echo "# FULL review: $old is not an ancestor of $head (force-push/rebase)"
    echo "# FULL $base...$head"; git -C "$MAIN" diff "$BASE...$REF"
  fi
  ;;
mode)
  case "${1:-}" in dispatch|review) echo "$1"; exit 0;; '') ;;
    *) printf '%s' "$1" | grep -qE '^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$' && { echo standalone; exit 0; }; die "mode: dispatch, review or owner/repo, not $1";; esac
  role=""; command -v herdr >/dev/null 2>&1 && [ -n "${HERDR_PANE_ID:-}" ] \
    && role=$(herdr pane get "$HERDR_PANE_ID" 2>/dev/null | jq -r '.result.pane.tokens.role // empty' 2>/dev/null)
  case "$role" in orchestrator) echo dispatch;; *) echo standalone;; esac
  ;;
dispatch)
  num "${1:-}"; P=$1; shift; X=""; D=""
  while [ $# -gt 0 ]; do case "$1" in --sha) X=${2:-}; shift 2;; --session) D=${2:-}; shift 2;; *) die "unknown arg $1";; esac; done
  printf '%s' "$X" | grep -qE '^[0-9a-f]{40}$' || die "dispatch needs --sha <40-char head SHA>"
  sess "$D"; setup
  # The reviewer replies to this pane (handoff's footer), and only that reply releases the claim.
  command -v herdr >/dev/null 2>&1 && [ -n "$(herdr pane get "${HERDR_PANE_ID:-none}" 2>/dev/null | jq -r '.result.pane.pane_id // empty' 2>/dev/null)" ] \
    || die "dispatch needs a herdr pane (the reviewer replies to it)"
  # Held by D itself = an earlier dispatch whose reviewer never replied (died, stopped): hand it again, keep the claim.
  c=$("$0" claim "$P" "$D") || { [ "$(head -1 "$CLAIMS/pr$P/owner" 2>/dev/null)" = "$D" ] || { echo "$c"; exit 1; }; }
  undo() { "$0" release "$P" "$D" >/dev/null 2>&1; }
  MAIN=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")
  ag=$(herdr agent list 2>/dev/null) || ag='{}'
  ws=$(herdr workspace list 2>/dev/null | jq -r --arg l "$(basename "$MAIN")-reviewers" '.result.workspaces[]? | select(.label == $l) | .workspace_id' | head -1)
  # The reviewer that held this PR gets it back when free; else handoff reuses a free pool reviewer or spawns one.
  prev=$(jq -r --arg n "$P" '.reviewed[$n].reviewer // ""' "$STATE")
  pane=""; [ -n "$prev" ] && pane=$(printf '%s' "$ag" | jq -r --arg n "$prev" '.result.agents[]? | select(.name == $n and (.agent_status == "idle" or .agent_status == "done")) | .pane_id' | head -1)
  # WP-147: a paired ticket's branch (wp-N-…) routes the review to its buddy instead — the pairing is the
  # deliberate choice, so it wins over both the last reviewer and a free pool pick.
  T="$here/../../wt-ticket/scripts/wt-ticket"
  branch=$(rgh pr view "$P" --repo "$REPO" --json headRefName 2>/dev/null | jq -r '.headRefName // empty')
  if [ -n "$branch" ] && [ -x "$T" ]; then
    keys=$("$T" keys 2>/dev/null | tr '\n' '|')
    tk=$(printf '%s' "$branch" | { [ -n "$keys" ] && grep -oiE "(^|[^a-z])(${keys%|})-[0-9]+" || true; } | grep -oiE '[a-z]+-[0-9]+$' | head -1 | tr '[:lower:]' '[:upper:]')
    if [ -n "$tk" ]; then
      bpane=$("$T" show "$tk" --json 2>/dev/null | jq -r '.pair.buddy.pane // empty')
      [ -n "$bpane" ] && pane=$bpane
    fi
  fi
  if [ -z "$pane" ]; then
    free=$(printf '%s' "$ag" | jq --arg w "$ws" '[.result.agents[]? | select(.workspace_id == $w and (.agent_status == "idle" or .agent_status == "done"))] | length')
    live=$(printf '%s' "$ag" | jq --arg w "$ws" '[.result.agents[]? | select(.workspace_id == $w)] | length')
    max=$(node "$here/../../wt-shared/scripts/project-setting.mjs" get maxReviewers --cwd "$MAIN" 2>/dev/null); max=${max:-2}
    # ponytail: counts from one agent list — two dispatches in the same second can both spawn (cap +1 at worst).
    { [ "$max" -gt 0 ] && { [ "${free:-0}" -gt 0 ] || [ "${live:-0}" -lt "$max" ]; }; } || { undo; echo "queued: at maxReviewers ($max)"; exit 3; }
  fi
  H=${WATCH_PRS_HANDOFF:-$here/../../wt-handoff/scripts/handoff.sh}
  # --no-goal: a review is one run that stops. The body carries D: the reviewer records under it, no claim/release.
  # "Use wt-watch-prs …", not a /slash command: a plugin install namespaces it (/wt-pack:wt-watch-prs, WP-122).
  out=$(printf 'Use wt-watch-prs to review %s --sha %s --session %s' "$P" "$X" "$D" \
    | "$H" --role reviewer --kind dispatch --pr "$P" --sha "$X" --skill wt-watch-prs ${pane:+--pane "$pane"} --no-goal "$MAIN") \
    || { undo; die "handoff failed for #$P${out:+: $out}"; }
  echo "dispatched #$P to $(printf '%s\n' "$out" | sed -n 's/^target \([^ ]*\) .*/\1/p' | head -1)"
  ;;
poll-shas)
  [ "${1:-}" = --once ] && WATCH_PRS_POLLS=1
  setup; polls=${WATCH_PRS_POLLS:-0}; TTL=${WATCH_PRS_TTL:-900}
  PD="$SD/poll"; mkdir -p "$PD"; PF="$PD/shas.fired"
  T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
  # WP-188: seed the vanished-PR baseline from $STATE instead of a persisted file, so a PR that merges/closes in
  # the gap between a dying process and its restart (routine since WP-186's 30-min re-arm, and for WP-187's
  # serve loop) is still caught on the very first poll — every PR this repo has ever reviewed and not yet
  # recorded merged/closed is "was open". $T/prev is then kept current in-process same as before.
  jq -r '.reviewed | to_entries[] | select(.value.state != "merged" and .value.state != "closed") | .key' "$STATE" 2>/dev/null | sort -u > "$T/prev"
  # WP-187: fired (the TTL announce-dedupe) still needs its own persisted file — state.json has no per-SHA
  # "already announced" record, so a restart within the TTL would re-announce every SHA it just reported.
  [ -f "$PF" ] && cp "$PF" "$T/fired" || : > "$T/fired"
  # Best-effort under the shared state lock: a stuck lock must never block the polling loop itself, only
  # delay how current the persisted fired-set is (the in-memory $T/fired stays authoritative meanwhile).
  persist() {
    local L="$SD/state.lock" i2
    for i2 in 1 2 3 4 5; do mkdir "$L" 2>/dev/null && break; sleep 0.2; done
    [ -d "$L" ] || return 0
    cp "$T/fired" "$PF" 2>/dev/null
    rmdir "$L" 2>/dev/null
  }
  seen() { # exact, or a stored short SHA that prefixes the head (else a short record re-fires forever)
    local s; s=$(jq -r --arg n "$1" '.reviewed[$n].sha // ""' "$STATE" 2>/dev/null)
    [ -n "$s" ] || return 1; [ "$2" = "$s" ] && return 0
    [ ${#s} -lt 40 ] && case "$2" in "$s"*) return 0;; esac; return 1
  }
  fired() { # announced within the TTL — by this process, or an earlier one via the persisted seed; expired lines drop out
    local now hit=1; now=$(date +%s); : > "$T/f2"
    while read -r fn fs ft; do
      [ $((now - ft)) -ge "$TTL" ] && continue
      echo "$fn $fs $ft" >> "$T/f2"; [ "$fn $fs" = "$1 $2" ] && hit=0
    done < "$T/fired"; mv "$T/f2" "$T/fired"; return $hit
  }
  i=0
  while :; do
    gh pr list --repo "$REPO" --state open --limit 50 --json number,headRefOid,author,title,isDraft 2>/dev/null \
      | jq -r '.[] | select(.isDraft == false) | "\(.number) \(.headRefOid) \(.author.login) \(.title)"' 2>/dev/null > "$T/cur" || true
    while read -r n sha who title; do
      [ -z "$n" ] && continue
      seen "$n" "$sha" && continue; [ -d "$CLAIMS/pr$n" ] && continue; fired "$n" "$sha" && continue
      echo "$n $sha $(date +%s)" >> "$T/fired"; echo "PR #$n — new commits $sha — $who: $title"
    done < "$T/cur"
    # A vanished PR is reported only after gh pr view confirms MERGED/CLOSED; an empty poll is a gh blip.
    : > "$T/keep"
    if [ -s "$T/cur" ]; then
      awk '{print $1}' "$T/cur" | sort -u > "$T/nums"
      [ -s "$T/prev" ] && comm -23 "$T/prev" "$T/nums" | while read -r g; do
        info=$(gh pr view "$g" --repo "$REPO" --json state,title,author 2>/dev/null | jq -r '"\(.state) — \(.author.login): \(.title)"' 2>/dev/null)
        case "$info" in MERGED*|CLOSED*) echo "PR #$g — NO LONGER OPEN — $info";; *) echo "$g" >> "$T/keep";; esac
      done
      sort -u "$T/nums" "$T/keep" > "$T/prev"
    fi
    persist
    i=$((i + 1)); [ "$polls" -gt 0 ] && [ "$i" -ge "$polls" ] && break
    sleep "${WATCH_PRS_SLEEP:-60}"
  done
  ;;
poll-replies)
  S=""; polls=${WATCH_PRS_POLLS:-0}
  while [ $# -gt 0 ]; do case "$1" in --session) S=${2:-}; shift 2;; --once) polls=1; shift;; *) die "unknown arg $1";; esac; done
  sess "$S"; setup
  SELF=$(login); [ -n "$SELF" ] || die "SELF is unresolved — refusing to watch replies (it would wake on its own holds)"
  PD="$SD/poll"; mkdir -p "$PD"; SEENF="$PD/replies-$S.seen"; SINCEF="$PD/replies-$S.since"
  T=$(mktemp); trap 'rm -f "$T"' EXIT
  # WP-188: seed the seen-id set and the reply cursor from disk, so a re-armed/restarted process does not
  # re-widen its window back to 15 minutes and does not re-announce ids it already reported.
  [ -f "$SEENF" ] && cp "$SEENF" "$T" || : > "$T"
  if [ -s "$SINCEF" ]; then SINCE=$(cat "$SINCEF")
  else SINCE=$(date -u -v-15M +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '15 minutes ago' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ); fi
  persist() { # best-effort, same rationale as poll-shas' persist
    local L="$SD/state.lock" i2
    for i2 in 1 2 3 4 5; do mkdir "$L" 2>/dev/null && break; sleep 0.2; done
    [ -d "$L" ] || return 0
    cp "$T" "$SEENF" 2>/dev/null; printf '%s' "$SINCE" > "$SINCEF" 2>/dev/null
    rmdir "$L" 2>/dev/null
  }
  i=0
  while :; do
    # The next poll asks only for what is newer than this one's start (a minute of overlap; ids dedupe), so a busy
    # held PR never pins the 50-comment page to its oldest replies.
    next=$(date -u -v-1M +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '1 minute ago' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "$SINCE")
    for n in $(jq -r --arg me "$S" '.reviewed | to_entries[] | select(.value.state == "changes-requested" and .value.reviewer_session == $me) | .key' "$STATE" 2>/dev/null); do
      { gh api "repos/$REPO/issues/$n/comments?since=$SINCE&per_page=50" 2>/dev/null \
          | jq -r --arg self "$SELF" '.[] | select(.user.type != "Bot" and .user.login != $self) | "C\(.id)\t\(.user.login)\tREPLY\t\(.body | gsub("\\s+"; " ") | .[0:200])"' 2>/dev/null
        gh api --paginate "repos/$REPO/pulls/$n/reviews?per_page=100" 2>/dev/null | jq -s 'add // []' 2>/dev/null \
          | jq -r --arg self "$SELF" --arg since "$SINCE" '.[] | select(.user.type != "Bot" and .user.login != $self and .submitted_at > $since) | "R\(.id)\t\(.user.login)\tREVIEW (\(.state))\t\(.body // "" | gsub("\\s+"; " ") | .[0:160])"' 2>/dev/null
      } | while IFS=$'\t' read -r id who kind body; do
        [ -z "$id" ] && continue; grep -qx "$n $id" "$T" && continue; echo "$n $id" >> "$T"
        echo "PR #$n — $kind on a held PR — $who: $body"
      done
    done
    SINCE=$next; persist
    i=$((i + 1)); [ "$polls" -gt 0 ] && [ "$i" -ge "$polls" ] && break
    sleep "${WATCH_PRS_SLEEP:-90}"
  done
  ;;
register|unregister)
  S=""
  while [ $# -gt 0 ]; do case "$1" in --session) S=${2:-}; shift 2;; *) die "unknown arg $1";; esac; done
  sess "$S"; setup
  WH="${WT_WATCH_PRS_HOME:-$HOME/.local/share/wt-watch-prs}"; mkdir -p "$WH"; WF="$WH/watchers.json"
  [ -s "$WF" ] || echo '[]' > "$WF"
  L="$WH/watchers.lock"; for i2 in 1 2 3 4 5 6 7 8 9 10; do mkdir "$L" 2>/dev/null && break; sleep 1; done
  [ -d "$L" ] || die "watchers lock held (stale? check $L mtime and remove by hand)"
  trap 'rmdir "$L" 2>/dev/null' EXIT
  if [ "$cmd" = unregister ]; then
    jq --arg repo "$REPO" --arg s "$S" '[.[] | select(.session != $s or .repo != $repo)]' "$WF" > "$WF.tmp" && mv "$WF.tmp" "$WF"
    echo "unregistered $REPO session $S"
  else
    # HERDR_PANE_ID may be the stable id, not the display id handoff.sh needs — resolve it (CLAUDE.md trap).
    pane=""; command -v herdr >/dev/null 2>&1 && [ -n "${HERDR_PANE_ID:-}" ] \
      && pane=$(herdr pane get "$HERDR_PANE_ID" 2>/dev/null | jq -r '.result.pane.pane_id // empty' 2>/dev/null)
    cwd=$(pwd)
    at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    jq --arg repo "$REPO" --arg pane "$pane" --arg s "$S" --arg cwd "$cwd" --arg at "$at" \
      '[.[] | select(.session != $s or .repo != $repo)] + [{repo:$repo, pane:$pane, session:$s, cwd:$cwd, at:$at}]' "$WF" > "$WF.tmp" && mv "$WF.tmp" "$WF"
    echo "registered $REPO session $S${pane:+ pane $pane}"
  fi
  ;;
poller-install|poller-uninstall)
  command -v node >/dev/null 2>&1 || die "$cmd needs node on PATH"
  exec node "$here/poller-service.mjs" "${cmd#poller-}"
  ;;
poller-status)
  WH="${WT_WATCH_PRS_HOME:-$HOME/.local/share/wt-watch-prs}"; B="$WH/poller.beat"
  [ -f "$B" ] || { echo "poller: no heartbeat ($B)"; exit 1; }
  case "$(uname -s)" in
    Darwin) command -v launchctl >/dev/null 2>&1 && launchctl print "gui/$(id -u)/id.local.wtpack.watchprs" >/dev/null 2>&1 \
      || { echo "poller: launchd agent not loaded"; exit 1; } ;;
    Linux) # WP-190: a systemd unit, when installed, must be active; a hand-run (nohup) poller has none and only needs the beat
      U="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/wt-watch-prs.service"
      P="$WH/poller.pid" # WP-192: a detached poller (no systemd) records its pid; a hand-run one has neither unit nor pidfile
      if [ -f "$U" ]; then systemctl --user is-active --quiet wt-watch-prs.service 2>/dev/null \
        || { echo "poller: systemd unit wt-watch-prs.service not active"; exit 1; }
      elif [ -f "$P" ]; then kill -0 "$(cat "$P" 2>/dev/null)" 2>/dev/null || { echo "poller: detached pid $(cat "$P" 2>/dev/null) is not running"; exit 1; }; fi ;;
  esac
  now=$(date +%s); mt=$(stat -c %Y "$B" 2>/dev/null || stat -f %m "$B" 2>/dev/null || echo 0) # GNU -c first: GNU `stat -f` succeeds with filesystem info (WP-193)
  age=$((now - mt))
  if [ "$age" -lt 180 ]; then echo "poller: loaded, beat ${age}s ago"; exit 0
  else echo "poller: loaded, beat ${age}s ago (stale)"; exit 1; fi
  ;;
serve)
  [ "${1:-}" = --once ] && WATCH_PRS_POLLS=1
  polls=${WATCH_PRS_POLLS:-0}
  WH="${WT_WATCH_PRS_HOME:-$HOME/.local/share/wt-watch-prs}"; mkdir -p "$WH"
  WF="$WH/watchers.json"; [ -s "$WF" ] || echo '[]' > "$WF"
  UW="$WH/unwatched.json"; [ -s "$UW" ] || echo '[]' > "$UW"
  FC="$WH/unconsumed"; mkdir -p "$FC"  # per-pane consecutive handoff-failure counters
  HANDOFF=${WATCH_PRS_HANDOFF:-"$here/../../wt-handoff/scripts/handoff.sh"}
  mark_unwatched() { # repo reason — best-effort append, capped at the last 50 rows, under watchers.lock
    local repo="$1" reason="$2" at L2
    at=$(date -u +%Y-%m-%dT%H:%M:%SZ); L2="$WH/watchers.lock"
    for i2 in 1 2 3 4 5; do mkdir "$L2" 2>/dev/null && break; sleep 0.2; done
    [ -d "$L2" ] || return 0
    jq --arg repo "$repo" --arg reason "$reason" --arg at "$at" '(. + [{repo:$repo, reason:$reason, at:$at}]) | .[-50:]' "$UW" > "$UW.tmp" 2>/dev/null && mv "$UW.tmp" "$UW"
    rmdir "$L2" 2>/dev/null
  }
  # WP-196: a beat older than 3 min at start-up means the poller was down (hung and killed, crashed, box asleep):
  # tell each registered pane once, after its first successful poll, so the session knows there was a gap.
  gap=0
  if [ -f "$WH/poller.beat" ]; then
    a=$(( $(date +%s) - $(stat -c %Y "$WH/poller.beat" 2>/dev/null || stat -f %m "$WH/poller.beat" 2>/dev/null || echo 0) ))
    [ "$a" -ge 180 ] && gap=$a
  fi
  i=0; last_replies=0
  while :; do
    touch "$WH/poller.beat"
    # WP-196: under systemd (Type=notify, WatchdogSec) each beat also pets the watchdog; a hung serve stops petting it
    [ -n "${NOTIFY_SOCKET:-}" ] && command -v systemd-notify >/dev/null 2>&1 && systemd-notify --ready WATCHDOG=1 2>/dev/null
    now=$(date +%s); do_replies=0
    if [ $((now - last_replies)) -ge 90 ]; then do_replies=1; last_replies=$now; fi
    jq -c '.[]' "$WF" 2>/dev/null | while IFS= read -r w; do
      wrepo=$(printf '%s' "$w" | jq -r .repo); wpane=$(printf '%s' "$w" | jq -r .pane)
      wsess=$(printf '%s' "$w" | jq -r .session); wcwd=$(printf '%s' "$w" | jq -r .cwd)
      [ -n "$wcwd" ] && [ -d "$wcwd" ] || continue
      # a watcher with no resolved pane (herdr missing/failed at register time) can never deliver anything —
      # without this it polls forever as a silent black hole, never firing an unwatched notice.
      [ -n "$wpane" ] || { mark_unwatched "$wrepo" "no resolved pane at registration -- never delivered"; (cd "$wcwd" && "$0" unregister --session "$wsess" >/dev/null 2>&1); continue; }
      # decision 5 (1/3): the pane itself is gone.
      if command -v herdr >/dev/null 2>&1; then
        herdr pane get "$wpane" >/dev/null 2>&1 || { mark_unwatched "$wrepo" "reviewer pane $wpane is gone"; (cd "$wcwd" && "$0" unregister --session "$wsess" >/dev/null 2>&1); continue; }
      fi
      out=$(cd "$wcwd" && "$0" poll-shas --once 2>/dev/null)
      # the missed heads themselves need no replay step: poll-shas seeds from state.json, so this poll just found them
      [ "$gap" -gt 0 ] && out="wt-watch-prs: poller resumed after $((gap / 60))m; replayed missed heads${out:+
$out}"
      if [ "$do_replies" = 1 ] && [ -n "$wsess" ]; then
        out2=$(cd "$wcwd" && "$0" poll-replies --session "$wsess" --once 2>/dev/null)
        [ -n "$out2" ] && out="${out:+$out
}$out2"
      fi
      [ -n "$out" ] || continue
      printf '%s\n' "$out" | while IFS= read -r line; do
        [ -z "$line" ] && continue
        if printf '%s' "$line" | "$HANDOFF" --pane "$wpane" --kind system --no-goal --from wt-watch-prs "$wcwd" >/dev/null 2>&1; then
          rm -f "$FC/$wpane"
        else
          n=$(( $(cat "$FC/$wpane" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$FC/$wpane"
          # decision 5 (2/3): handoff has failed 3 times in a row for this pane.
          if [ "$n" -ge 3 ]; then
            mark_unwatched "$wrepo" "handoff to $wpane failed 3 times in a row"
            (cd "$wcwd" && "$0" unregister --session "$wsess" >/dev/null 2>&1)
            rm -f "$FC/$wpane"
          fi
        fi
      done
      # the handoff-failure branch above unregisters from inside a pipe subshell, so its effect on $wsess
      # doesn't reach this scope directly — re-read from disk to skip a redundant unwatched-notice below.
      still_watched=$(jq --arg s "$wsess" --arg repo "$wrepo" 'any(.[]; .session == $s and .repo == $repo)' "$WF" 2>/dev/null)
      [ "$still_watched" = "true" ] || continue
      # decision 5 (3/3): a delivered "new commits" event that is still neither claimed nor recorded 30 min
      # later, while poll-shas' own fired file says a delivery happened — the pane stopped acting on it.
      wsd="$WH/${wrepo/\//-}"
      [ -f "$wsd/poll/shas.fired" ] || continue
      while read -r fn fs ft; do
        [ -z "$fn" ] && continue
        [ $((now - ft)) -ge 1800 ] || continue
        [ -d "$wsd/claims/pr$fn" ] && continue
        recorded=$(jq -r --arg n "$fn" '.reviewed[$n].sha // ""' "$wsd/state.json" 2>/dev/null)
        [ "$recorded" = "$fs" ] && continue
        mark_unwatched "$wrepo" "PR #$fn's new-commits event from 30+ min ago is still neither claimed nor reviewed"
        (cd "$wcwd" && "$0" unregister --session "$wsess" >/dev/null 2>&1)
        break
      done < "$wsd/poll/shas.fired"
    done
    gap=0
    i=$((i + 1)); [ "$polls" -gt 0 ] && [ "$i" -ge "$polls" ] && break
    sleep "${WATCH_PRS_SLEEP:-60}"
  done
  ;;
*) sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'; [ -z "$cmd" ] || exit 2 ;;
esac
