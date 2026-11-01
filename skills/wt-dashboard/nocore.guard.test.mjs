// WP-378 F4: tests never start an hc core. A test file that spawns server.mjs (or any process that ends up running `hc`) must pin it to a stub:
// hcStub (test-hc.mjs, a working fake core) or noCore (test-nocore.mjs, a shim that refuses every call). Otherwise the real `hc` runs under the temp HOME
// and `hc server status|ls|get` start a real core (seen from tickets.test.mjs). This scans every *.test.mjs under skills/.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { noCore } from './test-nocore.mjs'
import { spawnSync } from 'node:child_process'

const SKILLS = new URL('..', import.meta.url).pathname
const walk = (d, out = []) => {
  for (const f of readdirSync(d)) {
    if (f === 'node_modules' || f === 'dist' || f.startsWith('.')) continue
    const p = join(d, f), s = statSync(p)
    if (s.isDirectory()) walk(p, out); else if (/\.test\.mjs$/.test(f)) out.push(p)
  }
  return out
}
// spawn/fork/exec(File)(… 'server.mjs' …) within one call's first 250 chars, but not wt-memory's own mcp/server.mjs
export const spawnsServer = (src) => /\b(spawn|fork|exec|execFile)(Sync)?\s*\([\s\S]{0,250}?(?<!mcp\/)(?<=['"\/])server\.mjs/.test(src)
export const pinned = (src) => /\b(hcStub|noCore)\b/.test(src)

test('no test spawns server.mjs without a stub hc (hcStub or noCore): the real hc would start a core', () => {
  const bad = walk(SKILLS).filter((f) => !f.endsWith('nocore.guard.test.mjs')).filter((f) => { const s = readFileSync(f, 'utf8'); return spawnsServer(s) && !pinned(s) })
  assert.deepEqual(bad.map((f) => f.slice(SKILLS.length)), [])
})
test('the scan sees a spawn of server.mjs (so an empty result is not a broken regex)', () => {
  assert.ok(spawnsServer("spawn(process.execPath, ['server.mjs'], {})"))
  assert.ok(spawnsServer("const srv = spawn(process.execPath, [new URL('./server.mjs', import.meta.url).pathname], {"))
  assert.ok(!spawnsServer("execFileSync(new URL('../mcp/server.mjs', import.meta.url).pathname, {"))
  assert.ok(pinned("import { hcStub } from './test-hc.mjs'") && pinned("noCore()") && !pinned("spawn(x)"))
})
test('the noCore shim refuses and records every call (exit 98), and flags a start', () => {
  const nc = noCore()
  try {
    assert.equal(nc.started(), false)
    const r = spawnSync('hc', ['server', 'start'], { env: nc.env(), encoding: 'utf8' })
    assert.equal(r.status, 98); assert.match(r.stderr, /refused by the test no-core shim/)
    assert.deepEqual(nc.calls(), ['server start']); assert.equal(nc.started(), true)
    assert.ok(!('HC_TERMINAL_ID' in nc.env({ PATH: '/bin', HC_TERMINAL_ID: 't1', HERDR_PANE_ID: 'x', WT_PANE_KEY: 'k' })))
  } finally { nc.close() }
})
