#!/bin/sh
# PostToolUse(Write|Edit): score a plan the moment it is written.
#
# Why a hook and not a line in the skill. Three SKILL.md framings were tried —
# "Optional", "part of the return contract", and a JSON pipe — and measured over
# 40 hours: 26 opportunities with the text in context, zero invocations. Prose
# does not reliably cause a tool call. A hook does not need the agent to agree.
#
# Silent unless it has something to say. Exit 3 (no TYPESAFE_API_KEY) prints
# nothing at all, which is the whole optionality contract.
set -u
IN=$(cat)
f=$(printf '%s' "$IN" | jq -r '.tool_input.file_path // empty')

case "$f" in
  */docs/plans/*.md) ;;
  *) exit 0 ;;
esac
[ -f "$f" ] || exit 0

# A plan is edited many times in a row; one score per file per 10 minutes is
# plenty to catch a weak Definition of Done, and the API is not free.
stamp="${TMPDIR:-/tmp}/wt-eval-$(printf '%s' "$f" | shasum | cut -c1-12)"
if [ -f "$stamp" ]; then
  age=$(( $(date +%s) - $(stat -c %Y "$stamp" 2>/dev/null || stat -f %m "$stamp" 2>/dev/null || echo 0) ))
  [ "$age" -lt 600 ] && exit 0
fi
touch "$stamp"

out=$(node "$(dirname "$0")/../scripts/wt-eval.mjs" "$f" --type plan 2>/dev/null) || exit 0

# Only speak up about dimensions that are actually weak AND confident. A flat
# distribution means the question did not apply, and reporting it as a finding
# is how a scoring tool teaches people to ignore it.
note=$(printf '%s' "$out" | awk '
  /^  [a-z_]+ +[0-9]/ {
    dim=$1; score=$2+0; conf=$0; sub(/.*confidence /,"",conf); sub(/\).*/,"",conf);
    if (score < 2.0 && conf+0 >= 0.5) { print "  " dim " scored " $2 " — " ; getline; print $0 }
  }
  /^  [a-z_]+ +[0-9]+% yes/ { if ($2+0 >= 60) print "  " $1 " " $2 " yes — the plan may commit beyond the ticket" }
')
[ -n "$note" ] || exit 0

printf '%s' "$(jq -n --arg c "The plan you just wrote scored weak on:
$note
This is wt-eval, scoring the document, not a review. Read those parts of what you wrote and fix them now if they are wrong; ignore it if the score misread the plan." \
  '{hookSpecificOutput:{hookEventName:"PostToolUse",additionalContext:$c}}')"
