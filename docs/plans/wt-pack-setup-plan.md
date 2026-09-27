# wt-pack setup — plan

Goal: a machine with only Claude Code (+ git, which Claude Code's install needs anyway [unsourced]) runs one
command and ends with a working wt-pack: skills linked, wt-memory plugin installed, dashboard built and
running under launchd, optional secrets stored, and a doctor report. Plus `doctor` and `uninstall`.
macOS-first; Linux gaps listed, not solved.

## Settled decisions (proceeding without a synchronous user; posted to #wt-pack for veto)
1. **Entry = one POSIX shell script `./setup` at repo root** with subcommands `install` (default) | `doctor` |
   `uninstall`. Plus a thin skill **`wt-setup/SKILL.md`** that just tells Claude to run `./setup <cmd>` and
   relay prompts — so "Claude Code only" users can say "set up wt-pack". No logic in the skill.
2. **Clone location**: wherever the repo already is (`setup` resolves its own dir). Bootstrap one-liner in
   README: `gh repo clone rephol/wt-pack ~/Work/projects/wt-pack && ~/Work/projects/wt-pack/setup`
   (private repo → needs `gh auth login` first; README says so).
3. **Never auto-installs without asking**: missing Homebrew packages are listed, then one y/N prompt runs
   `brew install <list>`. `--yes` skips the prompt. Missing Homebrew itself → print the official install
   command and stop (don't pipe-to-sh on the user's behalf).
4. Reuse existing tools, no new deps: `wt-dashboard/scripts/service.mjs install|uninstall|status`,
   `claude plugin marketplace add/install`, `security` via the dashboard's existing Settings.

## Inventory (from the tree)
| Need | Evidence | Setup action |
|---|---|---|
| node ≥22.6 | `wt-dashboard/package.json` test uses `node --experimental-strip-types`; vite `^8.3.0` in web/package.json (Vite 8 needs Node 20.19+/22.12+ [unsourced]) | require ≥22.12; offer `brew install node` |
| herdr | used by `wt-agents/scripts/agents.sh`, `wt-handoff/scripts/handoff.sh`, `wt-room/scripts/room`, `wt-shared/scripts/task-state.sh`, `wt-dashboard/server.mjs`, `terminals.mjs` | check on PATH; install source unknown [unsourced] — print install hint, mark required-for-agents |
| jq | `agents.sh`, `handoff.sh`, `task-state.sh`, `server.mjs` | brew |
| gh + auth | `wt-pr/scripts/pr.sh`, `wt-dashboard/unfurl.mjs`, `server.mjs` | brew; `gh auth status` else tell user to run `! gh auth login` |
| git, curl | `worktree.sh`; `wt-room/scripts/room` uses curl | check only (system) |
| tailscale (optional) | `config.mjs:153` proxy detection; handoff doc `tailscale serve --bg 7777` | doctor reports only |
| cargo/Rust (optional, Tauri app) | `package.json` `app:build` sources `~/.cargo/env` | doctor reports only; not installed |
| skills symlinks | README: `for d in …/wt-*; do ln -s "$d" ~/.claude/skills/; done` | link every `wt-*` dir incl. `wt-shared` and new `wt-setup`; idempotent: skip correct link, **refuse** (report) if a non-link or a link to elsewhere exists |
| plugin | `.claude-plugin/marketplace.json` name `wt-pack`, plugin `wt-memory`; `wt-memory/SKILL.md:62` `claude plugin marketplace add ~/Work/projects/wt-pack && claude plugin install wt-memory@wt-pack` | run with `$REPO`; if already added, `marketplace update` + `plugin update` |
| ~/.config/wt-memory | `wt-memory/SKILL.md:10-12` global.md, roles/, projects/ | `mkdir -p` (files created on demand [unsourced] — worker verifies wt-memory script tolerates absence) |
| dashboard deps + build | `package.json` `"build": "npm --prefix web run build"` | `npm ci --prefix wt-dashboard/web` (if lockfile, else `npm install`) then `npm --prefix wt-dashboard run build` |
| launchd service | `service.mjs` LABEL `id.local.wtdashboard.server`, idempotent install (bootout+bootstrap) | `node wt-dashboard/scripts/service.mjs install`; Linux: skip, print `npm --prefix wt-dashboard start` |
| config env | `wt-dashboard/SKILL.md:16` `~/.config/wt-dashboard/env` keys LINEAR_API_KEY, WT_DASHBOARD_ALLOWED_HOSTS, WT_DASHBOARD_PROJECTS | `mkdir -p`, `touch`, chmod 600; never overwrite |
| Linear key | Keychain service `wt-dashboard` (`SKILL.md:16`, `config.mjs:40` secret via stdin to `security -i`) | optional prompt: point user at dashboard Settings › Integrations (the existing, safe path) rather than re-implementing keychain writes |
| TypeSafe key | `wt-shared/scripts/typesafe.mjs:20-33` env or `~/.claude/.env` line | optional prompt (read -s), append `TYPESAFE_API_KEY=` to `~/.claude/.env` chmod 600 only if absent |
| data/log dirs | `~/.local/share/wt-dashboard/{data,uploads}`, `~/Library/Logs/wt-dashboard/` | service.mjs makes the log dir; server makes data dirs [unsourced] — doctor checks |
| Codex/Gemini | `wt-memory/SKILL.md:53-60` snippets | doctor prints "optional: see wt-memory/SKILL.md" if `codex`/`gemini` on PATH; no auto-edit |

Hardcoded `~/Work/projects/wt-pack` appears in `wt-dashboard/web/src/memory.tsx:36` (install hint text) and
`wt-memory/SKILL.md:62`; setup uses `$REPO` so those stay cosmetic. `MYAPP_REPO` default is myapp-specific
(`config.mjs:17`) — out of scope, noted.

## Units
1. **`setup` script skeleton + doctor** (`setup`, repo root, executable). `doctor` prints one line per
   inventory row: ✓ / ✗ required / – optional, with fix hint; exit 1 if any required ✗. Required: node≥22.12,
   git, jq, gh(+auth), herdr, skills linked, plugin installed, web built (`wt-dashboard/web/dist/index.html`
   [unsourced path — worker confirms vite outDir]), service loaded (`service.mjs status` output), dashboard
   answers `curl -s -o /dev/null -w %{http_code} http://127.0.0.1:7777/` (port: `server.mjs:28` `const PORT = Number(process.env.PORT ?? 7777)`,
   loopback-only per `server.mjs:2054`).
   Check: run `./setup doctor` on this machine → all ✓.
2. **install**: deps (brew prompt) → link skills → dirs/env file → plugin → npm install+build → service
   install → optional secrets (skipped with `--no-secrets` or non-tty) → `doctor`. Every step idempotent;
   second run changes nothing and prints "ok" per step.
   Check: run `./setup install --yes --no-secrets` twice on this machine; second run all "already".
3. **uninstall**: `service.mjs uninstall`, `claude plugin uninstall wt-memory@wt-pack` + marketplace remove,
   remove only symlinks in ~/.claude/skills that point into `$REPO`. Keeps data, config, secrets, logs (prints
   their paths; `--purge` deletes `~/.local/share/wt-dashboard` and `~/.config/wt-dashboard` after y/N).
   Check: test with `HOME=$(mktemp -d)` sandbox for link removal only — **do not uninstall the live
   service/plugin on this machine** (user's dashboard is running).
4. **Fresh-install test in a sandbox**: `HOME=$(mktemp -d) ./setup install --yes --no-secrets --no-service`
   links skills into the temp HOME and builds; confirms no path assumes the real HOME. (`--no-service` exists
   because launchd label is global.) Add a tiny `setup.test.sh` only if cheap; otherwise the transcript is
   the evidence.
5. **`wt-setup` skill** (`wt-setup/SKILL.md`): description triggers on "install/set up/doctor/uninstall
   wt-pack"; body: run `./setup doctor` first, then `install`; relay y/N prompts to user; secrets typed by
   the user via `! ./setup secrets`. Update README Install section and CLAUDE.md skill map row.

Linux gaps (printed by doctor on non-Darwin): no launchd (manual `npm start`/systemd user unit not provided),
no Keychain (env file fallback exists in config.mjs:100), no brew prompt (apt names printed), Tauri app n/a.

## Definition of done
- `./setup doctor` on this Mac: all required ✓, exit 0 (transcript).
- `./setup install --yes --no-secrets` run twice: second run makes no changes; service still running.
- Sandbox-HOME install succeeds and links every `wt-*` dir.
- `cd wt-dashboard && npm test` still green.
- Commits: one per skill touched (`setup`+README+CLAUDE.md, `wt-setup`), pushed to origin.

## Out of scope
Auto-installing herdr/Homebrew, systemd unit, Tauri build, editing Codex/Gemini configs, MYAPP_REPO default.
