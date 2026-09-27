# WP-116 — wt-watch-prs: PR reviewer loop skill

## Goal

Any wt-pack project can run a reviewer agent that watches the repo's open PRs. It reviews each new head and posts
the verdict under a dedicated reviewer identity. A PR it holds pending clarification shows up in the dashboard
Inbox, and the reviewer re-reviews that PR when the author replies. This is a port of umkmall's `/watch-prs`
(`umkmall/.claude/commands/watch-prs.md`, 939 lines, read in full). That command stays untouched.

## What research corrected

- **The ticket says "add a reviewer role in wt-agents".** wt-agents has no role allowlist: `agents.sh:11` says
  "Any role name works". The role list that matters lives in the dashboard, `roles.mjs:8-17` `DEFAULT_ROLES`.
- **Adding a default role does nothing on this install.** `roles.mjs:91` reads
  `try { this.roles = validateRoles(JSON.parse(await readFile(this.rolesFile…))) } catch { this.roles = DEFAULT_ROLES }`,
  and `roles.json` already exists with orchestrator, planner, worker and auditor. The loaded file replaces the
  defaults. U2 handles this.
- **"An Inbox item when a PR is held" assumes an agent can create Inbox items. It can't.** `/api/notifications`
  has only GET, `read` and `clear` (`server.mjs:1593-1613`). Every item is created inside the server. The pattern
  to copy is `memoryNotices` (`server.mjs:870-878`), where the server polls agent-written state and turns new
  entries into items.
- **"Reviews through wt-review lenses" assumes wt-review can fetch a PR. It can't.** wt-review is a SKILL.md with
  no script. Its diff mode takes "`git diff <base>...HEAD` or a PR" (`wt-review/SKILL.md:45`) and fetches
  nothing. The skill has to supply the diff itself, from pinned refs.
- **The source has two defects that must not be copied.** Line 635 opens a second ```` ```bash ```` fence
  inside `gate()`. Line 393 writes the outcome note to a shared `/tmp/outcome-<N>.txt`.

## Generic vs umkmall-only (source section → fate)

| Source (lines) | Fate |
|---|---|
| Preflight 11–43 | Port. Hard checks: gh, git, jq, `gh auth status`, a git repo. Degraded checks: reviewer identity, BSD/GNU `date`. |
| Claim, don't partition 45–84; cross-session 332–410 | Port. Atomic `mkdir` claims, a state lock, and a session tag in the review body. |
| SHA Monitor 86–223 | Port the dedup logic (`rebuild_seen`, `matches_seen` prefix match, `recently_fired` TTL 900) and the close/merge diff. |
| Reply Monitor 225–304 | Port: a SELF filter that fails loud when empty, a 15-minute backfill, and bots dropped. |
| Re-review = delta 498–545 | Port the ancestor guard. The base comes from the `baseBranch` project setting, not `preview`. |
| PR describes itself 548–580; `gate()` 632–688 | Port as pure jq over fixtures. Checks the repo marks as informational go in project docs. |
| No-checkout review 690–746 | Port: `refs/pull/N/head` pinned under a session namespace, and a three-dot diff. |
| Hold / clear / never approve-with-a-question 808–843; probe validity 887–912 | Port as SKILL.md prose. |
| Merge-only head 412–495; `migrate` 603–630; engine 748–761; CI layer 845–885; ponytail 914–916; scope/Linear 918–938 | **Drop.** They depend on umkmall's `preview` protection, Railway, `ce-code-review`, turbo/drizzle and `UMK-###`. The engine becomes wt-review, and a project's own rules belong in its CLAUDE.md, which wt-review's standards lens already reads. |

## Approach

The source is 939 lines of prose with inline bash. The port splits that into a script, `watch-prs.sh`, and a short
SKILL.md. The script holds every mechanical piece that can be tested. The SKILL.md holds the judgement: how to
review, when to hold, how to clear a hold.

