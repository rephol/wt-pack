import { test, expect } from 'claude-code/testing'
import { parsePick } from './routing'

const out = (exitCode: number, stdout = '') => ({ exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
const pick = (over: object) => JSON.stringify({ tier: 'opus', apply: 'opus', effort: 'high', applyEffort: 'high', mode: 'live', source: 'jev', ref: 'r1#0', ...over })
const live = pick({})
const shadow = pick({ apply: null, applyEffort: null, mode: 'shadow', ref: 'r2#0' })
const failopen = pick({ apply: 'sonnet', applyEffort: 'low', tier: 'sonnet', source: 'jev-failopen' })

test('parsePick tolerates junk', () => {
  expect(parsePick('')).toBeNull()
  expect(parsePick('not json')).toBeNull()
  expect(parsePick(shadow)).toEqual({ apply: null, applyEffort: null, ref: 'r2#0', source: 'jev' })
})

// The engine beneath the plugin: process.run answers from `scripts`, turn.step records what reached the bottom.
type Script = { pick?: string | null; modelId?: string }
function rig(on: any, { pick: p = live, modelId = 'claude-opus-5-5\n' }: Script = {}) {
  const ran: string[][] = []
  const sent: { model: string; effort?: unknown }[] = []
  on('process.run', (_$: unknown, e: { argv: string[] }) => {
    ran.push(e.argv.slice(2))
    const sub = e.argv[2]
    return { value: sub === 'pick' ? (p === null ? out(1) : out(0, p)) : sub === 'model-id' ? (modelId ? out(0, modelId) : out(1)) : out(0) }
  })
  on('prompt.submit', (_$: unknown, e: { text: string }) => ({ text: e.text }))
  on('turn.complete', () => ({ text: '' }))
  on('turn.step', async function* (_$: unknown, e: { turnId: string; index: number; model: string; effort?: unknown }) {
    sent.push({ model: e.model, effort: e.effort })
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: null, usage: null }
  })
  return { ran, sent, picks: () => ran.filter(a => a[0] === 'pick').length, outcomes: () => ran.filter(a => a[0] === 'outcome') }
}
const say = ($: any, text: string) => $.prompt.submit({ text, asUser: true })
const step = async ($: any, turnId: string, index: number, over: object = {}) => {
  const s = $.turn.step({ turnId, index, model: 'claude-sonnet-5-5', effort: 'medium', messageCount: 1, ...over })
  for await (const _ of s) { /* drain */ }
}
const complete = ($: any, turnId: string, reason: string) => $.turn.complete({ turnId, reason, answer: 'x', durationMs: 1, isAborted: reason === 'aborted' })

test('live: the first step is routed, later steps reuse the pick, the pick is asked once', async ($, on) => {
  const r = rig(on)
  await say($, 'redesign the auth flow')
  await step($, 't1', 0)
  await step($, 't1', 1)
  expect(r.sent.map(s => s.model)).toEqual(['claude-opus-5-5', 'claude-opus-5-5'])
  expect(r.sent[0].effort).toBe('high')
  expect(r.picks()).toBe(1)
  expect(r.ran[0]).toEqual(['pick', '--skill', 'turn-step', '--session', '--json'])
})

test('a [1m] session keeps its variant suffix', async ($, on) => {
  const r = rig(on)
  await say($, 'redesign the auth flow')
  await step($, 't1b', 0, { model: 'claude-sonnet-5-5[1m]' })
  expect(r.sent[0].model).toBe('claude-opus-5-5[1m]')
})

test('shadow: the pick is asked and logged by the script, the request goes through untouched', async ($, on) => {
  const r = rig(on, { pick: shadow })
  await say($, 'redesign the auth flow')
  await step($, 't2', 0)
  expect(r.picks()).toBe(1)
  expect(r.sent).toEqual([{ model: 'claude-sonnet-5-5', effort: 'medium' }])
})

const untouched = (name: string, script: Script) => test(name, async ($, on) => {
  const r = rig(on, script)
  await say($, 'redesign the auth flow')
  await step($, 't3', 0)
  expect(r.sent).toEqual([{ model: 'claude-sonnet-5-5', effort: 'medium' }])
})
untouched('a failed pick never changes the request', { pick: null })
untouched('Jev fail-open (sonnet) never downgrades the request', { pick: failopen })
untouched('a missing pinned model id never changes the request', { modelId: '' })

test('only a person\'s prompt is a task: a slash command is not, and a turn without a prompt is not routed on a stale one', async ($, on) => {
  const r = rig(on)
  await say($, '/model opus')
  await step($, 't4', 0)
  expect(r.picks()).toBe(0)
  await say($, 'redesign the auth flow')
  await step($, 't5', 0)
  await complete($, 't5', 'answer')
  await step($, 't6', 0) // a wake-up turn: no prompt of its own
  expect(r.picks()).toBe(1)
})

test('a model the engine switched to mid-turn (a fallback) is left alone', async ($, on) => {
  const r = rig(on)
  await say($, 'redesign the auth flow')
  await step($, 't7', 0)
  await step($, 't7', 1, { model: 'claude-haiku-4-5-20251001' })
  expect(r.sent.map(s => s.model)).toEqual(['claude-opus-5-5', 'claude-haiku-4-5-20251001'])
})

test('a subagent step is never routed', async ($, on) => {
  const r = rig(on)
  await say($, 'x')
  await step($, 't8', 0, { agentId: 'a1' })
  expect(r.ran).toEqual([])
  expect(r.sent[0].model).toBe('claude-sonnet-5-5')
})

test('outcomes: ok on an answer, returned on a refusal, none on an interrupt or an error; once per turn', async ($, on) => {
  const r = rig(on)
  for (const [i, reason] of ['aborted', 'error', 'refusal', 'answer'].entries()) {
    await say($, 'redesign the auth flow')
    await step($, `t9-${i}`, 0)
    await complete($, `t9-${i}`, reason)
    await complete($, `t9-${i}`, reason) // a repeat records nothing more
  }
  expect(r.outcomes()).toEqual([['outcome', 'r1#0', 'returned', 'turn refusal'], ['outcome', 'r1#0', 'ok', 'turn answer']])
})

test('shadow picks record no outcome', async ($, on) => {
  const r = rig(on, { pick: shadow })
  await say($, 'redesign the auth flow')
  await step($, 't10', 0)
  await complete($, 't10', 'answer')
  expect(r.outcomes()).toEqual([])
})
