// WP-378 F4: a PATH-first `hc` for dashboard tests that do NOT need a core. NOT a test file (no *.test.mjs).
// A test that spawns server.mjs with the real PATH runs the REAL `hc` under a temp HOME, and `hc server status|ls|get` start a stopped
// core (CLAUDE.md D4). noCore() puts a shim first on PATH that starts nothing: every call is logged to <dir>/calls.jsonl and exits 98
// with a loud message, so the server sees "core unreachable" and the test can assert that no core start was ever attempted.
// Tests that need a working core use hcStub (test-hc.mjs) instead. `nocore.guard.test.mjs` fails any test that spawns server.mjs without one of the two.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SHIM = `#!/bin/sh
printf '%s\\n' "$*" >> "$NOCORE_DIR/calls.log"
echo "hc: refused by the test no-core shim (a test must not start or talk to a core): $*" >&2
exit 98
`
export function noCore() {
  const dir = mkdtempSync(join(tmpdir(), 'nocore-')), bin = join(dir, 'bin')
  mkdirSync(bin); writeFileSync(join(bin, 'hc'), SHIM); chmodSync(join(bin, 'hc'), 0o755)
  const calls = () => (existsSync(join(dir, 'calls.log')) ? readFileSync(join(dir, 'calls.log'), 'utf8').split('\n').filter(Boolean) : [])
  return {
    dir, calls,
    // a core START attempt: any `server start|restart|run`, or a bare `hc`/unknown verb that would autostart. Reads (`ls`, `get`, `server status`) autostart too (D4), so any call counts.
    started: () => calls().length > 0,
    // env for the spawned server: the shim first on PATH, HC_*/HERDR_*/WT_PANE_KEY never inherited (a child must not act as an agent terminal)
    env: (base = process.env) => {
      const e = Object.fromEntries(Object.entries(base).filter(([k]) => !/^(HC_|HERDR_|WT_PANE_KEY)/.test(k)))
      return { ...e, PATH: `${bin}:${base.PATH}`, HC_BIN: join(bin, 'hc'), NOCORE_DIR: dir, XDG_STATE_HOME: join(dir, 'st'), HC_SESSION: 'nocore' }
    },
    close: () => rmSync(dir, { recursive: true, force: true }),
  }
}
