# Switching an existing install to hc

wt-pack runs its agents as terminals of the `hc` (herdr-core) core. An install that ran agents under an earlier
terminal multiplexer switches in one step, because the plugin is the checkout (`CLAUDE_CODE_PLUGIN_DIRS`): the moment
the new code is on disk, every live session's hooks read `HC_TERMINAL_ID` instead of the old pane variable, so agents
started before the switch lose their identity (messages, asks, gate evidence). There is no migration of live agents;
agents from before the switch are simply not seen afterwards.

1. Finish what you need from the running agents first (open handoffs, unsent replies, pending PRs).
2. Install `hc`, then start its core once: `hc server start`. Nothing in wt-pack starts it for you, and
   `./setup doctor` only reports whether it is running.
3. Stop the old agents. Pull or merge the new wt-pack and push if the checkout has a remote.
4. Restart the dashboard once: `npm run service:restart` in `skills/wt-dashboard` (do not restart it repeatedly).
5. Respawn the orchestrator and your leads with `skills/wt-agents/scripts/agents.sh spawn <role>`; their pool shows up as a
   space in `herdr-app` when it is installed.
6. Run `./setup doctor`. It prints the `hc` version, whether the core is running, whether `herdr-app` is present, whether
   `notes = false` is set in `~/.config/herdr-core/config.toml` (read only; wt-pack never edits it), and warns, without
   removing anything, about leftovers of the old setup (a `~/.claude/settings.json` hook, launchd entries). Remove those by hand.

## What goes stale (not migrated)

Records made against the old pane ids (for example `w5:p8`) are matched by exact id and are not migrated: hc addresses
look like `t3`, so no old id ever matches a new terminal. After the switch, silently (no error, no banner):

- messages and deliveries still queued or awaiting an ack for an old pane are never delivered and never acked; they stay
  as `queued`/`sent` rows and show up as agents that never answered;
- a ticket assigned to an old pane (its `assignee` pane, and a buddy's `pair`) keeps that id, which resolves to no agent, so the
  card reads as assigned to an unknown agent and nothing picks it up;
- pending asks and Inbox cards that came from an old pane cannot be answered into it.

Finishing or closing these before step 1 (answer the asks, let queued messages land, reassign or release the tickets so
they read as unassigned) avoids all of it. After the switch, reassign the tickets to a new agent by hand.

Things that differ from the old setup are listed in [features.md](features.md): no remote machines yet, plain-text
terminal views, key-by-key typing limits in the Terminals view, and the blocked-agent queue.
