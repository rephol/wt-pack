// Run: node --test skills/wt-shared/scripts/routing-eval.test.mjs — WP-128 U5 report/tuner on a temp HOME.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmp = mkdtempSync(join(tmpdir(), 'wt-reval-'))
process.env.HOME = tmp
const { tune, report, seedFixtures, load, writeUser, STEP, estimateSavings } = await import('./routing-eval.mjs')
const { DEFAULTS, paths } = await import('./model-route.mjs')

const d = (over, outcomes) => ({ skill: 'wt-work', tier: 'haiku', choice: 'haiku', source: 'jev', mode: 'live', outcomes, state: { task: `t${Math.random()}` }, ...over })
const many = (n, outcomes, over = {}) => Array.from({ length: n }, () => d(over, outcomes))

test('haiku tightens at most one step on failures, loosens on a clean record', () => {
  const bad = tune([...many(8, ['send-back']), ...many(4, ['ok'])], DEFAULTS)
  assert.equal(bad.thresholds.haiku, +(DEFAULTS.thresholds.haiku + STEP).toFixed(2))
  const clean = tune(many(12, ['ok']), DEFAULTS)
  assert.equal(clean.thresholds.haiku, +(DEFAULTS.thresholds.haiku - STEP).toFixed(2))
  assert.equal(tune(many(5, ['send-back']), DEFAULTS).changes.length, 0) // below MIN_N
})

test('pinned skills are ignored; floors never change', () => {
  const cfg = { ...DEFAULTS, skills: { 'wt-work': { pin: 'haiku' } } }
  assert.equal(tune(many(20, ['send-back']), cfg).changes.length, 0)
  const r = tune(many(20, ['escalated'], { tier: 'sonnet', choice: 'sonnet' }), DEFAULTS)
  assert.equal(r.thresholds.opus, +(DEFAULTS.thresholds.opus - STEP).toFixed(2))
  assert.deepEqual(DEFAULTS.floors, { correctness: 'sonnet', security: 'sonnet', data: 'sonnet', migration: 'sonnet' })
  writeUser(r.thresholds)
  const u = JSON.parse(readFileSync(paths().user, 'utf8'))
  assert.equal(u.thresholds.opus, r.thresholds.opus); assert.equal(u.floors, undefined)
})

test('fixtures: escalations and send-backs seed one tier up, never duplicated', () => {
  const f = join(tmp, 'routing.json'); writeFileSync(f, '[]')
  const ds = [d({ state: { task: 'a' } }, ['send-back']), d({ state: { task: 'a' } }, ['escalated']), d({ state: { task: 'b' } }, ['ok'])]
  assert.equal(seedFixtures(ds, f), 1)
  assert.equal(seedFixtures(ds, f), 0)
  assert.deepEqual(JSON.parse(readFileSync(f, 'utf8')), [{ state: { task: 'a' }, expect: 'sonnet' }])
})

test('load joins outcomes by run; report groups skill×tier', () => {
  mkdirSync(join(tmp, '.claude'), { recursive: true }); mkdirSync(join(tmp, '.local/share/wt-pack'), { recursive: true })
  const now = new Date().toISOString()
  writeFileSync(paths().log, [
    { run: 'r1', cmd: 'routing', ts: now, item: { skill: 'wt-work', tier: 'haiku', mode: 'live', source: 'jev', choice: 'haiku' } },
    { run: 'r2', cmd: 'routing', ts: now, item: { skill: 'wt-work', tier: 'haiku', mode: 'shadow', source: 'local' } },
    { run: 'x', cmd: 'lenses', ts: now, item: {} },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n')
  writeFileSync(paths().outcomes, JSON.stringify({ run: 'r1', i: 0, outcome: 'send-back' }) + '\n')
  const ds = load()
  assert.equal(ds.length, 2)
  assert.deepEqual(report(ds), [{ skill: 'wt-work', tier: 'haiku', effort: null, picks: 2, applied: 1, sendBack: 1, returned: 0, escalated: 0, ok: 0, shadowOk: 0, shadowReturned: 0 }])
})

test('estimateSavings: applied non-default picks compare to the sonnet average; shadow and sonnet picks do not count', () => {
  const avg = { haiku: { tokens: 1000, cost: 0.01 }, sonnet: { tokens: 4000, cost: 0.08 }, opus: { tokens: 4000, cost: 0.4 } }
  const ds = [
    d({ tier: 'haiku', mode: 'live' }, []),
    d({ tier: 'haiku', mode: 'shadow' }, []), // not applied: no saving counted
    d({ tier: 'sonnet', mode: 'live' }, []), // default tier: no saving
    d({ tier: 'opus', mode: 'live' }, []), // costs more than sonnet: negative saving
  ]
  const s = estimateSavings(ds, avg)
  assert.equal(s.n, 2)
  assert.equal(s.tokens, (4000 - 1000) + (4000 - 4000))
  assert.equal(+s.cost.toFixed(4), +((0.08 - 0.01) + (0.08 - 0.4)).toFixed(4))
  assert.equal(s.priced, true)
})

test('estimateSavings: no sonnet baseline or an unpriced applied tier yields no/partial numbers', () => {
  assert.deepEqual(estimateSavings([d({ tier: 'haiku', mode: 'live' }, [])], {}), { tokens: 0, cost: 0, priced: false, n: 0 })
  const partial = estimateSavings([d({ tier: 'haiku', mode: 'live' }, [])], { sonnet: { tokens: 100, cost: 1 } })
  assert.equal(partial.priced, false); assert.equal(partial.n, 0)
})

test('WP-215: shadow outcomes are reported apart and never tune; ad-hoc and floor-overruled rows are skipped', async () => {
  const { outcome } = await import('./model-route.mjs')
  const p = paths(); mkdirSync(join(tmp, '.claude'), { recursive: true })
  const ts = new Date().toISOString()
  const row = (run, item) => JSON.stringify({ run, i: 0, ts, cmd: 'routing', item: { mode: 'shadow', tier: 'haiku', choice: 'haiku', source: 'jev', ...item }, state: {} })
  writeFileSync(p.log, [
    row('s1', { skill: 'turn-step' }),
    row('n1', { skill: '', role: '' }), // ad-hoc pick: no skill, no role
    row('f1', { skill: 'wt-handoff', role: 'planner', tier: 'opus', choice: 'sonnet', source: 'jev+floor' }), // floor overruled
    row('f2', { skill: 'wt-handoff', role: 'planner', tier: 'opus', choice: 'opus', source: 'jev+floor' }), // floor agreed: kept
  ].join('\n') + '\n')
  outcome('s1#0', 'shadow-ok', 'turn answer on claude-opus-5-5')
  assert.throws(() => outcome('s1#0', 'bogus'))
  const ds = load({ sinceDays: 1 })
  assert.deepEqual(ds.map((x) => x.run), ['s1', 'f2'])
  const s1 = ds.find((x) => x.run === 's1')
  assert.deepEqual(s1.outcomes, []); assert.deepEqual(s1.shadow, ['ok'])
  const r = report(ds).find((x) => x.skill === 'turn-step')
  assert.equal(r.shadowOk, 1); assert.equal(r.ok, 0)
  assert.equal(tune(Array.from({ length: 12 }, () => ({ ...s1, source: 'jev', mode: 'live' })), DEFAULTS).changes.length, 0) // no real outcomes
})
