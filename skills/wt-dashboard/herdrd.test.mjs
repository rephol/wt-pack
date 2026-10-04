// Run: node --test herdrd.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { ensureHerdr } from './herdrd.mjs'

const fakeSpawn = (calls) => (cmd, args, opts) => { calls.push([cmd, ...args, opts.detached]); return { pid: 42, on() {}, unref() {} } }

test('ensureHerdr: starts a detached headless server only when none is running', async () => {
  const calls = [], logs = []
  assert.equal(await ensureHerdr({ check: async () => 'running', spawn: fakeSpawn(calls) }), 'running')
  assert.equal(await ensureHerdr({ check: async () => 'missing', spawn: fakeSpawn(calls) }), 'missing')
  assert.deepEqual(calls, []) // never a second server; no herdr installed → nothing to start
  assert.equal(await ensureHerdr({ check: async () => 'down', spawn: fakeSpawn(calls), log: (m) => logs.push(m) }), 'started')
  assert.deepEqual(calls, [['herdr', 'server', true]])
  assert.match(logs[0], /started it \(pid 42\)/)
})
