// Run: node --test contracts.test.mjs — contracts.mjs / contracts.d.mts stay in step, and no copy of a shared list creeps back (WP-254).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import * as c from './contracts.mjs'
import { ACTIONABLE, KINDS as INBOX_KINDS } from './inbox.mjs'
import { COLUMNS as TICKET_COLUMNS, TYPES as TICKET_TYPES, SIZES as TICKET_SIZES } from './tickets.mjs'

const here = import.meta.dirname
const dts = readFileSync(join(here, 'contracts.d.mts'), 'utf8')

test('every `declare const X: readonly [...]` in contracts.d.mts equals the runtime array', () => {
  const decl = [...dts.matchAll(/export declare const (\w+): readonly \[([^\]]*)\]/g)].map((m) => [m[1], [...m[2].matchAll(/'([^']*)'/g)].map((x) => x[1])])
  assert.deepEqual(decl.map(([n]) => n).sort(), ['ACTIONABLE_KINDS', 'COLUMNS', 'KINDS', 'SIZES', 'TYPES'])
  for (const [name, values] of decl) assert.deepEqual([...c[name]], values, name)
  // and every exported array has a declaration (a new list cannot ship without its types)
  for (const [name, v] of Object.entries(c)) if (Array.isArray(v)) assert.ok(decl.some(([n]) => n === name), `${name} has no declaration`)
})

test('the lists are frozen, ACTIONABLE_KINDS ⊆ KINDS, and the server modules use these very values', () => {
  for (const a of [c.COLUMNS, c.TYPES, c.SIZES, c.KINDS, c.ACTIONABLE_KINDS]) assert.ok(Object.isFrozen(a))
  for (const k of c.ACTIONABLE_KINDS) assert.ok(c.KINDS.includes(k), k)
  assert.equal(INBOX_KINDS, c.KINDS); assert.deepEqual([...ACTIONABLE], [...c.ACTIONABLE_KINDS])
  assert.equal(TICKET_COLUMNS, c.COLUMNS); assert.equal(TICKET_TYPES, c.TYPES); assert.equal(TICKET_SIZES, c.SIZES)
})

test('every inbox kind the server code emits is a known kind (the jev-auth / pair-gone drift)', () => {
  const emitted = new Set()
  for (const f of ['server.mjs', 'dispatch.mjs', 'routines.mjs', 'watchdog.mjs', 'asks.mjs', 'housekeeping.mjs', 'inbox.mjs', 'memstats.mjs']) {
    let src; try { src = readFileSync(join(here, f), 'utf8') } catch { continue }
    for (const m of src.matchAll(/(?:inbox\.add|notify\??\.?)\(\{\s*kind: '([a-z-]+)'/g)) emitted.add(m[1])
  }
  assert.ok(emitted.size >= 8, `found only ${[...emitted]}`) // the scan itself still finds the call sites
  for (const k of emitted) assert.ok(c.KINDS.includes(k), `${k} is emitted but not in KINDS`)
})

test('oneOf passes a member and throws the API\'s 400 error otherwise', () => {
  assert.equal(c.oneOf(c.COLUMNS, 'review', 'column'), 'review')
  assert.throws(() => c.oneOf(c.COLUMNS, 'nope', 'column'), (e) => e.status === 400 && /^column: backlog \| ready/.test(e.message))
})

// A copy of a shared list in another file is how the drift started: no source file but contracts.* may define one.
function walk(dir, out = []) {
  for (const f of readdirSync(dir)) {
    if (['node_modules', 'dist', 'test-fixtures', 'app'].includes(f)) continue
    const p = join(dir, f); const s = statSync(p)
    if (s.isDirectory()) walk(p, out); else if (/\.(mjs|ts|tsx)$/.test(f) && !/\.test\.|^contracts\./.test(f)) out.push(p)
  }
  return out
}
test('no other source file defines a column, kind or actionable list of its own', () => {
  const copies = /\[\s*'backlog',\s*'ready'|\[\s*'needs-you'|\[\s*'question',\s*'mention-user'|\[\s*'bug',\s*'ux'/
  const hits = walk(here).filter((p) => copies.test(readFileSync(p, 'utf8'))).map((p) => p.slice(here.length + 1))
  assert.deepEqual(hits, [])
})

test('categoryOf: the Settings > Notifications sections (WP-271)', () => {
  const cat = { 'needs-you': ['question', 'mention-user', 'memory-proposal', 'pr-held', 'routing-escalation', 'ask', 'needs-you'], agents: ['agent-done', 'agent-stalled', 'ci-failed', 'room-suggestion', 'memory'], system: ['server', 'watchdog', 'usage', 'jev-auth'] }
  for (const [k, kinds] of Object.entries(cat)) for (const kind of kinds) assert.equal(c.categoryOf(kind), k, kind)
  for (const kind of c.KINDS) assert.ok(['needs-you', 'agents', 'system'].includes(c.categoryOf(kind)), kind)
})
