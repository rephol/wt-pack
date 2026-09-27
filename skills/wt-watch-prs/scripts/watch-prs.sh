#!/usr/bin/env bash
# wt-watch-prs (WP-116): the mechanical half of the PR reviewer loop. Judgement lives in ../SKILL.md.
#   preflight                        HARD fail / DEGRADED lines; exit 1 on any hard failure
#   identity                         reviewer login + token source; exit 1 when unresolved
#   gh <args…>                       run gh as the reviewer identity (the token never leaves this process)
#   poll-shas [--once]               "PR #n — new commits <sha> — …" / "PR #n — NO LONGER OPEN — …", every 60s
#   poll-replies --session S [--once]  human replies on holds this session placed, every 90s
#   claim N S | release N S          atomic per-PR claim (mkdir)
#   record N <sha40> <state> <outcome|-> S   write reviewed[N] under the state lock (- = outcome from stdin)
#   gate N                           green | red | pending | none   (GitHub Actions check runs only)
#   describes N                      ok | no-body | branch-title
#   diff N S [--sha SHA]             pinned-ref diff: delta vs the recorded head when it is an ancestor, else full
# State: ${WT_WATCH_PRS_HOME:-~/.local/share/wt-watch-prs}/<owner>-<repo>/{state.json,claims/,state.lock}
# The dashboard reads state.json for held PRs (Inbox pr-held). Test knobs: WATCH_PRS_POLLS, WATCH_PRS_SLEEP,
# WATCH_PRS_TTL.
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
  token >/dev/null; src=$TOKSRC; who=$(login)
  case "$src" in default*) echo "DEGRADED: no reviewer identity ($src) — posting as ${who:-?}: comment only, never approve";; esac
  [ -n "$who" ] || echo "DEGRADED: cannot read the posting login (gh api user)"
  date -u -v-15M +%Y >/dev/null 2>&1 || date -u -d '15 minutes ago' +%Y >/dev/null 2>&1 \
    || echo "DEGRADED: date has neither -v nor -d — reply backfill starts at now"
  echo "ok: $r as ${who:-?} ($src)"
  ;;
identity)
  token >/dev/null; who=$(login)
  [ -n "$who" ] || die "reviewer identity unresolved ($TOKSRC)"
  echo "$who $TOKSRC"
  ;;
gh) rgh "$@" ;;
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
  [ $# -eq 5 ] || die "usage: record N <sha40> <state> <outcome|-> S"
  num "$1"; sess "$5"; setup
  printf '%s' "$2" | grep -qE '^[0-9a-f]{40}$' || die "record needs the full 40-char head SHA (gh pr view $1 --json headRefOid)"
  case "$3" in approved|changes-requested|commented|merged|closed|open) ;; *) die "bad state: $3";; esac
  note=$4; [ "$note" = - ] && note=$(cat)
  L="$SD/state.lock"; for _ in 1 2 3 4 5 6 7 8 9 10; do mkdir "$L" 2>/dev/null && break; sleep 1; done
  [ -d "$L" ] || die "state lock held (stale? check $L mtime and remove by hand)"
  jq --arg n "$1" --arg sha "$2" --arg st "$3" --arg note "$note" --arg s "$5" \
    '.reviewed[$n] = {sha: $sha, state: $st, outcome: $note, reviewer_session: $s}' "$STATE" > "$STATE.tmp" \
    && mv "$STATE.tmp" "$STATE"; rc=$?; rmdir "$L"; exit $rc
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
  REF="refs/review/$S/pr-$P-head"; BASE="refs/review/$S/base"
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
poll-shas)
  [ "${1:-}" = --once ] && WATCH_PRS_POLLS=1
  setup; polls=${WATCH_PRS_POLLS:-0}; TTL=${WATCH_PRS_TTL:-900}
  T=$(mktemp -d); trap 'rm -rf "$T"' EXIT; : > "$T/fired"; : > "$T/prev"
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
    for n in $(jq -r --arg me "$S" '.reviewed | to_entries[] | select(.value.state == "changes-requested" and .value.reviewer_session == $me) | .key' "$STATE" 2>/dev/null); do
      { gh api "repos/$REPO/issues/$n/comments?since=$SINCE&per_page=50" 2>/dev/null \
          | jq -r --arg self "$SELF" '.[] | select(.user.type != "Bot" and .user.login != $self) | "C\(.id)\t\(.user.login)\tREPLY\t\(.body | gsub("\\s+"; " ") | .[0:200])"' 2>/dev/null
        gh api "repos/$REPO/pulls/$n/reviews?per_page=50" 2>/dev/null \
          | jq -r --arg self "$SELF" --arg since "$SINCE" '.[] | select(.user.type != "Bot" and .user.login != $self and .submitted_at > $since) | "R\(.id)\t\(.user.login)\tREVIEW (\(.state))\t\(.body // "" | gsub("\\s+"; " ") | .[0:160])"' 2>/dev/null
      } | while IFS=$'\t' read -r id who kind body; do
        [ -z "$id" ] && continue; grep -qx "$n $id" "$T" && continue; echo "$n $id" >> "$T"
        echo "PR #$n — $kind on a held PR — $who: $body"
      done
    done
    i=$((i + 1)); [ "$polls" -gt 0 ] && [ "$i" -ge "$polls" ] && break
    sleep "${WATCH_PRS_SLEEP:-90}"
  done
  ;;
*) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; [ -z "$cmd" ] || exit 2 ;;
esac