**Settled decisions** (made without the user; this run is headless):
- *State lives in a separate place.* The state file is
  `~/.local/share/wt-watch-prs/<owner>-<repo>/state.json`, and claims go in a `claims/` directory beside it. The
  rejected alternative was sharing umkmall's `~/.claude/pr-review-state.json`. Sharing it would mean two
  differently-tagged tools writing one file, and the ticket says the umkmall command is "not ours to change".
  The state format stays the same (`.reviewed["N"] = {sha, state, outcome, reviewer_session}`), so the two
  files look alike.
- *Reviewer identity.* A new project-level key, `reviewerGithubAccount`, resolves to a token through
  `gh auth token --user <acct>`, the same way `agents.sh:171-175` handles `githubAccount`. If the key is unset,
  `GH_REVIEWER_TOKEN_FILE` (default `~/.config/gh-reviewer-token`) is read as in the source (lines 28–30). If
  neither is set, the skill runs degraded under the default identity: it comments and never approves, because
  approving your own PR fails. The rejected alternative was a second key for the token file. The environment
  variable already covers that case, and one key per project is enough.
- *Inbox holds come from the server polling state.* The server reads every `~/.local/share/wt-watch-prs/*/state.json` (dir name = `<owner>-<repo>`, not a dashboard project) and turns
  every `changes-requested` entry into an actionable `pr-held` item keyed `pr-held|<repo>#<n>`. The item resolves
  when the entry leaves that state (its own resolve logic — only `memory-proposal` resolves-on-disappear today,
  via a held-key set in `toResolve`). The rejected alternative was a POST create route: it is a new write surface behind the
  session cookie, and it would need its own dedupe. Polling reuses both.
- *The review engine is wt-review in diff mode*, fed by `git diff <base-ref>...<head-ref>` on pinned refs. No
  checkout, no worktree.
- *Spawning a reviewer* uses `agents.sh spawn reviewer`, which starts in the main checkout (`agents.sh:99`
  covers every role except worker). `handoff.sh --role` is not widened: reviewers are armed with a `/goal` at
  spawn, not handed plans. Review corrected: the dashboard's spawn button sends no role prompt — `spawnAgent`
  sends one only when the dialog or a routine supplies `b.prompt` (`server.mjs:1055`); roles have no prompt
  field. So the arming `/goal` (`/goal Use wt-watch-prs to watch this repo's PRs`) is typed in the spawn dialog's
  prompt box or sent by hand; SKILL.md and features.md say so.
- *Token hygiene.* The reviewer token only ever reaches `gh` as `GH_TOKEN=… gh …` per call. It never goes in
  argv, pane tokens, state.json, notes, or Monitor output.

## Implementation units

### U1 — `skills/wt-watch-prs` script + tests
- `skills/wt-watch-prs/scripts/watch-prs.sh` provides these subcommands:
  - `preflight`: prints `HARD fail: …` or `DEGRADED: …` lines and exits 1 on any hard failure.
  - `identity`: prints the reviewer login and a token source; exits 1 if the identity is unresolved.
  - `poll-shas [--once]`: one event line per new head (`PR #n — new commits <sha>`) and per `NO LONGER OPEN`
    PR; sleeps 60s between polls.
  - `poll-replies [--once] --session S`: one line per human reply on this session's holds; sleeps 90s.
  - `claim N S` and `release N S`.
  - `record N <sha> <state> <outcome> S`: runs under the state lock and requires a full 40-character SHA.
  - `gate N` → `green|red|pending|none`, and `describes N` → `ok|no-body|branch-title`.
  - `diff N`: fetches pinned refs, runs the ancestor guard, prints the three-dot diff.
- The repo comes from `gh repo view --json nameWithOwner` in the current checkout. There is no fallback.
- The base branch comes from `project-setting.mjs get baseBranch --cwd .`, then `origin/HEAD`, then `main`.
- The dedup, reply-filter, `gate` and `describes` logic is written so each piece runs on fixture JSON through a
  `gh` stub.
