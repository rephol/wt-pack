import { test } from 'node:test'
import assert from 'node:assert/strict'
import { storedMode } from './storedMode.ts'

test('storedMode: paused resumes, missing/exited respawn; live, remote and headless are not stored', () => {
  assert.deepEqual(storedMode({ local: true, status: 'paused' }), { state: 'paused', verb: 'Resume' })
  assert.deepEqual(storedMode({ local: true, status: 'missing' }), { state: 'missing', verb: 'Respawn' })
  assert.deepEqual(storedMode({ local: true, status: 'exited' }), { state: 'exited', verb: 'Respawn' })
  assert.equal(storedMode({ local: true, status: 'idle' }), null)
  assert.equal(storedMode({ local: false, status: 'paused' }), null)
  assert.equal(storedMode({ local: true, status: 'exited', headless: true }), null)
})
