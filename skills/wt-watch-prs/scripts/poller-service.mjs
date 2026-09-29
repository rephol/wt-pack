// WP-187: the wt-watch-prs background poller (watch-prs.sh serve) as a macOS LaunchAgent, independent of any
// session. node scripts/poller-service.mjs install | uninstall | restart | status
// Idempotent. launchd restarts it after a crash (KeepAlive SuccessfulExit=false, at most every 10s) and starts
// it at login; stdout/stderr go to ~/Library/Logs/wt-watch-prs/poller.log. This mirrors
// wt-dashboard/scripts/service.mjs's own plist shape deliberately (same KeepAlive/ThrottleInterval/login-PATH
// approach) — a small, self-contained copy rather than a cross-skill import, since the two labels are
// otherwise unrelated and a change to one's plist shape has no reason to touch the other's.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export const LABEL = 'id.local.wtpack.watchprs'
const HOME = homedir()
const PLIST = join(HOME, 'Library', 'LaunchAgents', `${LABEL}.plist`)
const LOG = join(HOME, 'Library', 'Logs', 'wt-watch-prs', 'poller.log')
const ROOT = dirname(dirname(fileURLToPath(import.meta.url))) // skills/wt-watch-prs
const SCRIPT = join(ROOT, 'scripts', 'watch-prs.sh')
const DOMAIN = `gui/${userInfo().uid}`
const launchctl = (...a) => execFileSync('/bin/launchctl', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const loaded = () => { try { launchctl('print', `${DOMAIN}/${LABEL}`); return true } catch { return false } }

// The same PATH the dashboard's plist builds: the login shell's, plus nvm, Homebrew, cargo and ~/.local/bin —
// serve shells out to gh/jq/herdr, none of which launchd's own minimal PATH carries.
export function loginPath() {
  const parts = []
  try { parts.push(execFileSync('/bin/zsh', ['-lc', 'echo $PATH'], { encoding: 'utf8' }).trim()) } catch { /* no zsh */ }
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

function install() {
  const path = loginPath()
  mkdirSync(dirname(PLIST), { recursive: true })
  mkdirSync(dirname(LOG), { recursive: true })
  writeFileSync(PLIST, plist({ path, log: LOG }))
  if (loaded()) launchctl('bootout', `${DOMAIN}/${LABEL}`) // pick up a changed plist
  launchctl('bootstrap', DOMAIN, PLIST)
  console.log(`installed ${PLIST}\n  script ${SCRIPT}\n  log ${LOG}`)
}
function uninstall() {
  if (loaded()) launchctl('bootout', `${DOMAIN}/${LABEL}`)
  if (existsSync(PLIST)) unlinkSync(PLIST)
  console.log('uninstalled')
}
function status() {
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
    else if (cmd === 'restart') { if (!loaded()) throw new Error('not installed — run poller-service:install'); launchctl('kickstart', '-k', `${DOMAIN}/${LABEL}`); console.log('restarted') }
    else if (cmd === 'status') status()
    else { console.error('usage: poller-service.mjs install|uninstall|restart|status'); process.exit(2) }
  } catch (e) { console.error(String(e.stderr || e.message).trim()); process.exit(1) }
}
