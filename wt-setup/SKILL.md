---
name: wt-setup
description: >
  Install, check, or remove wt-pack on this machine by running the repo's `./setup` script: links the
  skills, installs the wt-memory plugin, builds the dashboard and runs it under launchd, and reports what
  is missing. Use when asked to install, set up, bootstrap, repair or doctor wt-pack, to check whether
  wt-pack is working, or to uninstall it. Not for configuring a single skill.
allowed-tools: Bash, Read, AskUserQuestion
---

# wt-setup

All the logic lives in `<repo>/setup`; this skill only runs it and relays what it asks. `<repo>` is the
wt-pack checkout: the directory `~/.claude/skills/wt-setup` links into (`dirname "$(readlink -f ~/.claude/skills/wt-setup)"`),
or, before anything is linked, the clone the user names.

1. **Doctor first.** `<repo>/setup doctor`: one line per need (✓ ok, ✗ required and failing, – optional),
   exit 1 while a required one fails. Show the ✗ lines to the user as they are.
2. **Install** when doctor fails or the user asked: `<repo>/setup install`. It lists missing Homebrew packages
   and asks one y/N before installing them. Ask the user that question with AskUserQuestion; if they say
   yes, re-run with `--yes`. Never install Homebrew or herdr yourself: setup prints how, the user runs it.
   Pass `--no-secrets` (this session cannot type into a hidden prompt), and tell the user the keys come last.
3. **Secrets are typed by the user**, never by you: ask them to run `! <repo>/setup secrets` for the
   TypeSafe key. The Linear key goes in the dashboard, Settings › Integrations (stored in the Keychain).
4. **gh login** is the user's too: when doctor says gh is not logged in, ask them to run `! gh auth login`.
5. **Uninstall** only when asked: `<repo>/setup uninstall` removes the service, the plugin and the skill
   links that point into that checkout, and keeps data, config, keys and logs. `--purge` also deletes the
   dashboard's data and config after a y/N; confirm with the user first, then pass `--yes`.

`setup` never repoints an install that already belongs to another wt-pack checkout (skill links, the plugin
marketplace, the launchd service): it reports them as kept. Run it from the checkout that should own the
install. Finish by showing the final doctor lines.
