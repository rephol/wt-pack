#!/usr/bin/env bash
# wt-plan: resolve the integration branch and create a worktree from it.
#   worktree.sh <branch-name> [dir-name]
# Prints the worktree path on stdout. Everything else goes to stderr.
set -euo pipefail

branch="${1:?usage: worktree.sh <branch-name> [dir-name]}"
name="${2:-$(basename "$branch")}"
root="$(git rev-parse --show-toplevel)"

# Integration branch: origin/HEAD if the remote publishes one, else the first of the
# conventional names that exists. Repos integrating to preview/develop/staging are common,
# so main is the last guess, not the first.
base=""
if ref=$(git symbolic-ref --quiet refs/remotes/origin/HEAD 2>/dev/null); then
  base="${ref#refs/remotes/origin/}"
else
  for c in preview develop staging main master; do
    if git show-ref --verify --quiet "refs/remotes/origin/$c"; then base="$c"; break; fi
  done
fi
[ -n "$base" ] || { echo "worktree.sh: no integration branch found on origin" >&2; exit 1; }

echo "base: origin/$base" >&2
git -C "$root" fetch --quiet origin "$base"

# Follow the convention already in use: take the parent directory of an existing worktree
# rather than inventing one. Fall back to .claude/worktrees, which the harness also uses.
dir=$(git -C "$root" worktree list --porcelain | awk '/^worktree /{print $2}' \
      | grep -v "^$root\$" | head -1 | xargs -I{} dirname {} 2>/dev/null || true)
case "$dir" in ""|"$root") dir="$root/.claude/worktrees";; esac
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
