import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { list, get, expand, check, flowchart, member, TEMPLATES, templateText } from './teams.mjs'

const repo = () => {
  const r = mkdtempSync(join(tmpdir(), 'teams-'))
  execFileSync('git', ['init', '-q', r])
  mkdirSync(join(r, '.wt-pack', 'teams'), { recursive: true }); mkdirSync(join(r, '.wt-pack', 'roles'), { recursive: true })
  writeFileSync(join(r, '.wt-pack', 'roles', 'frontend-worker.md'), '---\nbase: worker\n---\nUI only.')
  return r
}
const team = (r, name, text) => writeFileSync(join(r, '.wt-pack', 'teams', `${name}.md`), text)

test('member parses "persona xN"; list/get/expand read the file', () => {
  assert.deepEqual(member('frontend-worker x2'), { persona: 'frontend-worker', count: 2 })
  assert.deepEqual(member('planner'), { persona: 'planner', count: 1 })
  const r = repo()
  team(r, 'web', '---\ndescription: Web pod\nmembers: [planner, frontend-worker x2, reviewer]\nstages: [plan=planner, build=frontend-worker, review=reviewer]\n---\nnotes')
  const t = get(r, 'web')
  assert.equal(t.description, 'Web pod')
  assert.deepEqual(expand(t), ['planner', 'frontend-worker', 'frontend-worker', 'reviewer'])
  assert.deepEqual(list(r).map((x) => x.name), ['web'])
  assert.equal(get(r, '../x'), null)
  assert.deepEqual(check(r), [])
})
test('check names an unknown persona, bad count, duplicate member, stage → non-member and unknown stage', () => {
  const r = repo()
  team(r, 'bad', '---\nmembers: [ghost, worker x9, worker]\nstages: [build=reviewer, deploy=worker, plan]\ncolor: red\n---\n')
  const msgs = check(r).map((x) => x.msg).join('\n')
  for (const re of [/`ghost` has no role file/, /count must be 1-8/, /listed twice/, /`build` → `reviewer` is not a member/, /unknown stage `deploy`/, /`plan` needs/, /unknown key `color`/]) assert.match(msgs, re)
  team(r, 'empty', '---\ndescription: x\n---\n')
  assert.ok(check(r).some((x) => x.name === 'empty' && /no members/.test(x.msg)))
})
test('every template is a valid team', () => {
  const r = repo()
  for (const [n, t] of Object.entries(TEMPLATES)) team(r, n, templateText(n, t))
  assert.deepEqual(check(r), [])
})
test('flowchart: stages in pipeline order with counts, gates, review/qa loop back to build', () => {
  const r = repo()
  team(r, 'full', templateText('full', TEMPLATES.full))
  const f = flowchart(get(r, 'full'))
  assert.match(f, /^flowchart LR/)
  assert.match(f, /build\["build\\nworker ×2"\]/)
  assert.match(f, /plan_gate --> build/)
  assert.match(f, /qa_gate --> done/)
  assert.match(f, /review_gate -\. changes requested \.-> build/)
  assert.match(f, /qa_gate -\. changes requested \.-> build/)
  const hi = flowchart(get(r, 'full'), ['build', 'qa', 'deploy'])
  assert.match(hi, /classDef active/)
  assert.match(hi, /class build,qa active/)
  assert.doesNotMatch(flowchart(get(r, 'full'), []), /classDef/)
  assert.match(flowchart({ members: [], stages: [] }), /no stages mapped/)
})
