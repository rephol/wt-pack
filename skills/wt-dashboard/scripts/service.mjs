// The dashboard server as a macOS LaunchAgent, independent of the desktop app.
//   node scripts/service.mjs install | uninstall | restart | status | probe
// install also installs the watchdog probe (WP-70): id.local.wtdashboard.watchdog runs scripts/watchdog-probe.sh
// every 2 minutes and notifies when /api/health stops answering. `probe` installs only that.
// Idempotent. launchd restarts it after a crash (KeepAlive SuccessfulExit=false, at most every 10s) and starts it
// at login; stdout/stderr go to ~/Library/Logs/wt-dashboard/server.log.
// ponytail: no log rotation; the file grows only on crashes and console output — truncate it by hand if it gets big.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export const LABEL = 'id.local.wtdashboard.server'
const HOME = homedir()
const PLIST = join(HOME, 'Library', 'LaunchAgents', `${LABEL}.plist`)
const LOG = join(HOME, 'Library', 'Logs', 'wt-dashboard', 'server.log')
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const DOMAIN = `gui/${userInfo().uid}`
const launchctl = (...a) => execFileSync('/bin/launchctl', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const loaded = (label = LABEL) => { try { launchctl('print', `${DOMAIN}/${label}`); return true } catch { return false } }
export const PROBE_LABEL = 'id.local.wtdashboard.watchdog'
const PROBE_PLIST = join(HOME, 'Library', 'LaunchAgents', `${PROBE_LABEL}.plist`)

// The same PATH the app builds: the login shell's, plus nvm, Homebrew, cargo and ~/.local/bin.
export function loginPath() {
  const parts = []
  try { parts.push(execFileSync('/bin/zsh', ['-lc', 'echo $PATH'], { encoding: 'utf8' }).trim()) } catch { /* no zsh */ }
  try { for (const v of readdirSync(join(HOME, '.nvm/versions/node'))) parts.push(join(HOME, '.nvm/versions/node', v, 'bin')) } catch { /* no nvm */ }
  parts.push('/opt/homebrew/bin', '/usr/local/bin', join(HOME, '.cargo/bin'), join(HOME, '.local/bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin')
  return [...new Set(parts.join(':').split(':').filter(Boolean))].join(':')
}
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export function plist({ node, root, path, log }) {
  const env = { PATH: path, WT_DASHBOARD_MANAGED: 'launchd' }
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${esc(node)}</string><string>${esc(join(root, 'server.mjs'))}</string></array>
  <key>WorkingDirectory</key><string>${esc(root)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>EnvironmentVariables</key><dict>
${Object.entries(env).map(([k, v]) => `    <key>${k}</key><string>${esc(v)}</string>`).join('\n')}
  </dict>
  <key>StandardOutPath</key><string>${esc(log)}</string>
  <key>StandardErrorPath</key><string>${esc(log)}</string>
</dict>
</plist>
`
}

// No KeepAlive: launchd runs the probe every StartInterval seconds and it exits.
export function probePlist({ root, log }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${PROBE_LABEL}</string>
  <key>ProgramArguments</key><array><string>/bin/sh</string><string>${esc(join(root, 'scripts', 'watchdog-probe.sh'))}</string></array>
  <key>StartInterval</key><integer>120</integer>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${esc(log)}</string>
  <key>StandardErrorPath</key><string>${esc(log)}</string>
</dict>
</plist>
`
}
function installProbe() {
  writeFileSync(PROBE_PLIST, probePlist({ root: ROOT, log: LOG }))
  if (loaded(PROBE_LABEL)) launchctl('bootout', `${DOMAIN}/${PROBE_LABEL}`)
  launchctl('bootstrap', DOMAIN, PROBE_PLIST)
  console.log(`installed ${PROBE_PLIST}`)
}

function install() {
  const path = loginPath()
  const node = path.split(':').map((d) => join(d, 'node')).find((p) => existsSync(p))
  if (!node) throw new Error('node not found on the login PATH')
  mkdirSync(dirname(PLIST), { recursive: true })
  mkdirSync(dirname(LOG), { recursive: true })
  writeFileSync(PLIST, plist({ node, root: ROOT, path, log: LOG }))
  if (loaded()) launchctl('bootout', `${DOMAIN}/${LABEL}`) // pick up a changed plist
  launchctl('bootstrap', DOMAIN, PLIST)
  console.log(`installed ${PLIST}\n  node ${node}\n  server ${join(ROOT, 'server.mjs')}\n  log ${LOG}`)
  installProbe()
}
function uninstall() {
  if (loaded()) launchctl('bootout', `${DOMAIN}/${LABEL}`)
  if (existsSync(PLIST)) unlinkSync(PLIST)
  if (loaded(PROBE_LABEL)) launchctl('bootout', `${DOMAIN}/${PROBE_LABEL}`)
  if (existsSync(PROBE_PLIST)) unlinkSync(PROBE_PLIST)
  console.log('uninstalled')
}
function status() {
  if (!existsSync(PLIST)) return console.log('not installed')
  if (!loaded()) return console.log(`installed (${PLIST}) but not loaded — run service:install`)
  const out = launchctl('print', `${DOMAIN}/${LABEL}`)
  const pick = (k) => out.match(new RegExp(`^\\s*${k} = (.+)$`, 'm'))?.[1]
  console.log(`${LABEL}: ${pick('state') ?? '?'}, pid ${pick('pid') ?? '-'}, runs ${pick('runs') ?? '?'}, last exit ${pick('last exit code') ?? '-'}\n  log ${LOG}`)
  // Second line on purpose: ./setup reads only the first (`head -1`), and this one never says ': running'.
  console.log(`watchdog probe: ${loaded(PROBE_LABEL) ? 'loaded (every 2 min)' : existsSync(PROBE_PLIST) ? 'installed, not loaded' : 'not installed'}`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cmd = process.argv[2]
  try {
    if (cmd === 'install') install()
    else if (cmd === 'uninstall') uninstall()
    else if (cmd === 'restart') { if (!loaded()) throw new Error('not installed — run service:install'); launchctl('kickstart', '-k', `${DOMAIN}/${LABEL}`); console.log('restarted') }
    else if (cmd === 'status') status()
    else if (cmd === 'probe') installProbe()
    else { console.error('usage: service.mjs install|uninstall|restart|status|probe'); process.exit(2) }
  } catch (e) { console.error(String(e.stderr || e.message).trim()); process.exit(1) }
}