- `skills/wt-watch-prs/scripts/watch-prs.test.mjs` runs with a temp `HOME` (so it never writes the real state
  dir the server reads) and uses `node --test` with stub binaries on PATH, following the
  `wt-agents/scripts/spawn-env.test.mjs:1-30` pattern. It covers:
  - preflight hard vs degraded
  - exact and short-prefix SHA suppression — every suppression case has a sibling fixture PR in the same run
    that MUST fire, so an empty or broken stub fails the test
  - `NO LONGER OPEN` for a merged PR; `describes` ok/no-body/branch-title; `diff` refusing a non-ancestor old
    head (full-review fallback); the reply `since` is 15 min back
  - the stub token string never appears in stdout, stderr or state.json
  - TTL expiry re-firing
  - a live claim suppressing an event
  - a second `claim` losing
  - `record` rejecting a short SHA
  - `poll-replies` dropping self and bot replies, and failing when SELF is empty
  - `gate` classifying fixture rollups (including red)
- **Verify:** `node --test skills/wt-watch-prs/scripts/*.test.mjs` passes.

### U2 — reviewer role + identity setting (wt-dashboard, wt-agents)
- `roles.mjs` (commit: wt-dashboard; `mcp/reviewer.json` + `mcp.test.mjs` are a separate wt-agents commit): add `{ id: 'reviewer', name: 'Reviewer', letter: 'R', match: { workspace: '*-reviewers', name: '*reviewer*' }, spawn: { start: 'main', workspace: '<repo>-reviewers', projects: [] } }` to `DEFAULT_ROLES`.
  - In `load()`, append any default id missing from `roles.json` that is not in the sibling
    `retired-roles.json` (an array of ids). `saveRoles` adds a deleted default id there, so a role the user
    removed stays removed. `roles.json` stays a plain array: `validateRoles` requires one (`roles.mjs:42`), and
    a wrapper would make `load()` fall back to `DEFAULT_ROLES`, dropping the user's roles.
  - Test in `roles.test.mjs`, alongside `resolveRole: auditors…` (`:53`): reviewer resolves by pool and by name,
    and an existing roles.json without reviewer gains it exactly once.
- `project-settings.mjs` `PKEYS`: add `reviewerGithubAccount` (project scope, same check as `githubAccount`).
  `web/src/projects-settings.tsx` gets an `ABOUT` entry. Test in `project-settings.test.mjs`.
- `skills/wt-agents/mcp/reviewer.json`: copy `auditor.json`. Add a reviewer test to `mcp.test.mjs`, twin of the
  one at `:34`.
- **Verify:** `cd skills/wt-dashboard && npm test`; `npx tsc --noEmit -p web`;
  `node --test skills/wt-agents/scripts/mcp.test.mjs`.

### U3 — Inbox `pr-held` (wt-dashboard)
- `inbox.mjs`: add `pr-held` to `KINDS` (`:7`) and to `ACTIONABLE` (`:8`), and a `pr-held` branch in
  `toResolve` (`:26`) that resolves against a set of currently-held keys — without it the item has no
  `target.agent` and resolves on every tick.
- `server.mjs`: add `reviewHolds()`, modelled on `memoryNotices`. It reads
  `~/.local/share/wt-watch-prs/*/state.json` on the existing inbox tick (4s, `server.mjs:2823`, beside
  `memoryNotices()` at `:1571`), adds one item per `changes-requested`
  entry with the title `Held PR #n (<repo>)` and a body holding the outcome note, and resolves items whose entry
  has left that state. **No silent baseline** (unlike `memoryNotices`): the first scan creates items, so holds
  that predate a restart appear. The file is untrusted: skip symlinks, files over 1 MB and unparsable JSON;
  accept only digit PR keys; take the repo from the dir name, not the JSON; cap the note at 500 chars.
