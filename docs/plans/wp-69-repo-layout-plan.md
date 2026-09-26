# WP-69 — Repo layout: skills under one dir, project CLAUDE.md

Branch `wp-69-src-layout`, base `origin/main` (4b862cb).

## Goal

Two changes to the repo. First, every `wt-*` skill directory moves out of the repo root into one parent
directory, as in everyinc/compound-engineering-plugin. Second, `CLAUDE.md` becomes an ordinary project file
covering layout, build and test, and conventions. The orchestrator rules it carries today move to wt-memory
role `orchestrator`. The move is a single migration: every CLI and every `~/.claude/skills/<name>` path keeps
working, and `./setup doctor` passes afterwards.

## What research corrected

- **The reference repo does not use `src/` for skills.** Its skills are flat under a top-level `skills/`
  (`gh api …/contents/skills` → `skills/ce-babysit-pr skills/ce-bakeoff …`, 36 dirs). Its `src/` holds the
  TypeScript converter (`src/commands src/converters … src/index.ts`), and the repo root is the plugin root
  (`.claude-plugin/marketplace.json` `"source": "./"`). → The target is **`skills/wt-*`**. The question was
  put to the user in #wt-pack, with `src/` as the alternative. If they answer `src/`, only the directory name
  changes: every step below is written against `$SK` (the parent dir name).
- **"Hard-coded `~/.claude/skills/...` paths stay valid through the symlinks" holds only after the links are
  re-pointed, and `./setup` cannot re-point them today.** Install builds each target as `$REPO/$s`
  (`setup:167` `want="$REPO/$s"`), and it refuses any link it did not expect: `setup:171`
  `bad "not touching $l: it links to ${t:-a missing path}, not a wt-pack checkout"`. After the move, every
  existing link (`~/.claude/skills/wt-plan -> …/wt-pack/wt-plan`) dangles, so `t` is empty and install
  refuses it.
- **`is_pack(dirname target)` stops working.** `setup:44` `is_pack() { [ -f "$1/.claude-plugin/marketplace.json" ] …`
  is called on a link target's parent (`setup:91`, `setup:55` `h=$(dirname "$t")`). After the move that parent
  is `<repo>/skills`, not the repo root.
- **In-repo cross-skill paths survive untouched.** They are all sibling-relative:
  `wt-handoff/scripts/handoff.sh:182` `…/../../wt-ticket/scripts/wt-ticket`,
  `wt-dashboard/server.mjs:21` `from '../wt-shared/scripts/typesafe.mjs'`,
  `wt-dashboard/ticketJev.mjs:3` `'../wt-handoff/scripts/jev-route.mjs'`, and
  `wt-memory/scripts/jev-memory.mjs:11` `join(here, '..', '..', 'wt-shared', …)`. Nothing builds
  `<toplevel>/wt-X` from `git rev-parse`. → Moving all skills together keeps these working. What would break
  them is moving only some skills.
- **The dashboard service and the Tauri app need no code change.** The plist root is computed from the script's
  own location (`wt-dashboard/scripts/service.mjs:16` `const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))`),
  and Tauri paths are relative (`tauri.conf.json:6` `"frontendDist": "../../web/dist"`). What does need handling
  is the **installed** plist, which still points at `<repo>/wt-dashboard/server.mjs`. Setup's check
  (`setup:227` `elif … [ "$root" != "$DASH" ] && is_pack "$(dirname "$root")"`) treats that as "another
  checkout's service, kept", or would, if the old path still existed.
- **One absolute repo path lives outside the repo:** the user hook in `~/.claude/settings.json:38`
  `"command": "sh '<repo>/wt-shared/hooks/eval-plan.sh'"`. Setup does not write
  it. It breaks the moment main has the move.
- **The marketplace plugin source is repo-relative:** `.claude-plugin/marketplace.json`
  `"source": "./wt-memory/claude-plugin"`. The marketplace itself is registered at the repo root
  (`known_marketplaces.json` `"path": "<repo>"`), so `.claude-plugin/` must
  **stay at the root**, and it is also setup's `is_pack` marker.
