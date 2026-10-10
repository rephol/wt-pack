# WP-309 — Headless agents: trimmed plugin set

## Problem
Every headless run (`skills/wt-dashboard/headless.mjs` `#start`, line ~105) spawns `claude -p` with the user's full
plugin set. Verified 2026-10-11: the run's `init` event lists **17** plugins (wt-pack, compound-engineering, context7,
github, ponytail, skill-creator, understand-anything, visual-explainer, context-mode, impeccable, figma, typesafe,
pixijs-skills, cowork-plugin-management, cc-plugin-agents-md, cc-plugin-telemetry, cc-plugin-plugin-authoring). Each
injects hooks/skills/MCP, hence the ~46k-token start; ponytail's "lazy developer" SessionStart text reaches planners.

## Mechanism (verified, not assumed)
`claude --settings '<json>'` with `{"enabledPlugins":{"<id>":false,…}}` turns those plugins off for that run only.
Tested: `--settings '{"enabledPlugins":{"ponytail@ponytail":false,"figma@claude-plugins-official":false}}'` → init
listed 15 plugins, both gone. `--settings '{}'` → 17.
- wt-pack is loaded through `env.CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json` (not `enabledPlugins`), so
  it is never in the off-map and always stays. Good: it carries wt-memory context/hooks the roles need.
- The four `cowork-plugin-management` / `cc-plugin-*` entries are not in the user's `enabledPlugins`; they are out of
  scope (not user-installed; leave them).
- Rejected: `--bare` (drops hooks for wt-pack too, and CLAUDE.md/auth handling changes); `--setting-sources`
  (would also drop the user's permission rules and model settings, which WP-300 relies on).

## Decisions (settled; dispatched run, no reachable user question needed — the ticket states the shape)
1. **Default = wt-pack only.** Server env `WT_HEADLESS_PLUGINS` (comma list of plugin ids that stay on; default
   empty = every `enabledPlugins:true` entry turned off; `*` = no trimming, today's behaviour).
2. **Per-run override** `plugins: string[]` on `POST /api/headless` — ids to keep on for that run; when given it
   replaces the server default. Validated: array of ≤40 strings matching `/^[\w.@-]{1,100}$/`, else 400.
3. Stored per run (`headless_runs.plugins TEXT`, JSON or NULL = server default) so `--resume` restarts with the same set.

## Units

### U1 — headless.mjs: build the off-map (skills/wt-dashboard)
- `spawn({…, plugins})`: validate (decision 2), store `JSON.stringify(plugins)` or null.
- `#start`: `keep = r.plugins ? JSON.parse(r.plugins) : this.plugins` (constructor option `plugins`, read from
  `env.WT_HEADLESS_PLUGINS` like `cap`: split on `,`, trim, drop empty). If `keep` includes `'*'` → no flag. Else read
  `enabledPlugins` from `${this.env.HOME}/.claude/settings.json` (try/catch → `{}`), off = every key with value
  `true` not in `keep`; if non-empty push `--settings`, `JSON.stringify({enabledPlugins: off})`.
  `// ponytail: user settings only; project/local enabledPlugins not trimmed — add when a repo enables plugins.`
- store.mjs: migration `ALTER TABLE headless_runs ADD COLUMN plugins TEXT;` (same shape as line 220).
- Test (`headless.test.mjs`, existing fake `cmd` pattern): HOME = temp dir with a settings.json enabling `a@x`,`b@y`;
  (i) default → args contain `--settings` with both false; (ii) `plugins:['a@x']` → only `b@y` false; (iii) env `*` →
  no `--settings`; (iv) bad `plugins` → 400.

### U2 — server.mjs: list for the dialog
- `GET /api/headless/plugins` → `{ plugins: [ids with enabledPlugins true], keep: <server default> }`. Must be
  matched **before** the `/api/headless/:id` GET branch (`headlessApi`, `if (!id) … if (!h.get(id)) 404`), or
  `plugins` is read as a run id. Add a route test in `headless.routes.test.mjs`.

### U3 — web: New agent dialog (skills/wt-dashboard/web/src/spawn.tsx)
- In the `headless &&` block (line ~106), a "Plugins" multi-select (existing Astryx checkbox/Selector pattern in this
  file) listing the GET result, preselected with `keep`; send `plugins` only when the user changed it. Caption:
  "wt-pack always loads".
- `npx tsc --noEmit -p tsconfig.app.json`, `npm run build`.

### U4 — docs/features.md (Headless agents section, line ~288/325)
Document `WT_HEADLESS_PLUGINS`, the default, `*`, and the dialog field.

## Definition of done
- `npm test` in skills/wt-dashboard passes, including the four U1 cases and the U2 route test.
- A real headless run from the dashboard with defaults: its `init` event (`GET /api/headless/<id>/events`, first
  `system/init`) lists no `ponytail@…`/`figma@…` plugin and does list `wt-pack`. Report the before/after plugin count.
- No e2e writing or running.

## QA brief
Dashboard → New agent → Run as: Headless. See the Plugins field listing the user's plugins, none ticked by default
(caption "wt-pack always loads"). Start a planner with defaults; open its Conversation: the run starts, and its events'
init lists wt-pack but not ponytail. Tick one plugin, start another run: that plugin appears in its init. Check at
412x700 and iPhone 13 that the field fits the dialog without horizontal scroll.

## Residual
- Project/local `enabledPlugins` are not trimmed (see ponytail comment).
- Default flips behaviour for existing users; `WT_HEADLESS_PLUGINS=*` restores it (documented in U4).
