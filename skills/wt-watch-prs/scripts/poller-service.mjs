// WP-187: the wt-watch-prs background poller (watch-prs.sh serve) as a macOS LaunchAgent, independent of any
// session; WP-190: on Linux the same commands manage a systemd user unit (wt-watch-prs.service) instead.
// node scripts/poller-service.mjs install | uninstall | restart | status
// Idempotent. launchd restarts it after a crash (KeepAlive SuccessfulExit=false, at most every 10s) and starts
// it at login; stdout/stderr go to ~/Library/Logs/wt-watch-prs/poller.log. This mirrors
// wt-dashboard/scripts/service.mjs's own plist shape deliberately (same KeepAlive/ThrottleInterval/login-PATH
// approach) — a small, self-contained copy rather than a cross-skill import, since the two labels are
// otherwise unrelated and a change to one's plist shape has no reason to touch the other's.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, readdirSync, unlinkSync, chmodSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export const LABEL = 'id.local.wtpack.watchprs'
const HOME = homedir()
const PLIST = join(HOME, 'Library', 'LaunchAgents', `${LABEL}.plist`)
const LOG = join(HOME, 'Library', 'Logs', 'wt-watch-prs', 'poller.log')
const ROOT = dirname(dirname(fileURLToPath(import.meta.url))) // skills/wt-watch-prs
const SCRIPT = join(ROOT, 'scripts', 'watch-prs.sh')
// WP-191: the service runs a stable shim, not SCRIPT — a plugin update moves the plugin's directory, and the
// shim (rewritten by every install) is the one path the unit/plist never has to change.
export const SHIM = join(process.env.WT_WATCH_PRS_HOME || join(HOME, '.local', 'share', 'wt-watch-prs'), 'bin', 'watch-prs')
export const shimText = (script = SCRIPT) => `#!/bin/bash\n# written by poller-service.mjs install; points at the current watch-prs.sh\nexec bash "${script.replace(/[\\"$`]/g, '\\$&')}" "$@"\n`
function writeShim() { mkdirSync(dirname(SHIM), { recursive: true }); writeFileSync(SHIM, shimText()); chmodSync(SHIM, 0o755) }
const LINUX = process.platform === 'linux'
const UNIT_NAME = 'wt-watch-prs.service'
const UNIT = join(process.env.XDG_CONFIG_HOME || join(HOME, '.config'), 'systemd', 'user', UNIT_NAME)
const DOMAIN = `gui/${userInfo().uid}`
const launchctl = (...a) => execFileSync('/bin/launchctl', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const loaded = () => { try { launchctl('print', `${DOMAIN}/${LABEL}`); return true } catch { return false } }

// The same PATH the dashboard's plist builds: the login shell's, plus nvm, Homebrew, cargo and ~/.local/bin —
// serve shells out to gh/jq/herdr, none of which launchd's own minimal PATH carries.
export function loginPath() {
  const parts = []
  if (LINUX) parts.push(process.env.PATH ?? '') // systemd's own user PATH is minimal; the installing shell's is not
  else try { parts.push(execFileSync('/bin/zsh', ['-lc', 'echo $PATH'], { encoding: 'utf8' }).trim()) } catch { /* no zsh */ }
  try { for (const v of readdirSync(join(HOME, '.nvm/versions/node'))) parts.push(join(HOME, '.nvm/versions/node', v, 'bin')) } catch { /* no nvm */ }
  parts.push('/opt/homebrew/bin', '/usr/local/bin', join(HOME, '.cargo/bin'), join(HOME, '.local/bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin')
  return [...new Set(parts.join(':').split(':').filter(Boolean))].join(':')
}
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export function plist({ path, log, script = SCRIPT }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>${esc(script)}</string><string>serve</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Background</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>${esc(path)}</string>
  </dict>
  <key>StandardOutPath</key><string>${esc(log)}</string>
  <key>StandardErrorPath</key><string>${esc(log)}</string>
</dict>
</plist>
`
}

// systemd expands `%` specifiers and `$VAR` inside ExecStart=/Environment=, and `"` ends a quoted word.
const q = (v) => v.replace(/%/g, '%%').replace(/\$/g, '$$$$').replace(/"/g, '\\"')
export function systemdUnit({ path, script = SCRIPT, home = HOME }) {
  return `[Unit]
Description=wt-watch-prs background poller (watch-prs.sh serve)
After=network.target

[Service]
ExecStart=/bin/bash "${q(script)}" serve
Restart=always
RestartSec=10
Environment="PATH=${q(path)}"
Environment="HOME=${q(home)}"

[Install]
WantedBy=default.target
`
}
const systemctl = (...a) => execFileSync('systemctl', ['--user', ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const noSystemd = () => { try { systemctl('show-environment'); return false } catch { return true } }
const NOHUP = `no systemd user manager here (container?) — run it by hand:\n  nohup bash ${SCRIPT} serve >> ~/.local/share/wt-watch-prs/poller.log 2>&1 &`
const lingerOn = () => { try { return /Linger=yes/.test(execFileSync('loginctl', ['show-user', userInfo().username, '-p', 'Linger'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })) } catch { return false } }

function installLinux() {
  if (noSystemd()) { console.log(NOHUP); process.exit(2) }
  mkdirSync(dirname(UNIT), { recursive: true })
  writeShim(); writeFileSync(UNIT, systemdUnit({ path: loginPath(), script: SHIM }))
  systemctl('daemon-reload'); systemctl('enable', UNIT_NAME)
  systemctl('restart', UNIT_NAME) // starts it, or picks up a changed unit
  console.log(`installed ${UNIT}\n  script ${SHIM} → ${SCRIPT}\n  log: journalctl --user -u ${UNIT_NAME}`)
  if (!lingerOn()) console.log(`note: the service stops when you log out — keep it running with:  loginctl enable-linger ${userInfo().username}`)
}
function uninstallLinux() {
  if (!noSystemd()) { try { systemctl('disable', '--now', UNIT_NAME) } catch { /* not enabled */ } }
  if (existsSync(UNIT)) unlinkSync(UNIT)
  if (existsSync(SHIM)) unlinkSync(SHIM)
  if (!noSystemd()) systemctl('daemon-reload')
  console.log('uninstalled')
}
function statusLinux() {
  if (!existsSync(UNIT)) return console.log('not installed')
  let st = 'unknown'; try { st = systemctl('is-active', UNIT_NAME).trim() } catch (e) { st = String(e.stdout || 'inactive').trim() }
  console.log(`${UNIT_NAME}: ${st === 'active' || st === 'activating' ? 'running' : st}\n  log: journalctl --user -u ${UNIT_NAME}`)
}

function install() {
  if (LINUX) return installLinux()
  const path = loginPath()
  mkdirSync(dirname(PLIST), { recursive: true })
  mkdirSync(dirname(LOG), { recursive: true })
  writeShim(); writeFileSync(PLIST, plist({ path, log: LOG, script: SHIM }))
  if (loaded()) launchctl('bootout', `${DOMAIN}/${LABEL}`) // pick up a changed plist
  launchctl('bootstrap', DOMAIN, PLIST)
  console.log(`installed ${PLIST}\n  script ${SHIM} → ${SCRIPT}\n  log ${LOG}`)
}
function uninstall() {
  if (LINUX) return uninstallLinux()
  if (loaded()) launchctl('bootout', `${DOMAIN}/${LABEL}`)
  if (existsSync(PLIST)) unlinkSync(PLIST)
  if (existsSync(SHIM)) unlinkSync(SHIM)
  console.log('uninstalled')
}
function status() {
  if (LINUX) return statusLinux()
  if (!existsSync(PLIST)) return console.log('not installed')
  if (!loaded()) return console.log(`installed (${PLIST}) but not loaded — run poller-service:install`)
  const out = launchctl('print', `${DOMAIN}/${LABEL}`)
  const pick = (k) => out.match(new RegExp(`^\\s*${k} = (.+)$`, 'm'))?.[1]
  console.log(`${LABEL}: ${pick('state') ?? '?'}, pid ${pick('pid') ?? '-'}, runs ${pick('runs') ?? '?'}, last exit ${pick('last exit code') ?? '-'}\n  log ${LOG}`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cmd = process.argv[2]
  try {
    if (cmd === 'install') install()
    else if (cmd === 'uninstall') uninstall()
    else if (cmd === 'restart') {
      if (LINUX) { if (!existsSync(UNIT)) throw new Error('not installed — run poller-service.mjs install'); systemctl('restart', UNIT_NAME) }
      else { if (!loaded()) throw new Error('not installed — run poller-service:install'); launchctl('kickstart', '-k', `${DOMAIN}/${LABEL}`) }
      console.log('restarted')
    }
    else if (cmd === 'status') status()
    else { console.error('usage: poller-service.mjs install|uninstall|restart|status'); process.exit(2) }
  } catch (e) { console.error(String(e.stderr || e.message).trim()); process.exit(1) }
}
