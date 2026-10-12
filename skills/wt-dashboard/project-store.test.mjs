import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { ProjectStore } from './project-store.mjs'

test('add remembers a project; a repeat keeps the first row; a moved checkout updates the root', () => {
  const s = new ProjectStore(() => new DatabaseSync(':memory:'))
  assert.equal(s.all().size, 0)
  s.add('a', '/r/a', 1); s.add('b', '/r/b', 2); s.add('a', '/r/a', 3)
  assert.deepEqual([...s.all()], [['a', '/r/a'], ['b', '/r/b']])
  s.add('a', '/moved/a'); assert.equal(s.all().get('a'), '/moved/a')
})