- **wt-agents has no role-doc mechanism.** The only per-role files are MCP configs (`wt-agents/mcp/{auditor,planner,worker,catalog}.json`),
  and `grep -i orchestrator wt-agents/` finds 0 hits. Role behaviour lives in wt-memory role notes. → The
  orchestrator rules go to wt-memory, not to a new doc.
- **No top-level `features.md` exists.** It is `docs/features.md`.

## Review corrections (binding — these win over Approach and the units where they conflict)

1. **P0: the scratch-HOME test must not touch launchd.** `service.mjs:61-62` runs
   `launchctl bootout/bootstrap gui/$uid/id.local.wtdashboard.server`. launchd is not scoped by HOME, so a
   plain scratch `setup install` would take over the live :7777 service. The scratch run is therefore
   `HOME=… <worktree>/setup install --no-service --no-secrets --yes </dev/null` and
   `setup doctor --no-service`, and it asserts only on the link lines.
2. **The rollback is explicit, not `git revert`** (the old setup cannot migrate `skills/` links back):
   `git revert <merge>`, then `for l in ~/.claude/skills/wt-*; do ln -sfn "$REPO/$(basename "$l")" "$l"; done; node wt-dashboard/scripts/service.mjs install`.
3. **Fix `wt-setup/SKILL.md:14`**, which finds the repo with `dirname "$(readlink -f ~/.claude/skills/wt-setup)"`
   and would return `<repo>/skills` after the move. Change it to
   `git -C "$(readlink -f ~/.claude/skills/wt-setup)" rev-parse --show-toplevel`. This goes in U1, because the
   skill is unusable without it.
4. **Do not run `./setup` from an unrebased worktree after the merge.** The old setup, reading plist root
   `main/skills/wt-dashboard`, gets `is_pack(main/skills)` false and reinstalls the service from the stale
   worktree (`setup:229-230`). U4 announces this in #wt-pack before merging.
5. **Ignored build output must move with its skill.** `git pull` moves only tracked files, so
   `wt-dashboard/{web/dist,web/node_modules,app/node_modules,app/build,app/src-tauri/target,…}` and
   `wt-memory/claude-plugin/evals/results/` stay behind. In U4, before `./setup install`, run
   `for d in wt-*; do [ -d "$d" ] && rsync -a "$d/" "skills/$d/" && rm -rf "$d"; done`
   (only untracked leftovers remain by then). In U1, `.gitignore:6` `wt-memory/claude-plugin/evals/results/`
   becomes `skills/wt-memory/...`, and `.gitignore` joins U1's file list.
6. **Every layout assumption in setup is covered, not only `is_pack(dirname)`.** The peer "home" checks
   (`setup:92` `[ ! -d "$home/$s" ]`, `setup:174`) test `$home/skills/$s` or `$home/$s`. The service-migration
   branch (plist root == `$REPO/wt-dashboard`) is placed **before** the `is_pack(dirname root)` branch at
   `setup:227-229`, which would otherwise say "kept: another checkout", because `is_pack($REPO)` is true.
   Doctor's `npm --prefix wt-dashboard` hints (`setup:104,119`) gain `skills/`.
7. **The hook migration is dropped from setup** (setup has no settings.json writer). U4 edits the one path in
   `~/.claude/settings.json:38` by hand to `~/.claude/skills/wt-shared/hooks/eval-plan.sh`, then checks it with
   `grep eval-plan ~/.claude/settings.json`. Doctor may warn when it sees `$REPO/wt-shared/hooks`.
8. **wt-memory flags:** `wt-memory remember "<rule>" --scope role --role orchestrator`
   (`wt-memory/scripts/wt-memory:129-131`). `list` filters only by scope, so the check is
   `wt-memory list --scope role | grep orchestrator`.
