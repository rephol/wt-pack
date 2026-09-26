#!/usr/bin/env bash
# wt-plan: resolve the integration branch and create a worktree from it.
#   worktree.sh <branch-name> [dir-name]
# Prints the worktree path on stdout. Everything else goes to stderr.
set -euo pipefail

branch="${1:?usage: worktree.sh <branch-name> [dir-name]}"
name="${2:-$(basename "$branch")}"
# The MAIN checkout, also when run from inside a worktree: a worktree's --show-toplevel is the
# worktree itself, but its git-common-dir is the main repo's .git.
common="$(git rev-parse --path-format=absolute --git-common-dir)"
root="$(dirname "$common")"

# Integration branch: origin/HEAD if the remote publishes one, else the first of the
# conventional names that exists. Repos integrating to preview/develop/staging are common,
# so main is the last guess, not the first.
base=""
# 1. An explicit answer always wins: WT_BASE=preview worktree.sh ...
if [ -n "${WT_BASE:-}" ]; then
  base="${WT_BASE#origin/}"
# 2. The branch the checkout is SITTING on, when that is itself an integration
#    branch. origin/HEAD is the repo's default branch, which is not the same
#    thing: umkmall publishes origin/HEAD -> main while integrating to preview,
#    so trusting HEAD first silently branched every worktree off the wrong base.
else
  cur=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)
  for c in preview develop staging main master; do
    if [ "$cur" = "$c" ] && git show-ref --verify --quiet "refs/remotes/origin/$c"; then
      base="$c"; break
    fi
  done
fi
# 3. Then the published default, then the conventional names.
if [ -z "$base" ]; then
  if ref=$(git symbolic-ref --quiet refs/remotes/origin/HEAD 2>/dev/null); then
    base="${ref#refs/remotes/origin/}"
  else
    for c in preview develop staging main master; do
      if git show-ref --verify --quiet "refs/remotes/origin/$c"; then base="$c"; break; fi
    done
  fi
fi
[ -n "$base" ] || { echo "worktree.sh: no integration branch found on origin" >&2; exit 1; }

echo "base: origin/$base" >&2
git -C "$root" fetch --quiet origin "$base"

# Always under the main checkout, where Claude Code puts its own worktrees. Not "wherever the first
# existing worktree is": in umkmall that was a sibling repo's folder, so every new worktree landed
# beside the repo in ~/Work/projects. WT_WORKTREE_DIR overrides; existing worktrees are left alone.
dir="${WT_WORKTREE_DIR:-$root/.claude/worktrees}"
# Nested worktrees must be ignored by the main checkout, or they show up as untracked files there.
# Ignore them locally (.git/info/exclude, never committed) when the repo's own .gitignore doesn't.
if [ -z "${WT_WORKTREE_DIR:-}" ] && ! git -C "$root" check-ignore -q ".claude/worktrees/x"; then
  mkdir -p "$common/info"
  echo "/.claude/worktrees/" >> "$common/info/exclude"
  echo "worktree.sh: .claude/worktrees was not gitignored; added to .git/info/exclude (add it to .gitignore to share)" >&2
fi
mkdir -p "$dir"

path="$dir/$name"
[ -e "$path" ] && { echo "worktree.sh: $path already exists" >&2; exit 1; }

git -C "$root" worktree add -b "$branch" "$path" "origin/$base" >&2

# `worktree add` materialises TRACKED files only, so every gitignored env file is
# absent from the new tree while its tracked .template/.example sibling is present
# — the worktree looks configured and is not. Copy them across.
#
# cp, not ln -s: a repo guarding secret reads (umkmall's block-secret-reads.sh)
# blocks `ln -s <secret>` as an attempted read while allowing a copy to the same
# name. The copy is the shape those guards have been taught.
#
# Only files git itself calls ignored, only env files, and never from a build or
# dependency directory — those are generated, huge, and none of them are config.
git -C "$root" ls-files -z --others --ignored --exclude-standard \
    -- ':(glob)**/.env' ':(glob)**/.env.*' 2>/dev/null \
  | while IFS= read -r -d "" f; do
      case "$f" in
        node_modules/*|*/node_modules/*|.next/*|*/.next/*|dist/*|*/dist/*|build/*|*/build/*) continue ;;
        # Other worktrees live UNDER the checkout here, and their env files are
        # somebody else's branch, not this repo's config. Measured: without this
        # a new worktree inherited two files from an unrelated feature branch.
        .worktrees/*|*/.worktrees/*|.claude/worktrees/*|*/.claude/worktrees/*) continue ;;
        *.template|*.example|*.sample|*.backup|*.bak|*~) continue ;;
      esac
      mkdir -p "$path/$(dirname "$f")"
      cp "$root/$f" "$path/$f" && echo "env: $f" >&2
    done

echo "$path"
