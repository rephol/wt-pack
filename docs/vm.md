# Running wt-pack on a Linux VM

One machine holds everything: herdr, a logged-in Claude Code, your repos, and the dashboard. You reach the
dashboard from your laptop or phone through **Tailscale** (preferred) or an **SSH tunnel**. Never through a
public URL or an open port: whoever reaches the dashboard can type into agents that run with bypassed
permissions.

## 1. Install

As in the README's Linux quick start, on the VM (Debian/Ubuntu shown; use `sudo` unless you are root):

```sh
sudo apt-get install -y git curl jq gh                          # plus Node ≥ 22.13 (nodesource or nvm)
curl -fsSL https://herdr.dev/install.sh | sh                    # installs to ~/.local/bin
npm i -g @anthropic-ai/claude-code && claude                    # log in once
gh auth login
git clone https://github.com/rephol/wt-pack.git ~/wt-pack
~/wt-pack/setup
~/wt-pack/setup doctor                            # every required line ✓
```

`test/docker/` runs the same install in a clean `node:22` container, if you want to see it work first.

## 2. Keep herdr running

The dashboard reads agents from the herdr server; without it the Overview cannot load. Start it from an SSH
session and detach. The server keeps running after the client leaves, as tmux does:

```sh
herdr        # then detach; `herdr status server` should say "status: running"
```

## 3. Run the dashboard as a service

launchd is macOS only. On Linux, use the systemd user unit that ships with the dashboard:

```sh
mkdir -p ~/.config/systemd/user
cp ~/wt-pack/skills/wt-dashboard/scripts/wt-dashboard.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now wt-dashboard
loginctl enable-linger "$USER"          # keep it running when you log out
journalctl --user -u wt-dashboard -f    # its log
```

Edit the unit's paths if your checkout is not `~/wt-pack`, or if `node`, `gh`, `herdr` and
`claude` are not on its `PATH` line.

### The PR-watch poller (wt-watch-prs)

`./setup install` also installs the wt-watch-prs background poller as `~/.config/systemd/user/wt-watch-prs.service`
(`ExecStart=bash <checkout>/skills/wt-watch-prs/scripts/watch-prs.sh serve`, `Restart=always`, your login `PATH`),
then `daemon-reload` and `enable --now`. It never uses sudo, so run the linger command yourself when `setup`
advises it, or the unit stops when you log out:

```sh
loginctl enable-linger "$USER"
systemctl --user status wt-watch-prs      # or: node ~/wt-pack/skills/wt-watch-prs/scripts/poller-service.mjs status
journalctl --user -u wt-watch-prs -f
```

`./setup doctor` checks the unit is active and its heartbeat is fresh; `./setup uninstall` removes it. With no
systemd user manager (a container), `setup` prints a `nohup bash …/watch-prs.sh serve &` line instead; without the
poller, wt-watch-prs falls back to arming its own Monitors.

## 4. Reach it

The server listens on `127.0.0.1:7777` only. Keep it that way, and pick one of these:

- **Tailscale** (phone and laptop, no port open anywhere): on the VM, run `tailscale serve --bg 7777`. Then,
  **from the VM itself** (e.g. `curl` through an SSH session, or the dashboard opened through the tunnel below),
  add the VM's tailnet hostname under Settings › Integrations › Allowed hosts (`WT_DASHBOARD_ALLOWED_HOSTS`).
  Open `https://<vm>.<tailnet>.ts.net` from any device on your tailnet.
- **SSH tunnel** (a laptop, nothing to configure): `ssh -L 7777:127.0.0.1:7777 <vm>`, then open
  <http://127.0.0.1:7777> locally.

### A non-loopback bind is refused

If `WT_DASHBOARD_HOST` is set to anything other than `127.0.0.1`, `::1` or `localhost`, the server refuses to
start and prints why. `WT_ALLOW_REMOTE=1` overrides that, for an interface only you can reach (a WireGuard or
tailnet address). With it:

- the bound `host:port` joins the Host/Origin allowlist. Bind a specific address: `0.0.0.0` would admit only a
  literal `0.0.0.0:7777` Host header, which no browser sends.
- the session cookie still gates every write.
- terminals stay loopback-only. They check the connection's address, not the bind.

`./setup doctor` shows which bind is configured.

## A remote reviewer (no dashboard)

A box that only runs wt-watch-prs reviewers, logged into gh as the reviewer account, has no dashboard and so
no `reviewerGithubAccount` setting. Declare the account instead, so preflight doesn't report DEGRADED and the
reviewer may approve (WP-126):

```sh
export WT_REVIEWER_LOGIN=<reviewer-login>          # in start.sh or the pane env
# or: echo <reviewer-login> > ~/.config/gh-reviewer-login   (path: GH_REVIEWER_LOGIN_FILE)
```

It only counts when `gh api user` returns that same login. A mismatch still runs degraded (comment only).

## Updating

```sh
cd ~/wt-pack && git pull && ./setup && systemctl --user restart wt-dashboard
```

`./setup` rebuilds the web UI when its sources changed. Data and config stay put:
`~/.local/share/wt-dashboard/` and `~/.config/wt-dashboard/`.

## What does not apply on Linux

- **The Mac app (Tauri)** and its tray, and **macOS notifications**, including the watchdog probe's server-down
  alert. Use the PWA instead: open the dashboard over Tailscale's https URL and install it from the browser.
- **launchd** and `npm run service:*`. Use the systemd unit above.
- **Keychain.** Keys go in `~/.config/wt-dashboard/env` (`./setup secrets` writes them there).
