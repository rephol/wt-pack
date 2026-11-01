// WP-378 F4: tests never start an hc core. A test file that spawns server.mjs (or any process that ends up running `hc`) must pin it to a stub:
// hcStub (test-hc.mjs, a working fake core) or noCore (test-nocore.mjs, a shim that refuses every call). Otherwise the real `hc` runs under the temp HOME
// and `hc server status|ls|get` start a real core (seen from tickets.test.mjs). This scans every *.test.mjs under skills/.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
// Per spawn site (not per file): every spawn/fork/exec(File)(Sync) call whose argument list names server.mjs (a literal, or a variable assigned from
// an expression naming it; wt-memory's own mcp/server.mjs excluded) must take its env from a hcStub()/noCore() value (`<ident>.env`).
const SPAWN = /\b(?:spawn|fork|exec|execFile)(?:Sync)?\s*\(/g
const callText = (src, open) => { // text of the call starting at its "(" , string-aware enough for test files
  let depth = 0, q = null
  for (let i = open; i < src.length; i++) {
    const c = src[i]
    if (q) { if (c === '\\') i++; else if (c === q) q = null; continue }
    if (c === "'" || c === '"' || c === '`') q = c
    else if (c === '(') depth++
    else if (c === ')' && --depth === 0) return src.slice(open, i + 1)
  }
  return src.slice(open)
}
const NAMES_SERVER = /(?<!mcp\/)(?<=['"\/])server\.mjs/
export function spawnSites(src) {
  const pins = [...src.matchAll(/\b(\w+)\s*=\s*(?:await\s+)?(?:hcStub|noCore)\s*\(/g)].map((m) => m[1])
  const pathVars = [...src.matchAll(/^(?!.*\bimport\s*\().*?\b(\w+)\s*=\s*[^\n]*(?<!mcp\/)(?<=['"\/])server\.mjs/gm)].map((m) => m[1])
  const sites = []
  for (const m of src.matchAll(SPAWN)) {
    const text = callText(src, m.index + m[0].length - 1)
    const targets = NAMES_SERVER.test(text) || pathVars.some((v) => new RegExp(`\\b${v}\\b`).test(text))
    if (!targets) continue
    sites.push({ line: src.slice(0, m.index).split('\n').length, pinned: pins.some((p) => new RegExp(`\\b${p}\\.env\\b`).test(text)) })
  }
  return sites
}
export const violations = (files) => {
  const bad = []; let scanned = 0, spawns = 0
  for (const f of files) {
    const sites = spawnSites(readFileSync(f, 'utf8')); scanned++; spawns += sites.length
    for (const s of sites) if (!s.pinned) bad.push(`${f.startsWith(SKILLS) ? f.slice(SKILLS.length) : f}:${s.line}`)
  }
  return { bad, scanned, spawns }
}
const mine = (f) => !f.endsWith('nocore.guard.test.mjs')

test('no test spawns server.mjs without a stub hc (hcStub or noCore): the real hc would start a core', () => {
  const { bad, scanned, spawns } = violations(walk(SKILLS).filter(mine))
  assert.ok(scanned > 0, 'the walk found no test files'); assert.ok(spawns > 0, 'the walk found no server spawns: the scan is broken')
  assert.deepEqual(bad, [])
})
test('the scan works per spawn site: one pinned and one unpinned spawn in a file is a violation; a path variable is followed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'guard-'))
  try {
    const f = join(dir, 'two.test.mjs')
    writeFileSync(f, `const nc = noCore()
const a = spawn(process.execPath, ['server.mjs'], { env: { ...nc.env(), PORT: '1' } })
const b = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: '2' } })
`)
    const r = violations([f])
    assert.equal(r.spawns, 2); assert.equal(r.bad.length, 1); assert.match(r.bad[0], /two\.test\.mjs:3$/)
    const g = join(dir, 'var.test.mjs')
    writeFileSync(g, `const hc = await hcStub({})
const SERVER = join(here, 'server.mjs')
spawn(process.execPath, [SERVER], { env: { ...process.env } })
spawn(process.execPath, [SERVER], { env: { ...hc.env } })
`)
    const v = violations([g]); assert.equal(v.spawns, 2); assert.equal(v.bad.length, 1)
    writeFileSync(join(dir, 'imp.test.mjs'), `const S = await import('./server.mjs')\nexecFileSync('x', [S])\nexecFileSync(new URL('../mcp/server.mjs', import.meta.url).pathname)\n`)
    assert.equal(violations([join(dir, 'imp.test.mjs')]).spawns, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
test('the noCore shim refuses and records every call (exit 98), and flags a start', () => {
  const nc = noCore()
  try {
    assert.equal(nc.started(), false)
    const r = spawnSync('hc', ['server', 'start'], { env: nc.env(), encoding: 'utf8' })
    assert.equal(r.status, 98); assert.match(r.stderr, /refused by the test no-core shim/)
    assert.deepEqual(nc.calls(), ['server start']); assert.equal(nc.started(), true)
    assert.ok(!('HC_TERMINAL_ID' in nc.env({ PATH: '/bin', HC_TERMINAL_ID: 't1', HERDR_PANE_ID: 'x', WT_PANE_KEY: 'k' }))) // legacy-herdr
  } finally { nc.close() }
})
