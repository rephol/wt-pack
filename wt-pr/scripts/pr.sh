#!/usr/bin/env bash
# wt-ship: push the current branch and open a DRAFT pull request.
#   pr.sh <title> <body-file> [base]
# Draft is deliberate and not configurable here: promoting a PR is a human judgement.
set -euo pipefail

title="${1:?usage: pr.sh <title> <body-file> [base]}"
bodyfile="${2:?usage: pr.sh <title> <body-file> [base]}"
[ -r "$bodyfile" ] || { echo "pr.sh: cannot read body file: $bodyfile" >&2; exit 1; }

branch="$(git rev-parse --abbrev-ref HEAD)"
[ "$branch" = "HEAD" ] && { echo "pr.sh: detached HEAD" >&2; exit 1; }

base="${3:-}"
if [ -z "$base" ]; then
  if ref=$(git symbolic-ref --quiet refs/remotes/origin/HEAD 2>/dev/null); then
    base="${ref#refs/remotes/origin/}"
  else
    for c in preview develop staging main master; do
      if git show-ref --verify --quiet "refs/remotes/origin/$c"; then base="$c"; break; fi
    done
  fi
fi
[ -n "$base" ] || { echo "pr.sh: no base branch found on origin" >&2; exit 1; }
[ "$branch" = "$base" ] && { echo "pr.sh: refusing to open a PR from the base branch ($base)" >&2; exit 1; }

# A dirty tree is work that is not in the PR and that nobody will review.
git diff --quiet && git diff --cached --quiet || {
  echo "pr.sh: working tree is dirty; commit or set aside first" >&2; exit 1; }

echo "pushing $branch -> origin (base: $base)" >&2
git push -u origin "$branch"

exec gh pr create --draft --base "$base" --head "$branch" --title "$title" --body-file "$bodyfile"