- Web: `pr-held` label/colour/icon in `web/src/inbox.tsx` (`:26`, `:66`, `:84`), `KINDS` in
  `web/src/notifyGate.ts:3`, and the toggle list in `web/src/settings.tsx:329`.
- Test: on the **first** poll a temp state file with one hold gives one item; clearing the hold resolves it; a
  second poll adds no duplicate; a non-digit key and a symlinked file are ignored.
- **Verify:** `npm test`; `npm run build` in web; one `npm run service:restart`; check the Inbox with a
  hand-written state file under a throwaway slug, then delete it.

### U4 — SKILL.md + docs
- `skills/wt-watch-prs/SKILL.md` covers:
  - preflight first, then arming the two Monitors (`persistent: true`) on `poll-shas` and `poll-replies`;
  - the claim → review → `record` flow;
  - the CI gate before and after the review;
  - the no-checkout rule, delta re-review, and hold vs approve;
  - never approving under the default identity.
  It stays under about 200 lines. Umkmall-specific policy is excluded.
- `docs/features.md`:
  - a wt-watch-prs entry under "Pipeline skills" (`:405`);
  - reviewer under "Agents, roles and spawn" (`:110`);
  - `pr-held` under "Inbox" (`:210`);
  - `reviewerGithubAccount` under Projects (`:265`).
- `CLAUDE.md`: a skill-map row, and add reviewer to the role list at `:9`.
- **Verify:** `./setup doctor` lists wt-watch-prs as linked (`setup:74` links every `skills/wt-*` with a
  SKILL.md).

## Files

- New: `skills/wt-watch-prs/SKILL.md`, `skills/wt-watch-prs/scripts/watch-prs.sh`,
  `skills/wt-watch-prs/scripts/watch-prs.test.mjs`, `skills/wt-agents/mcp/reviewer.json`
- Modified:
  - `skills/wt-dashboard/`: `roles.mjs`, `roles.test.mjs`, `project-settings.mjs`, `project-settings.test.mjs`,
    `inbox.mjs`, `inbox.test.mjs`, `server.mjs`, `web/src/projects-settings.tsx`, `web/src/inbox.tsx`,
    `web/src/notifyGate.ts`, `web/src/settings.tsx`
  - `skills/wt-agents/scripts/mcp.test.mjs`
  - `docs/features.md`, `CLAUDE.md`

## Definition of Done

Each condition is met only when the transcript shows the command and its output, or an agent-browser screenshot.

1. `node --test skills/wt-watch-prs/scripts/*.test.mjs` passes, including every case listed in U1.
2. `skills/wt-dashboard` `npm test` and the web `tsc` both pass. `node --test skills/wt-agents/scripts/mcp.test.mjs` passes.
3. `watch-prs.sh preflight` runs against this repo and prints its result.
4. After one service restart, the dashboard's role list includes Reviewer, and a throwaway state file holding
   one `changes-requested` entry shows a `pr-held` Inbox item. Both are checked with agent-browser and the
   throwaway file is then removed.
5. The umkmall `watch-prs.md` is unchanged (`git -C <umkmall worktree> status` is clean for it).
6. `features.md` and the CLAUDE.md skill map are updated. There is one commit per skill touched.

## Risks and deferred

- **Not verified end to end.** A real review posted to a real PR under a reviewer account needs a throwaway repo
  and a second GitHub account. That is deferred to the first real use and stated in the handoff.
- **Monitor behaviour** (`persistent: true`) cannot be tested from bash; the source says the same at lines 40–41.
- **Out of scope:** inline review comments (`pulls/N/comments`), which the source doesn't cover either (line
  302); widening `handoff.sh --role`; and merge-only-head detection, which is dropped together with umkmall's
  branch protection.
- **Dashboard spawn does not arm the reviewer.** The `/goal` must be typed; making roles carry a first prompt
  is out of scope.
