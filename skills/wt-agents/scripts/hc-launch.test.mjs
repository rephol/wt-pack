// Run: node --test skills/wt-agents/scripts/hc-launch.test.mjs — WP-378: the launcher every agent terminal runs under hc.
// It is run the way the core runs it: with the CORE's leaked environment plus the spawner's values (WT_LAUNCH_KEYS), under a
// real login+interactive bash whose rc files fight back (set GH_TOKEN, rewrite PATH).
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, statSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const here = import.meta.dirname
const LAUNCH = join(here, 'hc-launch')
const tmp = mkdtempSync(join(tmpdir(), 'wt-hc-launch-'))
const home = join(tmp, 'home'), shim = join(tmp, 'shim'), data = join(tmp, 'data')
mkdirSync(home); mkdirSync(shim); mkdirSync(join(tmp, 'norc'))
// an rc that fights: sets the pack's own names and rewrites PATH to something without the shim, and defines an rc-only variable
writeFileSync(join(home, '.bash_profile'), 'export GH_TOKEN=from-rc\nexport WT_PANE_KEY=from-rc\nexport RC_ONLY=yes\nPATH=/usr/bin:/bin\nexport PATH\n')
const BASH = ['/bin/bash', '/usr/bin/bash'].find((p) => existsSync(p)) ?? 'bash'

// What the program sees: env printed as KEY=VALUE lines, PATH first.
const run = (extra = {}, args = ['--', '/usr/bin/env']) => {
  const env = { PATH: '/usr/bin:/bin', HOME: home, SHELL: BASH, WT_DASHBOARD_DATA: data, HC_TERMINAL_ID: 't7', HC_SESSION: 'wtt-x', ...extra }
  const r = spawnSync(LAUNCH, args, { env, encoding: 'utf8' })
  return { ...r, env: Object.fromEntries((r.stdout ?? '').split('\n').filter((l) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])) }
}

test('denylist: what the core inherited from another agent is scrubbed, what the spawner set is kept', () => {
  const r = run({ HOME: join(tmp, 'norc'), // no rc here, so a surviving value can only have come from the core's environment
 GH_TOKEN: 'leaked-gh', WT_PANE_KEY: 'mine', WT_DELIVER_TOKEN: 'leak', WT_HEADLESS_ID: 'hl-1', CLAUDE_ENV_FILE: '/other/env.sh', HERDR_PANE_ID: 'w1:p1', HERDR_ENV: '1', WT_ROLE: 'other-role',
    WT_LAUNCH_KEYS: 'WT_PANE_KEY,WT_ROLE' })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.env.WT_PANE_KEY, 'mine')
  for (const k of ['GH_TOKEN', 'WT_DELIVER_TOKEN', 'WT_HEADLESS_ID', 'CLAUDE_ENV_FILE', 'HERDR_PANE_ID', 'HERDR_ENV']) assert.equal(r.env[k], undefined, k)
  assert.equal(r.env.WT_ROLE, 'other-role', 'WT_ROLE was named in WT_LAUNCH_KEYS so it is the spawner\'s value') // here the spawner "set" it
  assert.equal(r.env.HC_SESSION, 'wtt-x', 'HC_SESSION is the core\'s own for this terminal: an isolated core\'s agents must keep it')
  assert.equal(r.env.HC_TERMINAL_ID, 't7')
})

test('the pack beats the rc: an rc that sets GH_TOKEN/WT_PANE_KEY and rewrites PATH does not win; rc-only variables still arrive; bookkeeping is gone', () => {
  const r = run({ GH_TOKEN: 'pack-gh', WT_PANE_KEY: 'pack-key', WT_KILL_SHIM_DIR: shim, WT_LAUNCH_KEYS: 'GH_TOKEN,WT_PANE_KEY,WT_KILL_SHIM_DIR' })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.env.GH_TOKEN, 'pack-gh'); assert.equal(r.env.WT_PANE_KEY, 'pack-key')
  assert.equal(r.env.RC_ONLY, 'yes', '-l -i: the interactive rc ran')
  assert.ok(r.env.PATH.startsWith(`${shim}:`), `shim dir first on PATH after the rc rewrote it: ${r.env.PATH}`)
  assert.ok(r.env.PATH.includes('/usr/bin'))
  assert.equal(r.env.WT_LAUNCH_KEYS, undefined)
  assert.ok(!Object.keys(r.env).some((k) => k.startsWith('__WTL_')))
})

test('writes pane-keys/$HC_TERMINAL_ID (0600 in a 0700 dir) from WT_PANE_KEY before the program starts', () => {
  const r = run({ WT_PANE_KEY: 'abc123', WT_LAUNCH_KEYS: 'WT_PANE_KEY' }, ['--', '/bin/sh', '-c', `cat ${data}/pane-keys/t7`])
  assert.equal(r.stdout.trim().split('\n').pop(), 'abc123', r.stderr)
  assert.equal(statSync(join(data, 'pane-keys', 't7')).mode & 0o777, 0o600)
  assert.equal(statSync(join(data, 'pane-keys')).mode & 0o777, 0o700)
  rmSync(join(data, 'pane-keys'), { recursive: true })
  run({ WT_LAUNCH_KEYS: '' }) // no key set: no file
  assert.ok(!existsSync(join(data, 'pane-keys', 't7')))
})

test('the program gets its arguments untouched and its exit status comes back', () => {
  const r = run({ WT_LAUNCH_KEYS: '' }, ['--', '/bin/sh', '-c', 'printf "%s|" "$@"; exit 7', 'x', 'a b', '$HOME', "it's"])
  assert.equal(r.status, 7)
  assert.match(r.stdout, /a b\|\$HOME\|it's\|$/)
})

test('a shell the launcher cannot drive with -c still starts the program, with the pack values', () => {
  const r = run({ SHELL: '/usr/bin/false-shell', GH_TOKEN: 'pack-gh', WT_LAUNCH_KEYS: 'GH_TOKEN' })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.env.GH_TOKEN, 'pack-gh')
})

test('no program is an error', () => {
  assert.equal(spawnSync(LAUNCH, ['--'], { encoding: 'utf8' }).status, 2)
})
