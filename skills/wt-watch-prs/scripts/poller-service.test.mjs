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
  assert.match(u, /^Restart=always$/m); assert.match(u, /^WatchdogSec=180$/m); assert.match(u, /^Type=notify$/m)
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
import { mkdtempSync, readFileSync, readdirSync, existsSync, rmSync, mkdirSync, statSync } from 'node:fs'
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
    assert.ok(!alive(pid), 'recorded pid killed'); assert.ok(!existsSync(join(wh, 'poller.pid'))); assert.ok(!existsSync(join(wh, 'poller.beat')), 'no stale heartbeat left to fake a live poller')
    assert.match(cli('status').stdout, /not running/)
  } finally { if (pid && alive(pid)) process.kill(pid, 'SIGKILL'); rmSync(wh, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }) }
})

test('WP-192 detached poller: two simultaneous installs start exactly one poller', async () => {
  const { execFile } = await import('node:child_process'), { promisify } = await import('node:util')
  const wh = mkdtempSync(join(tmpdir(), 'wt-poller-')), home = mkdtempSync(join(tmpdir(), 'wt-poller-home-'))
  const env = { ...process.env, WT_POLLER_DETACHED: '1', WT_WATCH_PRS_HOME: wh, HOME: home }
  const cli = (c) => promisify(execFile)(process.execPath, [join(import.meta.dirname, 'poller-service.mjs'), c], { env })
  try {
    const out = (await Promise.all([cli('install'), cli('install')])).map((r) => r.stdout)
    assert.equal(out.filter((o) => /started detached/.test(o)).length, 1, out.join('\n'))
    assert.equal(out.filter((o) => /already running/.test(o)).length, 1, out.join('\n'))
  } finally { await cli('uninstall').catch(() => {}); rmSync(wh, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }) }
})

test('WP-192 detached poller supervises itself: a killed serve is restarted under the same loop pid, uninstall stops both', async () => {
  const { execFile } = await import('node:child_process'), { promisify } = await import('node:util')
  const wh = mkdtempSync(join(tmpdir(), 'wt-poller-')), home = mkdtempSync(join(tmpdir(), 'wt-poller-home-'))
  const env = { ...process.env, WT_POLLER_DETACHED: '1', WT_WATCH_PRS_HOME: wh, HOME: home, WATCH_PRS_RESTART: '1' }
  const cli = (c) => promisify(execFile)(process.execPath, [join(import.meta.dirname, 'poller-service.mjs'), c], { env })
  const procTable = () => { // "pid ppid command" rows: /proc where there is one (minimal containers have no ps), else ps
    if (existsSync('/proc/self/stat')) return readdirSync('/proc').filter((d) => /^\d+$/.test(d)).map((d) => {
      try { return `${d} ${readFileSync(`/proc/${d}/stat`, 'utf8').replace(/^\d+ \(.*\) \S+ /, '').split(' ')[0]} ${readFileSync(`/proc/${d}/cmdline`, 'utf8').replace(/\0/g, ' ')}` } catch { return '' }
    })
    return spawnSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' }).stdout.split('\n')
  }
  const serveChild = (loop) => // the serve process whose parent is the recorded loop pid
    procTable().map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter((m) => m && Number(m[2]) === loop && /watch-prs.* serve/.test(m[3])).map((m) => Number(m[1]))[0]
  const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
  const until = async (f) => { for (let i = 0; i < 100; i++) { const v = f(); if (v) return v; await new Promise((r) => setTimeout(r, 100)) } }
  let loop = 0
  try {
    await cli('install'); loop = Number(readFileSync(join(wh, 'poller.pid'), 'utf8'))
    const first = await until(() => serveChild(loop)); assert.ok(first, 'serve runs under the loop')
    process.kill(first, 'SIGKILL') // the crash
    const second = await until(() => { const c = serveChild(loop); return c && c !== first ? c : 0 })
    assert.ok(second, 'a new serve came back'); assert.equal(Number(readFileSync(join(wh, 'poller.pid'), 'utf8')), loop, 'same loop pid')
    await cli('uninstall'); await until(() => !alive(loop) && !alive(second))
    assert.ok(!alive(loop) && !alive(second), 'uninstall stopped the loop and its serve')
  } finally { for (const p of [loop]) if (p && alive(p)) try { process.kill(-p, 'SIGKILL') } catch {}; await cli('uninstall').catch(() => {}); rmSync(wh, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }) }
})

test('WP-196 detached supervisor kills a serve whose beat went stale and starts a new one', async () => {
  const { execFile } = await import('node:child_process'), { promisify } = await import('node:util')
  const wh = mkdtempSync(join(tmpdir(), 'wt-poller-')), home = mkdtempSync(join(tmpdir(), 'wt-poller-home-'))
  // a fake serve that never beats: the first (install-time) beat is written by us, so install can finish
  mkdirSync(join(wh, 'bin'), { recursive: true })
  const env = { ...process.env, WT_POLLER_DETACHED: '1', WT_WATCH_PRS_HOME: wh, HOME: home, WATCH_PRS_RESTART: '1', WATCH_PRS_WD_TICK: '1', WATCH_PRS_STALE: '3', WATCH_PRS_SLEEP: '600' }
  const cli = (c) => promisify(execFile)(process.execPath, [join(import.meta.dirname, 'poller-service.mjs'), c], { env })
  const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
  let loop = 0
  try {
    await cli('install'); loop = Number(readFileSync(join(wh, 'poller.pid'), 'utf8'))
    const beat = join(wh, 'poller.beat'), first = statSync(beat).mtimeMs
    // serve sleeps 600s between beats, so after WATCH_PRS_STALE the watchdog must restart it (new beat)
    for (let i = 0; i < 150 && statSync(beat).mtimeMs === first; i++) await new Promise((r) => setTimeout(r, 100))
    assert.notEqual(statSync(beat).mtimeMs, first, 'serve was restarted (beat rewritten)')
    assert.ok(alive(loop), 'the loop itself survives')
  } finally { await cli('uninstall').catch(() => {}); rmSync(wh, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }) }
})
