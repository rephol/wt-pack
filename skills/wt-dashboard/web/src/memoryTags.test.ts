import test from 'node:test'
import assert from 'node:assert/strict'
import { entryLine, tagsLabel, TAG_HINT } from './memoryTags.ts'

const base = { scope: 'project', name: 'umkmall', by: 'worker-1', at: '2026-10-20' }
test('entryLine: untagged keeps the old line, tagged adds the tags after where', () => {
  assert.equal(entryLine(base), 'project umkmall · worker-1 · 2026-10-20')
  assert.equal(entryLine({ ...base, tags: { role: ['orchestrator'] } }), 'project umkmall · for orchestrator · worker-1 · 2026-10-20')
  assert.equal(entryLine({ scope: 'global', name: null, by: 'a', at: 't', tags: { role: ['x', 'y'], project: ['p'] } }), 'global · for x, y · in project p · a · t')
  assert.equal(entryLine({ ...base, pending: true, tags: { project: ['p'] } }), 'global · in project p · worker-1 · 2026-10-20')
})
test('tagsLabel: empty for no tags or empty lists; hint names both tag kinds', () => {
  assert.equal(tagsLabel(undefined), ''); assert.equal(tagsLabel({}), ''); assert.equal(tagsLabel({ role: [] }), '')
  assert.match(TAG_HINT, /\[role: id\].*\[project: name\]/)
})