9. **The U3 grep is widened** to `grep -rnE '(^|[^/~.a-z-])wt-[a-z]+/' README.md CLAUDE.md docs/features.md docs/handoff-*.md skills --include='*.md' --include='*.mjs' --include='*.sh'`.
   It also covers `wt-dashboard/SKILL.md:18` `wt-agents/scripts/agents.sh`, `wt-shared/scripts/jev-eval.mjs:3`
   usage text, `wt-agents/scripts/mcp.test.mjs:1`, and the `handoff.sh:21,25` comments. The code paths there
   (for example `jev-eval.mjs:13` `join(here,'..','..')`) already resolve and stay as they are.

## Approach

**Directory.** `git mv wt-* skills/` in one commit. `setup`, `README.md`, `CLAUDE.md`, `docs/` and
`.claude-plugin/` stay at the root. settled (pending the #wt-pack answer): `skills/`, not `src/`. Rejected:
`src/` (it reads as build input, and the reference uses it for code that is compiled).

**One atomic commit for the move and its path fixes.** CLAUDE.md's rule "**One commit per skill touched**"
cannot apply to a rename of every skill: a split would leave commits in which setup or the marketplace point
at paths that do not exist. The exception is recorded in the commit message. Doc and CLAUDE.md rewrites are
separate commits after it.

**setup becomes layout-aware and migrates.** It gets one variable, `SK="$REPO/skills"`, and a
`root_of() { case "$1" in */skills/*) dirname "$(dirname "$1")";; *) dirname "$1";; esac; }` used everywhere
it now does `is_pack "$(dirname …)"` (`setup:55,91,171,227`). This keeps setup able to recognise a peer
checkout that is still on the old layout.
- `skills()` iterates `"$SK"/wt-*/` (`setup:45`).
- `want="$SK/$s"` (`setup:167`), and doctor compares against `$SK/$s` (`setup:90`).
- **Migration in install.** A link whose raw target (`readlink`, not `cd`, because the target is dangling) is
  exactly `$REPO/$s` (the old layout of *this* checkout) is replaced with `ln -sfn "$SK/$s"`, counted as
  `migrated`. Dangling links to any other checkout are still refused.
- **Uninstall** also removes dangling links whose `readlink` is `$REPO/$s`. Today it skips them because
  `setup:263` `cd "$l"` fails.
- **Service.** `DASH="$SK/wt-dashboard"`. When the installed plist's root equals `$REPO/wt-dashboard` (the old
  path of this checkout), install runs `node "$DASH/scripts/service.mjs" install`, which rewrites the plist
  from its own location, and says `migrated service`. Uninstall also matches the old path (`setup:254`).
- **Hook.** Doctor warns when `~/.claude/settings.json` references `$REPO/wt-shared/hooks/`, and install
  rewrites that one path to `~/.claude/skills/wt-shared/hooks/eval-plan.sh` (a stable path through the link),
  using `node -e` to do a JSON edit with a `.bak`. `[unsourced]`: setup was not read in full for existing
  settings.json writers. U1 should grep for `settings.json` in `setup` first and reuse any helper it finds.
- Message text: `setup:137` "see wt-memory/SKILL.md" and "built web (wt-dashboard/web/dist)" gain the
  `skills/` prefix.

**Marketplace.** `"source": "./skills/wt-memory/claude-plugin"`. After merge, run
`claude plugin marketplace update wt-pack`, then check that `wt-memory@wt-pack` still loads (the plugin cache
may hold the old source; `[unsourced]`, not inspected).

