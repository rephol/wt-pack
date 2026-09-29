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
# State: ${WT_WATCH_PRS_HOME:-~/.local/share/wt-watch-prs}/<owner>-<repo>/{state.json,claims/,state.lock}
# The dashboard reads state.json for held PRs (Inbox pr-held). Test knobs: WATCH_PRS_POLLS, WATCH_PRS_SLEEP,
# WATCH_PRS_TTL, WATCH_PRS_HANDOFF.
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
  T=$(mktemp -d); trap 'rm -rf "$T"' EXIT; : > "$T/fired"
  # WP-188: seed the vanished-PR baseline from $STATE instead of starting empty, so a PR that merges/closes in
  # the gap between a dying process and its restart (routine since WP-186's 30-min re-arm) is still caught on
  # the very first poll — every PR this repo has ever reviewed and not yet recorded merged/closed is "was open".
  jq -r '.reviewed | to_entries[] | select(.value.state != "merged" and .value.state != "closed") | .key' "$STATE" 2>/dev/null | sort -u > "$T/prev"
  seen() { # exact, or a stored short SHA that prefixes the head (else a short record re-fires forever)
    local s; s=$(jq -r --arg n "$1" '.reviewed[$n].sha // ""' "$STATE" 2>/dev/null)
    [ -n "$s" ] || return 1; [ "$2" = "$s" ] && return 0
    [ ${#s} -lt 40 ] && case "$2" in "$s"*) return 0;; esac; return 1
  }
  fired() { # announced by this process inside the TTL; expired lines drop out
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
    i=$((i + 1)); [ "$polls" -gt 0 ] && [ "$i" -ge "$polls" ] && break
    sleep "${WATCH_PRS_SLEEP:-60}"
  done
  ;;
poll-replies)
  S=""; polls=${WATCH_PRS_POLLS:-0}
  while [ $# -gt 0 ]; do case "$1" in --session) S=${2:-}; shift 2;; --once) polls=1; shift;; *) die "unknown arg $1";; esac; done
  sess "$S"; setup
  SELF=$(login); [ -n "$SELF" ] || die "SELF is unresolved — refusing to watch replies (it would wake on its own holds)"
  SINCE=$(date -u -v-15M +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '15 minutes ago' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ)
  T=$(mktemp); trap 'rm -f "$T"' EXIT; i=0
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
    SINCE=$next; i=$((i + 1)); [ "$polls" -gt 0 ] && [ "$i" -ge "$polls" ] && break
    sleep "${WATCH_PRS_SLEEP:-90}"
  done
  ;;
*) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; [ -z "$cmd" ] || exit 2 ;;
esac
