// Run: node --test skills/wt-watch-prs/scripts/poller-service.test.mjs
// Only the pure plist()/systemdUnit() output is testable without a real launchd — install/uninstall/status shell out to
// launchctl directly, the same untested-by-design boundary as wt-dashboard/scripts/service.mjs.
import test from 'node:test'
import assert from 'node:assert/strict'
import { plist, systemdUnit, shimText, SHIM, LABEL } from './poller-service.mjs'

test('plist: runs watch-prs.sh serve via bash, KeepAlive restarts on any non-zero exit, PATH and log are escaped', () => {
  const xml = plist({ path: '/usr/bin:/bin', log: '/tmp/a & b.log', script: '/tmp/watch-prs.sh' })
  assert.match(xml, new RegExp(`<string>${LABEL}</string>`))
  assert.match(xml, /<string>\/bin\/bash<\/string><string>\/tmp\/watch-prs\.sh<\/string><string>serve<\/string>/)
  assert.match(xml, /<key>SuccessfulExit<\/key><false\/>/)
  assert.match(xml, /<string>\/usr\/bin:\/bin<\/string>/)
  assert.match(xml, /\/tmp\/a &amp; b\.log/) // XML-escaped, not raw
  assert.doesNotMatch(xml, /\/tmp\/a & b\.log</) // the raw ampersand never appears unescaped
})

test('WP-190 systemdUnit: bash serve via a quoted script path, Restart=always, PATH/HOME env, % and " escaped', () => {
  const u = systemdUnit({ path: '/usr/bin:/bin', script: '/tmp/a b/100%/$x/watch-prs.sh', home: '/home/u' })
  assert.match(u, /^ExecStart=\/bin\/bash "\/tmp\/a b\/100%%\/\$\$x\/watch-prs\.sh" serve$/m)
  assert.match(u, /^Restart=always$/m)
  assert.match(u, /^Environment="PATH=\/usr\/bin:\/bin"$/m)
  assert.match(u, /^Environment="HOME=\/home\/u"$/m)
  assert.match(u, /^WantedBy=default\.target$/m)
})

test('WP-191 shimText: execs the current watch-prs.sh with all arguments, quoting shell metacharacters', () => {
  const t = shimText('/a b/$x/`y`/watch-prs.sh')
  assert.match(t, /^#!\/bin\/bash\n/)
  assert.match(t, /^exec bash "\/a b\/\\\$x\/\\`y\\`\/watch-prs\.sh" "\$@"$/m)
  assert.match(SHIM, /\/bin\/watch-prs$/)
})

// WP-192: the detached fallback for hosts with no launchd/systemd, forced with WT_POLLER_DETACHED=1 and a temp home so
// nothing real is touched. Runs the real `watch-prs.sh serve` (no watchers registered: it only heartbeats).
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('WP-192 detached poller: install starts it once, is idempotent, status sees it, uninstall kills the recorded pid', () => {
  const wh = mkdtempSync(join(tmpdir(), 'wt-poller-')), home = mkdtempSync(join(tmpdir(), 'wt-poller-home-'))
  const cli = (c) => spawnSync(process.execPath, [join(import.meta.dirname, 'poller-service.mjs'), c], { encoding: 'utf8',
    env: { ...process.env, WT_POLLER_DETACHED: '1', WT_WATCH_PRS_HOME: wh, HOME: home } })
  const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
  let pid = 0
  try {
    let r = cli('install'); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /started detached/)
    pid = Number(readFileSync(join(wh, 'poller.pid'), 'utf8')); assert.ok(pid > 1 && alive(pid), 'pid recorded and alive')
    assert.ok(existsSync(join(wh, 'poller.beat')), 'first heartbeat written before install returned')
    assert.match(cli('status').stdout, new RegExp(`running, pid ${pid}`))
    r = cli('install'); assert.match(r.stdout, /already running/); assert.equal(Number(readFileSync(join(wh, 'poller.pid'), 'utf8')), pid)
    assert.equal(spawnSync('bash', [join(import.meta.dirname, 'watch-prs.sh'), 'poller-status'], { env: { ...process.env, WT_WATCH_PRS_HOME: wh, HOME: home } }).status, 0)
    r = cli('uninstall'); assert.equal(r.status, 0, r.stderr)
    assert.ok(!alive(pid), 'recorded pid killed'); assert.ok(!existsSync(join(wh, 'poller.pid')))
    assert.match(cli('status').stdout, /not running/)
  } finally { if (pid && alive(pid)) process.kill(pid, 'SIGKILL'); rmSync(wh, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }) }
})
