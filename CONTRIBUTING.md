# Contributing to wt-pack

Thanks for looking. wt-pack is a set of Claude Code skills plus a local dashboard; this page is what you need to
change either without breaking the other.

## Set up

You need macOS or Linux, Node ≥ 22.13 (for `node:sqlite`), Git, [`gh`](https://cli.github.com),
[herdr](https://herdr.dev) and Claude Code.

```sh
git clone https://github.com/rephol/wt-pack.git ~/wt-pack
~/wt-pack/setup            # links skills, installs the plugin, builds and starts the dashboard
~/wt-pack/setup doctor     # what is missing, one line per check
```

`./setup uninstall` removes what it installed and keeps your data.

## Layout

- `skills/wt-*` — one directory per skill, each linked as `~/.claude/skills/<name>`. A skill is its `SKILL.md`
  plus `scripts/` (and `references/` where it has them).
- `skills/wt-dashboard` — the dashboard: `server.mjs` and its modules (Node, no dependencies), the web UI in
  `web/src` (React 19, Vite, TanStack Query, Astryx UI), the Tauri 2 Mac app in `app/`.
- `docs/features.md` — the feature reference: what each feature does, where it lives, its defaults.
- `docs/plans/` — implementation plans written before larger changes.

## Tests

```sh
cd skills/wt-dashboard
npm test                                  # server + skill scripts (node --test), web unit tests, bundle check
cd web && npx tsc --noEmit -p . && npm run build
```

Run a single server test file with `node --test <file>.test.mjs`. A change that adds logic adds the test that
fails without it.

## Rules for a change

- **One commit per skill touched.** A change to `wt-dashboard` and `wt-room` is two commits. Stage your own
  paths only (`git commit <paths>`), never `-a`.
- **Keep every CLI backward compatible.** Scripts are called by other skills, by running agents and by
  people's muscle memory: add flags, don't rename or remove them.
- **User-visible change → `docs/features.md` in the same change.** A feature the reference does not mention is
  unfinished.
- **The dashboard stays on your machine**: loopback only, session cookie, Host/Origin
  allowlist, no calls to the Claude API from the dashboard. Keep those guards intact.
- Match the surrounding code: its comment density, naming and idiom.

## Issues and pull requests

- **Bug or idea:** open an issue at <https://github.com/rephol/wt-pack/issues>. For a bug, include what you ran,
  what you expected, what happened, and `./setup doctor` output.
- **Pull request:** branch from `main`, keep it to one topic, run the tests above, and describe what changed and
  why. Screenshots help for UI changes (a phone width too, the dashboard is used on phones).

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE).
