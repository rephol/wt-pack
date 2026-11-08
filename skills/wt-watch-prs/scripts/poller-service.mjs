// WP-187: the wt-watch-prs background poller (watch-prs.sh serve) as a macOS LaunchAgent, independent of any
// session; WP-190: on Linux the same commands manage a systemd user unit (wt-watch-prs.service) instead.
// node scripts/poller-service.mjs install | uninstall | restart | status
// Idempotent. launchd restarts it after a crash (KeepAlive SuccessfulExit=false, at most every 10s) and starts
// it at login; stdout/stderr go to ~/Library/Logs/wt-watch-prs/poller.log. This mirrors
// wt-dashboard/scripts/service.mjs's own plist shape deliberately (same KeepAlive/ThrottleInterval/login-PATH
// approach) — a small, self-contained copy rather than a cross-skill import, since the two labels are
// otherwise unrelated and a change to one's plist shape has no reason to touch the other's.
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, unlinkSync, chmodSync, statSync, openSync, rmSync } from 'node:fs'
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
Type=notify
NotifyAccess=all
WatchdogSec=180
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
const lingerOn = () => { try { return /Linger=yes/.test(execFileSync('loginctl', ['show-user', userInfo().username, '-p', 'Linger'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })) } catch { return false } }

// WP-192: no launchd and no systemd user manager (a container) — run `serve` detached under a pidfile. Node's
// detached:true makes the child a session leader (setsid), so it outlives this process and gets no SIGHUP; the shim
// `exec`s, so the recorded pid is a small restart loop (WP-192) around it. Everything below acts on that recorded pid, never on a name pattern.
const WH = dirname(dirname(SHIM))
const PID = join(WH, 'poller.pid'), BEAT = join(WH, 'poller.beat'), DLOG = join(WH, 'poller.log')
const detachedMode = () => process.env.WT_POLLER_DETACHED === '1' || (LINUX && noSystemd())
const readPid = () => { try { const n = Number(readFileSync(PID, 'utf8').trim()); return Number.isInteger(n) && n > 1 ? n : 0 } catch { return 0 } }
const cmdline = (pid) => { // /proc first (Linux, and minimal containers with no ps), then ps
  try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ') } catch { /* no /proc */ }
  try { return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) } catch { return '' }
}
// alive AND still `watch-prs.sh serve` — a recycled pid must not be signalled
const isPoller = (pid) => { try { process.kill(pid, 0) } catch { return false } return /watch-prs-loop|watch-prs\.sh"? serve/.test(cmdline(pid)) }
const beatAge = () => { try { return (Date.now() - statSync(BEAT).mtimeMs) / 1000 } catch { return Infinity } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function stopDetached() {
  const pid = readPid()
  // the group (detached made the poller its leader) takes its poll-* children with it
  if (pid && isPoller(pid)) { try { process.kill(-pid, 'SIGTERM') } catch { try { process.kill(pid, 'SIGTERM') } catch { /* gone */ } } for (let i = 0; i < 20 && isPoller(pid); i++) await sleep(100) }
  if (existsSync(PID)) unlinkSync(PID)
  if (pid && existsSync(BEAT)) unlinkSync(BEAT) // a stale beat must not read as a live hand-run poller for the next 3 minutes
  return pid
}
async function installDetached() {
  mkdirSync(WH, { recursive: true })
  const LOCK = join(WH, 'poller.lock') // two sessions installing at once must not both spawn
  for (let i = 0; ; i++) {
    try { mkdirSync(LOCK); break } catch (e) {
      if (e.code !== 'EEXIST') throw e
      if (i >= 100) { try { rmSync(LOCK, { recursive: true }) } catch { /* raced */ } continue } // stale after ~10s
      await sleep(100)
    }
  }
  try { await installDetachedLocked() } finally { try { rmSync(LOCK, { recursive: true }) } catch { /* gone */ } }
}
async function installDetachedLocked() {
  const pid = readPid()
  if (pid && isPoller(pid) && beatAge() < 180) return console.log(`already running (detached, pid ${pid}, beat ${Math.round(beatAge())}s ago)`)
  await stopDetached() // a live pid with a stale beat is wedged: replace it
  writeShim()
  const started = Date.now(), fd = openSync(DLOG, 'a')
  // A tiny supervisor: the pidfile holds this loop's pid, so a crashed `serve` comes back without any session.
  // WP-196: it also watches the beat — a `serve` that hangs (beat older than 3 min) is killed and comes back here.
  const LOOP = 'while :; do bash "$1" serve & p=$!; s=$(date +%s); (while sleep "${WATCH_PRS_WD_TICK:-30}"; do m=$(stat -c %Y "$2" 2>/dev/null || stat -f %m "$2" 2>/dev/null || echo 0); [ "$m" -lt "$s" ] && m=$s; [ $(($(date +%s) - m)) -ge "${WATCH_PRS_STALE:-180}" ] && { kill $p 2>/dev/null; break; }; done) & w=$!; wait $p 2>/dev/null; { kill $w; wait $w; } 2>/dev/null; sleep "${WATCH_PRS_RESTART:-5}"; done'
  const child = spawn('/bin/bash', ['-c', LOOP, 'watch-prs-loop', SHIM, BEAT], { detached: true, stdio: ['ignore', fd, fd], env: { ...process.env, PATH: loginPath() } })
  child.on('error', () => {}); child.unref(); writeFileSync(PID, `${child.pid}\n`)
  for (let i = 0; i < 60 && !(existsSync(BEAT) && statSync(BEAT).mtimeMs >= started); i++) await sleep(100) // first heartbeat
  if (!isPoller(child.pid)) { try { unlinkSync(PID) } catch { /* gone */ } throw new Error(`the poller exited at once — see ${DLOG}`) }
  console.log(`started detached (pid ${child.pid}; no launchd/systemd here)\n  script ${SHIM} → ${SCRIPT}\n  log ${DLOG}\n  it does not survive a reboot or container restart — start it there with:  bash ${SCRIPT} serve &`)
}
function statusDetached() {
  const pid = readPid()
  console.log(pid && isPoller(pid) ? `detached poller: running, pid ${pid}, beat ${Number.isFinite(beatAge()) ? Math.round(beatAge()) + 's ago' : 'none'}\n  log ${DLOG}` : 'detached poller: not running')
}

function installLinux() {
  mkdirSync(dirname(UNIT), { recursive: true })
  if (readPid()) { const p = readPid(); if (isPoller(p)) try { process.kill(p, 'SIGTERM') } catch {} ; try { unlinkSync(PID) } catch {} } // a leftover detached poller
  writeShim(); writeFileSync(UNIT, systemdUnit({ path: loginPath(), script: SHIM }))
  systemctl('daemon-reload'); systemctl('enable', UNIT_NAME)
  systemctl('restart', UNIT_NAME) // starts it, or picks up a changed unit
  console.log(`installed ${UNIT}\n  script ${SHIM} → ${SCRIPT}\n  log: journalctl --user -u ${UNIT_NAME}`)
  if (!lingerOn()) console.log(`note: the service stops when you log out — keep it running with:  loginctl enable-linger ${userInfo().username}`)
}
async function uninstallLinux() {
  await stopDetached()
  if (!noSystemd()) { try { systemctl('disable', '--now', UNIT_NAME) } catch { /* not enabled */ } }
  if (existsSync(UNIT)) unlinkSync(UNIT)
  if (existsSync(SHIM)) unlinkSync(SHIM)
  if (!noSystemd()) systemctl('daemon-reload')
  console.log('uninstalled')
}
function statusLinux() {
  if (!existsSync(UNIT)) return existsSync(PID) ? statusDetached() : console.log('not installed')
  let st = 'unknown'; try { st = systemctl('is-active', UNIT_NAME).trim() } catch (e) { st = String(e.stdout || 'inactive').trim() }
  console.log(`${UNIT_NAME}: ${st === 'active' || st === 'activating' ? 'running' : st}\n  log: journalctl --user -u ${UNIT_NAME}`)
}

async function install() {
  if (detachedMode()) return installDetached()
  if (LINUX) return installLinux()
  const path = loginPath()
  mkdirSync(dirname(PLIST), { recursive: true })
  mkdirSync(dirname(LOG), { recursive: true })
  writeShim(); writeFileSync(PLIST, plist({ path, log: LOG, script: SHIM }))
  if (loaded()) launchctl('bootout', `${DOMAIN}/${LABEL}`) // pick up a changed plist
  launchctl('bootstrap', DOMAIN, PLIST)
  console.log(`installed ${PLIST}\n  script ${SHIM} → ${SCRIPT}\n  log ${LOG}`)
}
async function uninstall() {
  if (LINUX) return uninstallLinux()
  if (process.env.WT_POLLER_DETACHED === '1') { await stopDetached(); if (existsSync(SHIM)) unlinkSync(SHIM); return console.log('uninstalled') }
  if (loaded()) launchctl('bootout', `${DOMAIN}/${LABEL}`)
  if (existsSync(PLIST)) unlinkSync(PLIST)
  if (existsSync(SHIM)) unlinkSync(SHIM)
  console.log('uninstalled')
}
function status() {
  if (process.env.WT_POLLER_DETACHED === '1') return statusDetached()
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
    if (cmd === 'install') await install()
    else if (cmd === 'uninstall') await uninstall()
    else if (cmd === 'restart') {
      if (detachedMode() || (LINUX && !existsSync(UNIT) && readPid())) { await stopDetached(); await installDetached(); process.exit(0) }
      if (LINUX) { if (!existsSync(UNIT)) throw new Error('not installed — run poller-service.mjs install'); systemctl('restart', UNIT_NAME) }
      else { if (!loaded()) throw new Error('not installed — run poller-service:install'); launchctl('kickstart', '-k', `${DOMAIN}/${LABEL}`) }
      console.log('restarted')
    }
    else if (cmd === 'status') status()
    else { console.error('usage: poller-service.mjs install|uninstall|restart|status'); process.exit(2) }
  } catch (e) { console.error(String(e.stderr || e.message).trim()); process.exit(1) }
}
