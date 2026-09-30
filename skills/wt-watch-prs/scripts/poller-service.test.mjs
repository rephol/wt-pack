// Run: node --test skills/wt-watch-prs/scripts/poller-service.test.mjs
// Only the pure plist()/systemdUnit() output is testable without a real launchd — install/uninstall/status shell out to
// launchctl directly, the same untested-by-design boundary as wt-dashboard/scripts/service.mjs.
import test from 'node:test'
import assert from 'node:assert/strict'
import { plist, systemdUnit, LABEL } from './poller-service.mjs'

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
  const u = systemdUnit({ path: '/usr/bin:/bin', script: '/tmp/a b/100%/watch-prs.sh', home: '/home/u' })
  assert.match(u, /^ExecStart=\/bin\/bash "\/tmp\/a b\/100%%\/watch-prs\.sh" serve$/m)
  assert.match(u, /^Restart=always$/m)
  assert.match(u, /^Environment="PATH=\/usr\/bin:\/bin"$/m)
  assert.match(u, /^Environment="HOME=\/home\/u"$/m)
  assert.match(u, /^WantedBy=default\.target$/m)
})
