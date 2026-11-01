// WP-378: test kit for agents.sh on the fake hc (skills/wt-shared/scripts/fake-hc) — a fake core, a fake herdr-app, row builders.
// Nothing here talks to a real hc, a real herdr-app or a real terminal.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installFakeHc } from '../../wt-shared/scripts/fake-hc.mjs'

// A listening unix socket + core.lock where hc.mjs coreUp() looks (XDG_STATE_HOME/herdr-core/<session>/core.lock). The path is
// short because a socket path is limited to 103 bytes. A connect completes in the kernel backlog, so a test that blocks its own
// event loop with execFileSync still sees the core "up".
export async function fakeCore(session = 'wtt-a') {
  const dir = mkdtempSync(join('/tmp', 'wc-'))
  const sock = join(dir, 's')
  mkdirSync(join(dir, 'state', 'herdr-core', session), { recursive: true })
  writeFileSync(join(dir, 'state', 'herdr-core', session, 'core.lock'), sock)
  const srv = createServer(() => {})
  await new Promise((r) => srv.listen(sock, r))
  return { env: { XDG_STATE_HOME: join(dir, 'state'), HC_SESSION: session }, stop: () => { srv.close(); rmSync(dir, { recursive: true, force: true }) } }
}

const APP = `#!/usr/bin/env node
// fake herdr-app: replays fixtures/herdr-app/*.json; FAKE_APP_CASES {"ls": "empty"|"one_space"|{exit,stdout,stderr}, "do": "space_new"}; logs args to FAKE_APP_LOG
const fs = require('fs'), path = require('path')
const a = process.argv.slice(2)
fs.appendFileSync(process.env.FAKE_APP_LOG, JSON.stringify(a) + '\\n')
const cases = JSON.parse(process.env.FAKE_APP_CASES || '{}')
const verb = a[0] === 'do' ? 'do' : a[0]
let want = cases[verb === 'do' ? 'do:' + a[1] : verb] ?? cases[verb]
const file = path.join(process.env.FAKE_APP_FIX, verb + '.json')
let out = want && typeof want === 'object' ? want : JSON.parse(fs.readFileSync(file, 'utf8')).cases[want ?? (verb === 'do' ? a[1].replace('.', '_') : Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).cases)[0])]
if (!out) { console.error('fake herdr-app: no case'); process.exit(99) }
process.stdout.write(out.stdout ?? ''); process.stderr.write(out.stderr ?? ''); process.exit(out.exit ?? 0)
`

export function installFakeApp(cases = {}, dir = mkdtempSync(join(tmpdir(), 'fake-app-'))) {
  const bin = join(dir, 'bin'); mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'herdr-app'), APP); chmodSync(join(bin, 'herdr-app'), 0o755)
  const log = join(dir, 'app.jsonl')
  return {
    bin, env: { FAKE_APP_CASES: JSON.stringify(cases), FAKE_APP_LOG: log, FAKE_APP_FIX: new URL('../../wt-shared/scripts/fixtures/herdr-app', import.meta.url).pathname },
    calls: () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []),
  }
}

// terminal.list rows in the recorded shape (only the fields the pack reads).
export const term = (address, name, { labels = {}, status = null, cwd = '/repo', state = 'live', program = 'claude', pid = 1000 + Number(address.slice(1)) } = {}) => ({
  address, name, cwd, state, labels, argv: [program], keep: false, exit_code: state === 'live' ? null : 0, reason: state === 'live' ? null : 'exited', turn: 0, title: '',
  status: status ? { app: 'claude-code', state: status } : null, foreground: state === 'live' ? { argv: [program], name: '2.1.316', pid } : undefined,
})
export const listCase = (...rows) => ({ exit: 0, stdout: JSON.stringify({ jsonrpc: '2.0', id: 1, result: { hidden_finished: 0, terminals: rows } }) + '\n' })
export const runCase = (address) => ({ exit: 0, stdout: JSON.stringify({ jsonrpc: '2.0', id: 1, result: { address, state: 'live', labels: {}, name: 'x' } }) + '\n' })

// Everything one agents.sh run needs: PATH with the fake hc (and optional fake herdr-app) first, HOME/XDG in tmp.
export function harness({ tmp, cases = {}, app = null, extraEnv = {} } = {}) {
  const fake = installFakeHc({ cases })
  const env = { ...fake.env, HOME: tmp, XDG_CACHE_HOME: tmp, WT_DASHBOARD_DATA: tmp, WT_DASHBOARD_ENV: join(tmp, 'env'), ...(app ? { ...app.env, PATH: `${app.bin}:${fake.env.PATH}` } : {}), ...extraEnv }
  return { fake, env }
}
