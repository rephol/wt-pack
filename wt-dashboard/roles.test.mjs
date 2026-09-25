import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_ROLES, glob, resolveRole, validateRoles, inferTags, tokenDiff, clean, adoptHandoff } from './roles.mjs'

test('glob', () => {
  assert.equal(glob('*-planners', 'umkmall-planners'), true)
  assert.equal(glob('*planner*', 'umkmall-planner-03'), true)
  assert.equal(glob('*-workers', 'umkmall-planners'), false)
  assert.equal(glob('a.b*', 'axb'), false) // dots are literal
  assert.equal(glob('', 'x'), false)
})

test('resolveRole: token > workspace > name > other', () => {
  const r = DEFAULT_ROLES
  assert.deepEqual(resolveRole(r, { token: 'worker', workspace: 'umkmall-planners', name: 'umkmall-planner-01' }), { id: 'worker', by: 'token' })
  assert.deepEqual(resolveRole(r, { token: 'other', workspace: 'umkmall-planners', name: 'x' }), { id: 'other', by: 'token' })
  assert.deepEqual(resolveRole(r, { token: 'gone', workspace: 'umkmall-planners', name: 'umkmall-worker-01' }), { id: 'planner', by: 'workspace' })
  assert.deepEqual(resolveRole(r, { workspace: 'self', name: 'umkmall-orchestrator' }), { id: 'orchestrator', by: 'name' })
  assert.deepEqual(resolveRole(r, { workspace: 'self', name: 'claude' }), { id: 'other', by: 'none' })
})

test('validateRoles: ids, duplicates, defaults for spawn', () => {
  assert.throws(() => validateRoles([]), /1–20/)
  assert.throws(() => validateRoles([{ id: 'Bad Id' }]), /bad role id/)
  assert.throws(() => validateRoles([{ id: 'other' }]), /bad role id/)
  assert.throws(() => validateRoles([{ id: 'a' }, { id: 'a' }]), /duplicate/)
  const [r] = validateRoles([{ id: 'reviewer', color: 'nope', spawn: { start: 'x' } }])
  assert.deepEqual(r, { id: 'reviewer', name: 'reviewer', color: 'gray', letter: 'R', match: { workspace: '', name: '' }, spawn: { start: 'main', workspace: '<repo>-reviewers', prompt: '', projects: [] } })
  assert.deepEqual(validateRoles(DEFAULT_ROLES), DEFAULT_ROLES) // defaults round-trip
})

test('tags: inference, cleaning, and the token diff sends only what changed', () => {
  const t = inferTags({ name: 'umkmall-worker-02', role: 'worker', project: 'umkmall', ticket: 'UMK-1', now: new Date('2026-09-25T10:00:00Z') })
  assert.deepEqual(t, { role: 'worker', project: 'umkmall', ticket: 'UMK-1', spawned_by: 'wt-agents', created: '2026-09-25' })
  assert.equal(inferTags({ name: 'umkmall-orchestrator' }).spawned_by, 'manual')
  assert.equal(clean({ ticket: 'x'.repeat(200), junk: 'y' }).ticket.length, 80)
  assert.deepEqual(clean({ junk: 'y', role: ' ' }), {})
  assert.deepEqual(tokenDiff({ role: 'worker', project: 'a', b: 'foreign' }, { role: 'planner', project: 'a' }), { set: [['role', 'planner']], clear: [] })
  assert.deepEqual(tokenDiff({ role: 'worker', ticket: 'UMK-1' }, { role: 'worker' }), { set: [], clear: ['ticket'] })
  assert.deepEqual(tokenDiff({}, { role: 'worker' }), { set: [['role', 'worker']], clear: [] }) // after a herdr restart: re-applied
})

test('tags: a newer handoff adopts its ticket into the mirror; live keys are never mirrored or cleared', () => {
  const mirror = { role: 'worker', ticket: 'UMK-1' }
  const pane = { role: 'worker', ticket: 'UMK-2', task: 'UMK-2 x', handoff_at: '100' }
  const next = adoptHandoff(mirror, pane)
  assert.deepEqual(next, { role: 'worker', ticket: 'UMK-2', handoff_at: '100' })
  assert.equal(adoptHandoff(next, pane), null) // already adopted: a later PATCH of ticket sticks
  assert.equal(adoptHandoff(mirror, { ticket: 'UMK-9' }), null) // no handoff: the mirror wins as before
  assert.deepEqual(tokenDiff(pane, next), { set: [], clear: [] }) // task is not the mirror's to clear
})
