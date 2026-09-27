# WP-98 — Git history: work email in commits

Branch `wp-98-author-history`, base `origin/main`.

## Goal

The work email `<work email>` should not ship in any clone of this repo, and it should not come
back. Nothing in the repository history needs rewriting: that rewrite has already been done. What remains is
confirming that GitHub holds no copy, removing the last local copy after the user agrees, and adding a guard
so new commits cannot reintroduce the address.

## What research corrected

- **History was already rewritten, and the 117 commits are on one local backup branch only.** The ticket's
  count came from `git log --all`, which includes local refs. Counting per ref:
  - `main` has 0 such commits, `origin/main` has 0, and every `origin/*` branch has 0;
  - `backup/pre-author-rewrite` has 117;
  - `refs/pull/1/head` on the remote contains only rephol commits (`125 102417344+rephol@users.noreply.github.com`).

  The backup branch was created at the rewrite: its reflog reads `backup/pre-author-rewrite@{0}: branch: Created from main`,
  at `2c3c9c5 Sat Sep 26 13:09:01 2026`. It is **not on the remote**: `git ls-remote origin` lists only
  `main`, the `wp-*` branches, `jev-integrations` and `refs/pull/1/head`.
  → `git filter-repo` and a force-push are **not needed**, and would rewrite 473 clean commits for nothing.
- **The repo is not public today.** Unauthenticated `curl https://github.com/rephol/wt-pack` returns `404`,
  and an anonymous `git fetch` returns "Repository not found". The ticket's "public repo" is disproved for
  now. It matters before the repo goes public (see U1).
- **The repo-local author is already correct:** `git config --local user.email` gives
  `102417344+rephol@users.noreply.github.com`.
- **One question stays open `[unsourced]`: can GitHub still serve the old SHAs?** If the pre-rewrite `main`
  was ever pushed, GitHub keeps those commits reachable by SHA, and in cached PR and compare views, until
  support purges them. I could not test this. The `rephol` gh token resolved to account `<work account>`, and
  the API returned 404 for both. U1 tests it with an authenticated fetch of an old SHA.

## Review corrections (binding — these win over the units where they conflict)

1. **U3 regex.** One GitHub web merge on `main` has the committer `noreply@github.com` (at position 353 of
   `git log main --format=%ce`). The check therefore accepts `(^|[+@])(users\.)?noreply\.github\.com$`, or
   else checks only `%ae` plus the configured `user.email`.
2. **U1 must prove it is authenticated before any fetch result counts.** The clone step has to succeed first.
   Then fetch by full 40-character SHA (`git rev-parse ff9af6b`), and record the stderr text:
   `upload-pack: not our ref` means gone, success means still served, and an auth or "Repository not found"
   error counts as **no result**, never as a pass.
3. **U1 author check** runs after `git fetch origin`, using
   `git log --remotes --format='%ae%n%ce' | grep -c myapp` → `0`, not the `ls-remote | xargs` form. That form
   hides SHAs that are missing locally.
4. **U2: reflogs also hold the old commits.** `git reflog --all` has 234 myapp lines (117 commits × `%ae`/`%ce`),
   including `HEAD`'s reflog in the main checkout. **Do not run `reflog expire --all` or `gc --prune=now`**.
   Other worktrees and agents are active (`wp-95-image-zoom`), and doing so would wipe their undo history and
   can race their writes. Instead:
   - delete the branch;
   - expire only the entries whose commit is myapp-authored, or state plainly that those entries remain
     until git's default reflog expiry;
   - never prune while other agents are working.

   Verify with `git reflog --all --format='%ae%n%ce' | grep -c myapp` and report the count honestly, even
   if it is non-zero. The copy is local and never pushed.
5. **The work domain also appears in content.** `git grep -c myapp main` finds a bare `myapp` in 10 files
   under `docs/plans/` (for example `wp-97-remote-agent-chat-plan.md` 5, which is the account name
   `<work account>` and project paths). The email itself is absent (`git grep myapp.id main` → 0). U2's
   question in #wt-pack also asks whether to scrub those as a normal commit, with no history rewrite. That
   scrub is done only on a yes.