**CLAUDE.md → project file.** The new CLAUDE.md contains: what the pack is and the layout
(`skills/<name>` → `~/.claude/skills/<name>` via `./setup`); build and test per area (wt-dashboard
`npm test`, `web` tsc/build, service restart, and the "don't restart repeatedly" rule); the skill map with
`skills/` paths; conventions that apply to any agent in the repo (browser checks with agent-browser and
`--session`, the caffeinate/screenshot fallback, one commit per skill, `git commit <paths>`, CLI backward
compatibility, no Claude API in the dashboard plus the security list, merge to main then push, commit
authorship); and the Traps section unchanged. Orchestrator-only rules leave the file. Those already in
wt-memory stay there (never implement: `bde61f`; only Ready: `a13bce`; hand off with `--task`: `00e84a`).
The missing ones are added with
`wt-memory remember "<rule>" --scope role` (role orchestrator; check the CLI's exact flag for naming the role
in U3):
claim before planning; skip cards with a dispatch badge and handle only the exceptions; verify, commit and
report concisely; the umkmall orchestrator is reachable via `herdr agent prompt wP:p1`. "No draft PRs"
stays in CLAUDE.md, because it applies to any agent that ships here, and it is also in the project
preferences. No `AGENTS.md` symlink: the reference needs one for its multi-agent converters, and this repo
has no such consumer.

**Rollout order (on the host, after merge to main).** The live dashboard service runs from the main
checkout (`WorkingDirectory` = `<repo>/wt-dashboard`). Node keeps the modules it has loaded, but the next
restart or relaunch fails until setup runs. So merge, then **immediately** run `git pull` in the main
checkout, `./setup install` (links, service and hook migrate), `claude plugin marketplace update wt-pack`,
and `./setup doctor`. Rollback: `git revert <merge>` followed by `./setup install`, which migrates back,
because `root_of` recognises both layouts.

**Open worktrees and branches.** Only `wp-69-src-layout` and main exist right now (`git worktree list`).
The unmerged `origin/wp-21-sqlite-store` adds only a plan doc. Branches cut before the move rebase fine:
git's rename detection carries `wt-x/…` edits into `skills/wt-x/…`. A worktree created before the move
keeps its old layout until it rebases, and its `~/.claude/skills` links point at main anyway. The
orchestrator should merge WP-69 when no worker is mid-flight on wt-dashboard `[unsourced: current activity
unknown at plan time]`.

## Implementation units

**U1 — move + setup + marketplace (M, one commit).** `git mv wt-* skills/`; setup changes (SK, root_of,
skills(), want, doctor, migration in install and uninstall, service migration, hook migration, message
text); marketplace source.
Files: `skills/**` (rename only), `setup`, `.claude-plugin/marketplace.json`.
Verify, in a scratch HOME so the real links are not touched:
`HOME=$(mktemp -d) sh -c 'mkdir -p $HOME/.claude/skills; for s in wt-plan wt-shared; do ln -s <worktree>/$s $HOME/.claude/skills/$s; done; <worktree>/setup install; ls -l $HOME/.claude/skills'`.
This shows the old-layout links migrated to `<worktree>/skills/…`. Then `setup doctor` in the same HOME is
clean for links. Also run `cd skills/wt-dashboard && npm test`, `cd skills/wt-memory && node --test scripts/`,
and `node --test skills/wt-agents/scripts/mcp.test.mjs`, which is where relative-path tests live. On service
and plugin steps the scratch-HOME run must skip or report and not fail; check how setup handles a missing
`claude` binary or plist in a clean HOME (`[unsourced]`).

**U2 — CLAUDE.md + orchestrator memory (S).** Rewrite CLAUDE.md as above. Add the missing orchestrator rules
to wt-memory role orchestrator, and list them in the commit message.
Files: `CLAUDE.md` (the memory store is outside the repo).
Verify: `grep -c "orchestrator" CLAUDE.md` finds only the skill-map mentions. `wt-memory list` (role
orchestrator) shows the claim-first, dispatch-badge, verify/commit/report and umkmall-contact rules.

