import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs'
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
  assert.deepEqual(member('linux2'), { persona: 'linux2', count: 1 })
  assert.match(flowchart({ members: [], stages: [{ stage: 'build', persona: 'a"]\nclick x' }] }), /build\\naclickx/)
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

test('a symlinked team file pointing outside the settings root is ignored; the members CLI refuses an invalid team', () => {
  const r = repo()
  const outside = join(mkdtempSync(join(tmpdir(), 'teams-out-')), 'evil.md')
  writeFileSync(outside, '---\nmembers: [worker]\n---\n')
  symlinkSync(outside, join(r, '.wt-pack', 'teams', 'evil.md'))
  assert.deepEqual(list(r), [])
  team(r, 'ok', '---\nmembers: [worker x2]\n---\n')
  team(r, 'broken', '---\nmembers: [ghost]\n---\n')
  const cli = (n) => { try { return { out: execFileSync(process.execPath, [new URL('./teams.mjs', import.meta.url).pathname, 'members', n, '--cwd', r], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), code: 0 } } catch (e) { return { out: e.stderr, code: e.status } } }
  assert.deepEqual(cli('ok'), { out: 'worker\nworker\n', code: 0 })
  assert.equal(cli('broken').code, 1)
  assert.equal(cli('missing').code, 1)
})

test('WP-247: seats prints the roster count of a persona, 0 for a non-member or an unknown team', () => {
  const r = repo()
  team(r, 'pod', '---\nmembers: [planner, worker x2]\n---\n')
  const seats = (...a) => execFileSync(process.execPath, [new URL('./teams.mjs', import.meta.url).pathname, 'seats', ...a, '--cwd', r], { encoding: 'utf8' }).trim()
  assert.equal(seats('pod', 'worker'), '2'); assert.equal(seats('pod', 'planner'), '1')
  assert.equal(seats('pod', 'reviewer'), '0'); assert.equal(seats('nope', 'worker'), '0')
})

test('WP-241: teamText round-trips through the parser and refuses frontmatter injection', async () => {
  const { teamText, member } = await import('./teams.mjs'); const { parse } = await import('./roles.mjs')
  const t = teamText({ description: 'd', members: [{ persona: 'worker', count: 2 }, { persona: 'reviewer', count: 1 }], stages: [{ stage: 'build', persona: 'worker' }] }, 'notes\n')
  const { meta, body } = parse(t)
  assert.deepEqual(meta.members.map(member), [{ persona: 'worker', count: 2 }, { persona: 'reviewer', count: 1 }]); assert.equal(body.trim(), 'notes')
  for (const bad of [{ description: 'a\nb' }, { members: [{ persona: 'x\ny', count: 1 }] }, { members: [{ persona: 'w', count: 9 }] }, { stages: [{ stage: 'nope', persona: 'w' }] }])
    assert.throws(() => teamText(bad), (e) => e.status === 400)
})
