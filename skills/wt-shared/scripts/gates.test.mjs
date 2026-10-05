import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { evaluate, crossed, gatesFor, projectGates } from './gates.mjs'
import { get, check, flowchart, TEMPLATES, templateText } from './teams.mjs'

const card = (...texts) => ({ id: 'WP-9', history: texts.map((text) => ({ kind: 'comment', author: 'a', text })) })
const why = (t, stage, facts) => evaluate(t, [stage], facts)[0]

test('plan: needs the plan file fact', () => {
  assert.equal(why(card(), 'plan', {}).ok, false)
  assert.match(why(card(), 'plan', {}).why, /docs\/plans\/wp-9-\*\.md/)
  assert.equal(why(card(), 'plan', { plan: 'docs/plans/wp-9-x.md' }).ok, true)
})
test('build: green tests AND a tip (branch fact or a tip comment); the newest tests comment decides', () => {
  assert.match(why(card(), 'build', { tip: 'abc1234' }).why, /no "tests: green"/)
  assert.match(why(card('tests: green 431/431'), 'build', {}).why, /no branch/)
  assert.equal(why(card('tests: green'), 'build', { tip: 'abc1234' }).ok, true)
  assert.equal(why(card('tests: green', 'branch wp-9-x\ntip: 055e165'), 'build', {}).ok, true) // outlives the merged branch
  assert.match(why(card('tests: green', 'tests: red 2 failing'), 'build', { tip: 'abc1234' }).why, /"red", not green/)
  assert.equal(why(card('tests: red', 'tests: pass'), 'build', { tip: 'abc1234' }).ok, true)
  assert.match(why(card('tests: green', 'tip: xyz'), 'build', {}).why, /no branch/) // not a sha
})
test('review: the newest verdict must be Approve or Approve with fixes', () => {
  assert.equal(why(card(), 'review').ok, false)
  assert.equal(why(card('verdict: Approve with fixes'), 'review').ok, true)
  assert.equal(why(card('verdict: Send back', 'verdict: Approve'), 'review').ok, true)
  assert.match(why(card('verdict: Approve', 'verdict: Send back'), 'review').why, /Send back/)
  assert.equal(why(card('I approve'), 'review').ok, false)
})
test('qa: a live-check note', () => {
  assert.equal(why(card(), 'qa').ok, false)
  assert.equal(why(card('live-check:'), 'qa').ok, false)
  assert.equal(why(card('live-check: opened #teams at 412px, SVG drew'), 'qa').ok, true)
})
test('crossed: only forward moves of a card already working; blocked, backward and Ready starts are free', () => {
  const all = ['plan', 'build', 'review', 'qa']
  assert.deepEqual(crossed(all, 'planning', 'building'), ['plan'])
  assert.deepEqual(crossed(all, 'building', 'review'), ['build'])
  assert.deepEqual(crossed(all, 'review', 'done'), ['review', 'qa'])
  assert.deepEqual(crossed(all, 'planning', 'review'), ['plan', 'build'])
  assert.deepEqual(crossed(all, 'building', 'done'), ['build', 'review', 'qa'])
  assert.deepEqual(crossed(['plan', 'build'], 'building', 'done'), ['build'])
  for (const [f, t] of [['ready', 'building'], ['backlog', 'review'], ['building', 'blocked'], ['review', 'building'], ['building', 'building'], ['done', 'review']]) assert.deepEqual(crossed(all, f, t), [], `${f}→${t}`)
})
test('gatesFor: a team list wins (even empty), else the project default', () => {
  assert.deepEqual(gatesFor({ gates: ['qa'] }, ['plan']), ['qa'])
  assert.deepEqual(gatesFor({ gates: [] }, ['plan']), [])
  assert.deepEqual(gatesFor({ gates: null }, ['plan']), ['plan'])
  assert.deepEqual(gatesFor(null, ['plan']), ['plan'])
})
test('projectGates reads <settings>/gates.md, ignoring unknown stages; absent = none', () => {
  const r = mkdtempSync(join(tmpdir(), 'gates-'))
  execFileSync('git', ['init', '-q', r])
  assert.deepEqual(projectGates(r), [])
  mkdirSync(join(r, '.wt-pack'), { recursive: true })
  writeFileSync(join(r, '.wt-pack', 'gates.md'), '---\ngates: [plan, deploy, build]\n---\n')
  assert.deepEqual(projectGates(r), ['plan', 'build'])
})
test('team files: gates parse, templates carry them, an unknown gate is an error, the flowchart names the check', () => {
  const r = mkdtempSync(join(tmpdir(), 'gates-team-'))
  execFileSync('git', ['init', '-q', r])
  mkdirSync(join(r, '.wt-pack', 'teams'), { recursive: true })
  for (const [n, t] of Object.entries(TEMPLATES)) writeFileSync(join(r, '.wt-pack', 'teams', `${n}.md`), templateText(n, t))
  assert.deepEqual(check(r), [])
  assert.deepEqual(get(r, 'full').gates, ['plan', 'build', 'review', 'qa'])
  assert.deepEqual(get(r, 'solo').gates, null) // no gates line: the project default applies
  assert.match(flowchart(get(r, 'full')), /review_gate\{\{"gate: verdict"\}\}/)
  assert.match(flowchart(get(r, 'solo')), /plan_gate\{\{"gate"\}\}/)
  writeFileSync(join(r, '.wt-pack', 'teams', 'bad.md'), '---\nmembers: [worker]\ngates: [deploy]\n---\n')
  assert.match(check(r).map((x) => x.msg).join(), /unknown gate `deploy`/)
})
