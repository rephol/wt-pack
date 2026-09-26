import test from 'node:test'
import assert from 'node:assert/strict'
import { switcherItems, type SwAgent } from './switcherData.ts'

const ag = (name: string, o: Partial<SwAgent> = {}): SwAgent => ({ key: name, name, pool: 'worker', machine: 'm', local: true, status: 'idle', asks: false, statusSince: 0, lastActivity: 0, recap: null, question: null, task: null, ...o })
const A = [ag('w-01', { status: 'working', lastActivity: 5 }), ag('w-02', { asks: true, question: 'Merge?', lastActivity: 9 }), ag('p-10', { lastActivity: 7, recap: 'fixing the parser' }), ag('p-02', { lastActivity: 1, task: 'UMK-1183' })]
const rows = (xs: ReturnType<typeof switcherItems>) => xs.map((x) => `${x.auxiliaryData!.group}:${x.label}`)

test('switcher: each agent once, in its highest section; recent capped at 5', () => {
  assert.deepEqual(rows(switcherItems(A, [], ['w-02', 'p-02', 'w-01'])), ['Needs you:w-02', 'Recent:p-02', 'Recent:w-01', 'Agents:p-10'])
})
test('switcher: subtitle is never empty', () => {
  for (const it of switcherItems(A, [], [])) assert.ok(it.auxiliaryData!.line.length > 0)
  assert.equal(switcherItems(A, [], []).find((x) => x.label === 'p-02')!.auxiliaryData!.line, 'idle · no recent summary')
})
test('switcher: fuzzy name, ticket id and recap search; all open rooms, waiting-on-you first', () => {
  assert.deepEqual(switcherItems(A, [], [], 'p10').map((x) => x.label), ['p-10'])
  assert.deepEqual(switcherItems(A, [], [], 'umk-1183').map((x) => x.label), ['p-02'])
  assert.deepEqual(switcherItems(A, [], [], 'parser').map((x) => x.label), ['p-10'])
  const rooms = [{ slug: 'ops', title: 'Ops', needsYou: [{ agent: 'w-01', text: 'ok?' }] }, { slug: 'quiet', title: 'Quiet' }, { slug: 'old', title: 'Old', archived: true }]
  assert.deepEqual(switcherItems([], [rooms[1], rooms[0], rooms[2]], []).map((x) => x.id), ['room:ops', 'room:quiet'])
  assert.deepEqual(switcherItems([], rooms, [], 'qui').map((x) => x.id), ['room:quiet'])
})
import { agentInitials } from './switcherData.ts'
test('agentInitials: role letter + number without leading zeros', () => {
  assert.equal(agentInitials('umkmall-planner-02'), 'P2')
  assert.equal(agentInitials('worker-05'), 'W5')
  assert.equal(agentInitials('umkmall-worker-10'), 'W10')
  assert.equal(agentInitials('umkmall-orchestrator'), 'O')
  assert.equal(agentInitials('code-reviewer/w5:p9'), 'CR')
  assert.equal(agentInitials('Code-reviewer agent startup command'), 'CR')
})

test('agentInitials: a configured role letter wins', () => {
  assert.equal(agentInitials('umkmall-reviewer-07', 'R'), 'R7')
  assert.equal(agentInitials('umkmall-orchestrator', 'O'), 'O')
  assert.equal(agentInitials('umkmall-planner-02', '?'), 'P2') // Other: falls back to the name
})
test('switcher: a handoff task label leads the subtitle and is searchable', () => {
  const b = [ag('w-09', { recap: 'on it', tags: { task: 'UMK-1192 Tailwind v4' } })]
  assert.equal(switcherItems(b, [], [])[0].auxiliaryData!.line, 'UMK-1192 Tailwind v4 · on it')
  assert.deepEqual(switcherItems(b, [], [], 'tailwind').map((x) => x.label), ['w-09'])
})
import { taskLabel } from './switcherData.ts'
test('taskLabel: task · task_state; the state alone is never shown', () => {
  assert.equal(taskLabel({ task: 'UMK-1 Button', task_state: 'handed to w-01' }), 'UMK-1 Button · handed to w-01')
  assert.equal(taskLabel({ task: 'UMK-1 Button' }), 'UMK-1 Button')
  assert.equal(taskLabel({ task_state: 'planning' }), undefined)
})

test('roomInProject: All shows every room; a project shows only its rooms (projectless rooms under All only)', async () => {
  const { roomInProject } = await import('./switcherData.ts')
  const rs = [{ slug: 'a', project: 'umkmall' }, { slug: 'b', project: 'wt-pack' }, { slug: 'c', project: null }, { slug: 'd' }]
  const pick = (p: string) => rs.filter((r) => roomInProject(r, p)).map((r) => r.slug)
  assert.deepEqual(pick('all'), ['a', 'b', 'c', 'd'])
  assert.deepEqual(pick('wt-pack'), ['b'])
  assert.deepEqual(pick('umkmall'), ['a'])
})