**U3 — docs (S).** Update repo-relative paths: `README.md:6,31` ("Each directory is one skill" becomes
"Each directory under `skills/`"; `wt-shared/scripts/wt-judge.mjs`), `docs/features.md:5,251`,
`docs/handoff-2026-09-26.md:22`, and bare sibling refs in SKILL.md files (`wt-agents/SKILL.md:68`,
`wt-plan/SKILL.md:209`, `wt-handoff/SKILL.md:22,29`). The SKILL.md refs become `~/.claude/skills/<name>/…`,
the same form every other SKILL.md command uses (`wt-plan/SKILL.md:93`). Old plan docs in `docs/plans/` are
point-in-time records and are **not** rewritten.
Files: `README.md`, `docs/features.md`, `docs/handoff-2026-09-26.md`, `skills/wt-agents/SKILL.md`,
`skills/wt-plan/SKILL.md`, `skills/wt-handoff/SKILL.md`.
Verify: `grep -rnE '(^|[ \x60(])wt-(shared|plan|agents|dashboard|memory|handoff)/' README.md docs/features.md docs/handoff-*.md CLAUDE.md skills/*/SKILL.md`
returns only `~/.claude/skills/…` or `skills/…` forms.

**U4 — host rollout (no code; done by whoever merges).** The rollout order above, with the output captured.

Order: U1 → U2 → U3 → merge → U4. U2 and U3 depend on U1's paths.

## Files

- `wt-*/` → `skills/wt-*/` (the rename; 19 dirs, per `ls` at plan time)
- `setup`, `.claude-plugin/marketplace.json`, `.gitignore`, `skills/wt-setup/SKILL.md`
- `CLAUDE.md`, `README.md`, `docs/features.md`, `docs/handoff-2026-09-26.md`
- `skills/wt-agents/SKILL.md`, `skills/wt-plan/SKILL.md`, `skills/wt-handoff/SKILL.md`
- Outside the repo, changed by setup and the rollout: `~/.claude/skills/*` links, `~/Library/LaunchAgents/id.local.wtdashboard.server.plist`,
  the `~/.claude/settings.json` hook path, and wt-memory role notes

## Verification

- The scratch-HOME setup run described in U1, covering the migration and doctor.
- The existing test suites pass from their new paths: `skills/wt-dashboard` `npm test`, `skills/wt-dashboard/web`
  `npx tsc --noEmit -p . && npm test`, and the wt-memory and wt-agents node tests.
- After merge, on the host: `./setup install` reports links and the service as migrated, `./setup doctor`
  reports no failures, `readlink ~/.claude/skills/wt-plan` ends in `/skills/wt-plan`,
  `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:7777/` returns 200 or 401 after the service
  restart, `wt-ticket list` works, and `grep eval-plan ~/.claude/settings.json` shows the `~/.claude/skills` path.

## Definition of Done

Each item is shown by a command whose output is in the transcript:
- `ls` at the repo root shows `skills/` and no `wt-*` dirs, and `ls skills | wc -l` equals the pre-move count.
- A scratch-HOME `setup install` converts old-layout links to `skills/` targets, and `setup doctor` there
  reports the links as ok.
- All the test suites listed under Verification pass.
- The U3 grep shows no stale repo-relative paths in the live docs.
- CLAUDE.md contains no orchestrator-only rules, and `wt-memory list` shows the four added orchestrator
  rules.
- After the host rollout: `./setup doctor` is clean, the dashboard answers on :7777 after a restart, and
  `wt-ticket list` and `wt-handoff --help` run.

## Risks and deferred

- **A window between merge and `./setup install`** where every `~/.claude/skills` link dangles, so every
  agent's skills vanish. This is kept to seconds by doing the rollout as one command sequence. Agents started
  in that window lose their skills until they restart.
- **Peer checkouts or another machine** on the old layout: `root_of` recognises both layouts, but a second
  machine needs its own `git pull && ./setup install`.
- **The plugin cache** may keep the old wt-memory source path until `marketplace update` or a reinstall
  (`[unsourced]`).
- **Deferred:** an `AGENTS.md` symlink, and converting the repo root into a plugin root as in the reference
  (not asked for).
