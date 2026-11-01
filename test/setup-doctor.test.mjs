// Run: node --test test/setup-doctor.test.mjs — WP-378: `./setup doctor` reports hc (version, core, herdr-app, notes) and old-multiplexer
// leftovers against a stub hc and a throwaway HOME. Nothing real is touched; the core is never started (the stub logs every call).
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:net'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

const run = promisify(execFile)
const REPO = join(import.meta.dirname, '..')

// async on purpose: a stub socket server in this process must keep serving while doctor runs (CLAUDE.md: sync spawn deadlocks it)
function rig({ withHc = true, withApp = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'sd-'))
  const home = join(root, 'home'); const bin = join(root, 'bin'); const log = join(root, 'hc.log'); const state = join(root, 'st')
  for (const d of [home, bin, state, join(home, '.config', 'herdr-core')]) mkdirSync(d, { recursive: true })
  if (withHc) {
    writeFileSync(join(bin, 'hc'), `#!/bin/sh\necho "$*" >> "${log}"\n[ "$1" = --version ] && echo "hc 0.1.16"\n[ "$1" = ls ] && echo '{"terminals":[{"address":"t1","agent":"claude-code"}]}'\nexit 0\n`)
    chmodSync(join(bin, 'hc'), 0o755)
  }
  if (withApp) { writeFileSync(join(bin, 'herdr-app'), '#!/bin/sh\nexit 0\n'); chmodSync(join(bin, 'herdr-app'), 0o755) }
  const noHc = process.env.PATH.split(delimiter).filter((d) => !existsSync(join(d, 'hc')) && !existsSync(join(d, 'herdr-app')))
  const env = { ...process.env, HOME: home, XDG_STATE_HOME: state, WT_DASHBOARD_DATA: join(home, 'dash'), PATH: [bin, ...noHc].join(delimiter) }
  delete env.HC_SESSION
  const doctor = async () => { try { return (await run('sh', [join(REPO, 'setup'), 'doctor', '--no-service'], { env, encoding: 'utf8', timeout: 90_000 })).stdout } catch (e) { return String(e.stdout) } }
  return { root, home, state, log, doctor, calls: () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []) }
}

test('doctor prints the hc version, reports a down core and never starts it', async () => {
  const r = rig({ withApp: true }); const out = await r.doctor()
  assert.match(out, /✓ hc 0\.1\.16/)
  assert.match(out, /– hc core not running — start it with: hc server start/)
  assert.match(out, /✓ herdr-app/)
  assert.deepEqual(r.calls(), ['--version'], 'only --version: ls, get and server status all start a stopped core')
  rmSync(r.root, { recursive: true, force: true })
})

test('doctor: a missing hc is a required failure with a hint; a missing herdr-app is only a note', async () => {
  const r = rig({ withHc: false }); const out = await r.doctor()
  assert.match(out, /✗ hc \(herdr-core\) — needed for agents/)
  rmSync(r.root, { recursive: true, force: true })
  const r2 = rig(); const out2 = await r2.doctor()
  assert.match(out2, /– herdr-app not found \(optional\)/)
  assert.doesNotMatch(out2, /✗ hc/)
  rmSync(r2.root, { recursive: true, force: true })
})

test('doctor reports notes in the user config read-only (the file is never changed)', async () => {
  const r = rig(); const cfg = join(r.home, '.config', 'herdr-core', 'config.toml')
  assert.match(await r.doctor(), /– hc config: notes is on/)
  writeFileSync(cfg, 'shell = ["nu"]\nnotes = false\n')
  assert.match(await r.doctor(), /✓ hc config: notes = false/)
  assert.equal(readFileSync(cfg, 'utf8'), 'shell = ["nu"]\nnotes = false\n')
  rmSync(r.root, { recursive: true, force: true })
})

test('doctor warns about old-multiplexer leftovers and removes nothing', async () => {
  const r = rig()
  mkdirSync(join(r.home, '.claude'), { recursive: true }); mkdirSync(join(r.home, 'Library', 'LaunchAgents'), { recursive: true })
  const hook = join(r.home, '.claude', 'settings.json'); writeFileSync(hook, '{"hooks":{"x":"bash herdr-agent-state.sh"}}') // legacy-herdr
  const plist = join(r.home, 'Library', 'LaunchAgents', 'x.herdr.plist'); writeFileSync(plist, '') // legacy-herdr
  const out = await r.doctor()
  assert.match(out, /legacy-herdr: ~\/\.claude\/settings\.json still runs/)
  assert.match(out, /legacy-herdr: launchd entries/)
  assert.ok(existsSync(plist) && existsSync(hook))
  rmSync(r.root, { recursive: true, force: true })
})

test('doctor with the core up says so and reads the terminals', async () => {
  const r = rig(); const sock = join(r.root, 's.sock')
  const srv = createServer((c) => c.end()); await new Promise((res) => srv.listen(sock, res))
  mkdirSync(join(r.state, 'herdr-core', 'default'), { recursive: true }); writeFileSync(join(r.state, 'herdr-core', 'default', 'core.lock'), sock)
  const out = await r.doctor(); srv.close()
  assert.match(out, /✓ hc core running/)
  assert.ok(r.calls().includes('ls --json'))
  rmSync(r.root, { recursive: true, force: true })
})
