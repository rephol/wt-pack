// Run: node --test skills/wt-agents/scripts/dnd.test.mjs — WP-147: `agents.sh dnd <name|pane> on|off` sets/clears
// the `dnd` pane token through herdr pane report-metadata, resolving the target the way `rm` does.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, chmodSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const here = import.meta.dirname
const tmp = mkdtempSync(join(tmpdir(), 'wt-dnd-'))
const bin = join(tmp, 'bin'), log = join(tmp, 'calls.log')
mkdirSync(bin)
writeFileSync(join(bin, 'herdr'), `#!/bin/sh\necho "herdr $*" >> ${log}\ncase "$1 $2" in\n  "agent list") echo '{"result":{"agents":[{"name":"demo-worker-01","pane_id":"w1:p1"}]}}' ;;\n  *) echo '{"result":{}}' ;;\nesac\n`)
chmodSync(join(bin, 'herdr'), 0o755)

const run = (args) => {
  rmSync(log, { force: true })
  const r = spawnSync(join(here, 'agents.sh'), args, { encoding: 'utf8', env: { PATH: `${bin}:${process.env.PATH}`, HOME: tmp } })
  return { ...r, calls: (() => { try { return readFileSync(log, 'utf8').split('\n') } catch { return [] } })() }
}

test('dnd <name> on: sets the dnd token', () => {
  const r = run(['dnd', 'demo-worker-01', 'on'])
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout.trim(), 'dnd on: demo-worker-01 (w1:p1)')
  assert.ok(r.calls.some((l) => /^herdr pane report-metadata w1:p1 --source wt-dashboard --token dnd=1$/.test(l)))
})

test('dnd <pane> off: clears the dnd token', () => {
  const r = run(['dnd', 'w1:p1', 'off'])
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout.trim(), 'dnd off: w1:p1 (w1:p1)')
  assert.ok(r.calls.some((l) => /^herdr pane report-metadata w1:p1 --source wt-dashboard --clear-token dnd$/.test(l)))
})

test('dnd: bad state or unknown agent', () => {
  let r = run(['dnd', 'demo-worker-01', 'sideways'])
  assert.equal(r.status, 2)
  assert.match(r.stderr, /dnd: on, off, or omit to query/)
  r = run(['dnd', 'nobody', 'on'])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /no such agent: nobody/)
})

test('dnd <name>: queries the current state without changing it', () => {
  writeFileSync(join(bin, 'herdr'), `#!/bin/sh\necho "herdr $*" >> ${log}\ncase "$1 $2" in\n  "agent list") echo '{"result":{"agents":[{"name":"demo-worker-01","pane_id":"w1:p1"}]}}' ;;\n  "pane get") echo "{\\"result\\":{\\"pane\\":{\\"tokens\\":{\\"dnd\\":\\"$DND_VAL\\"}}}}" ;;\n  *) echo '{"result":{}}' ;;\nesac\n`)
  chmodSync(join(bin, 'herdr'), 0o755)
  const runWith = (args, dnd) => {
    rmSync(log, { force: true })
    const r = spawnSync(join(here, 'agents.sh'), args, { encoding: 'utf8', env: { PATH: `${bin}:${process.env.PATH}`, HOME: tmp, DND_VAL: dnd } })
    return { ...r, calls: (() => { try { return readFileSync(log, 'utf8').split('\n') } catch { return [] } })() }
  }
  assert.equal(runWith(['dnd', 'demo-worker-01'], '').stdout.trim(), 'dnd off: demo-worker-01 (w1:p1)')
  assert.equal(runWith(['dnd', 'demo-worker-01'], '1').stdout.trim(), 'dnd on: demo-worker-01 (w1:p1), no expiry')
  const r = runWith(['dnd', 'demo-worker-01'], '2099-01-01T00:00:00.000Z')
  assert.equal(r.stdout.trim(), 'dnd on: demo-worker-01 (w1:p1) until 2099-01-01T00:00:00.000Z')
  // querying never writes
  assert.ok(!r.calls.some((l) => l.includes('report-metadata')))
})

test('dnd on --for: writes an ISO expiry, same format as the dashboard', () => {
  const r = run(['dnd', 'demo-worker-01', 'on', '--for', '2h'])
  assert.equal(r.status, 0, r.stderr)
  const call = r.calls.find((l) => l.includes('report-metadata'))
  const m = call.match(/--token dnd=([^\s]+)/)
  assert.ok(m, call)
  const until = new Date(m[1])
  assert.ok(!Number.isNaN(until.getTime()))
  const hoursAhead = (until - Date.now()) / 3_600_000
  assert.ok(hoursAhead > 1.9 && hoursAhead < 2.1, hoursAhead)
})

test('dnd on --for: bad duration is rejected', () => {
  const r = run(['dnd', 'demo-worker-01', 'on', '--for', 'soon'])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /bad --for duration/)
})

test('dnd off --for: rejected, --for only applies to on', () => {
  const r = run(['dnd', 'demo-worker-01', 'off', '--for', '2h'])
  assert.equal(r.status, 2)
  assert.match(r.stderr, /--for only valid with on/)
})
