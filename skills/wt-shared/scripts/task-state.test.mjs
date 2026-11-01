// Run: node --test skills/wt-shared/scripts/task-state.test.mjs — task-state.sh on the fake hc (WP-378): the planner's task is a label.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installFakeHc } from './fake-hc.mjs'

const script = join(import.meta.dirname, 'task-state.sh')
const home = mkdtempSync(join(tmpdir(), 'task-state-home-'))
const row = (labels) => ({ stdout: JSON.stringify({ address: 'x', state: 'live', labels }) })
const go = (fake, args, id = 't3') => execFileSync('sh', [script, ...args], { encoding: 'utf8', env: { ...fake.env, HOME: home, HERDR_DASH_URL: 'http://127.0.0.1:9', ...(id ? { HC_TERMINAL_ID: id } : {}) } })
const labelCalls = (fake) => fake.calls().filter((c) => c.args[0] === 'label').map((c) => c.args.join(' '))

test('own / state set task and task_state as one hc label call (values cut to 80); outside an hc terminal nothing is called', () => {
  const fake = installFakeHc({ cases: { label: row({}) } })
  go(fake, ['own', `WP-1 ${'x'.repeat(100)}`])
  const [l] = labelCalls(fake)
  assert.match(l, /^label --json t3 task=WP-1 x{75} task_state=planning$/)
  go(fake, ['state', 'handed to demo-worker-01'])
  assert.equal(labelCalls(fake)[1], 'label --json t3 task_state=handed to demo-worker-01')
  const n = fake.calls().length
  go(fake, ['own', 'WP-2 y'], null)
  assert.equal(fake.calls().length, n) // no HC_TERMINAL_ID: silent, exit 0, no hc call
  assert.ok(!fake.calls().some((c) => /herdr/.test(c.args.join(' ')))) // legacy-herdr
  fake.cleanup()
})

test('planner: relabels the handing-over planner only while its task is this work; --clear removes the labels with `k=`', () => {
  // get #1 = this worker (handoff_from_pane → t8, task WP-1 ...), get #2 = the planner t8
  const mine = row({ handoff_from_pane: 't8', task: 'WP-1 build it' })
  let fake = installFakeHc({ cases: { get: [mine, row({ role: 'planner', task: 'WP-1 plan it' })], label: row({}) } })
  go(fake, ['planner', 'building'])
  // a ticket id needs a known key (the board is down in a test) → the same-label rule applies: tasks differ → untouched
  assert.deepEqual(labelCalls(fake), [])
  fake.cleanup()
  fake = installFakeHc({ cases: { get: [mine, row({ role: 'planner', task: 'WP-1 build it' })], label: row({}) } })
  go(fake, ['planner', 'building'])
  assert.deepEqual(labelCalls(fake), ['label --json t8 task_state=building'])
  fake.cleanup()
  fake = installFakeHc({ cases: { get: [mine, row({ role: 'planner', task: 'WP-1 build it' })], label: row({}) } })
  go(fake, ['planner', '--clear'])
  assert.deepEqual(labelCalls(fake), ['label --json t8 task= task_state='])
  fake.cleanup()
  // an orchestrator's handoff is not a planner's to relabel
  fake = installFakeHc({ cases: { get: [mine, row({ role: 'orchestrator', task: 'WP-1 build it' })], label: row({}) } })
  go(fake, ['planner', '--clear'])
  assert.deepEqual(labelCalls(fake), [])
  fake.cleanup()
})