6. **U3 verify:** use a scratch clone with `git -C <scratch> config user.email x@example.com`. Drop the
   `GIT_CONFIG_GLOBAL=/dev/null` step.

## Approach

Three small steps, and no history rewrite. settled: no `filter-repo`/force-push, because nothing reachable
on the remote carries the address. The rejected alternative (rewriting again) would change every SHA,
invalidate the open worktrees and branches (`wp-95-image-zoom`, …), and fix nothing.

**U1 — verify the remote (no changes).** From the main checkout, which holds working credentials, for two
old SHAs taken from the backup branch (`ff9af6b` and `4024d40`, first and last by date):
```
tmp=$(mktemp -d) && git clone -q --bare --filter=blob:none https://github.com/rephol/wt-pack.git "$tmp/r.git" \
  && git -C "$tmp/r.git" fetch -q origin <full-sha> ; echo "exit $?"; rm -rf "$tmp"
```
- **Exit 0** means GitHub still serves the old commit by SHA. Stop and tell the user in #wt-pack, with a
  **draft** GitHub support request asking them to purge unreferenced objects (text below). Only the user
  sends it; this is outward-facing.
- **"not our ref" / "unadvertised object"** means the commit is gone, or was never pushed. Record that.

Also run `git ls-remote origin | awk '{print $1}' | xargs -I{} git log -1 --format='%ae %H' {} 2>/dev/null | grep -c myapp`
and expect `0`.

**U2 — delete the local backup, only on the user's yes.** Ask in #wt-pack: "WP-98: `backup/pre-author-rewrite`
is the last copy of the pre-rewrite history (117 commits with the work email). Delete it? It is the only way
to undo the rewrite." On yes:
```
git branch -D backup/pre-author-rewrite
git reflog expire --expire=now --all && git gc --prune=now
```
Then `git log --all --format='%ae%n%ce' | grep -c myapp` must print `0`. If there is no yes, leave the
branch and record that in the ticket. It is local and never pushed, so nothing leaks while it stays. This
is destructive and irreversible, so it never runs without an explicit yes in the room.

**U3 — guard (S, code).** A check in `setup doctor`: warn when
`git -C "$REPO" config user.email` is not a `users.noreply.github.com` address, and when
`git -C "$REPO" log -50 --format='%ae%n%ce'` contains anything else. That catches a checkout or machine
where the repo-local identity is missing. Add a one-line **Conventions** bullet in CLAUDE.md:
"Commits use the rephol noreply identity (repo-local git config); `./setup doctor` flags any other."
settled: doctor warning, not a git hook. Hooks are not installed by setup (`core.hooksPath` is empty), and a
warning cannot block anyone's work.
Files: `setup`, `CLAUDE.md`.
Verify: `./setup doctor` in the worktree shows the check as ok. Then with `GIT_CONFIG_GLOBAL=/dev/null` and
a scratch clone where `git config user.email x@example.com` is set, doctor shows the warning. Paste both
outputs.

Order: U1 → U2 (needs the user) → U3. U3 does not depend on U2, so if the user has not answered, do U3 and
leave U2 pending.

**Draft support request (for the U1 exit-0 case only):** "Please purge cached views and unreferenced objects
for repository rephol/wt-pack. Its history was rewritten on 2026-09-26 to remove a personal email. Example
old commit SHAs: <sha1>, <sha2>."

## Files

- `setup`, `CLAUDE.md` (U3 only). U1 and U2 change no tracked files.

## Definition of Done

Each item is shown by output in the transcript:
- The U1 fetch output for both old SHAs, and the `ls-remote` author count `0`.
- U2: either the #wt-pack yes plus `git log --all … | grep -c myapp` → `0`, or a ticket comment saying the
  user has not approved yet and the branch was kept.
- U3: the two `./setup doctor` outputs (ok and warning).
- A WP-98 ticket comment summarises what was found (already rewritten, and whether the remote serves old SHAs).

## Risks and deferred

- **Other clones.** Any machine or person that cloned before the rewrite still has the old history. Nothing
  in this repo can reach those copies. The only one known is this machine's backup branch.
- **Going public** is a separate decision. If U1 finds GitHub still serves old SHAs, the purge has to happen
  first.
