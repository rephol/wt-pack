import { test, expect, mock } from 'claude-code/testing'
import { parsePick } from './routing'

const out = (exitCode: number, stdout = '') => ({ exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
const live = JSON.stringify({ tier: 'opus', apply: 'opus', effort: 'high', applyEffort: 'high', mode: 'live', source: 'jev', ref: 'r1#0' })
const shadow = JSON.stringify({ tier: 'opus', apply: null, effort: 'high', applyEffort: null, mode: 'shadow', source: 'jev', ref: 'r2#0' })

test('parsePick tolerates junk', () => {
  expect(parsePick('')).toBeNull()
  expect(parsePick('not json')).toBeNull()
  expect(parsePick(shadow)).toEqual({ apply: null, applyEffort: null, ref: 'r2#0' })
})

// The engine beneath: process.run answers from a script, and the bottom turn.step records what it was sent.
function rig(on: any, pick: string) {
  const ran: string[][] = []
  const sent: { model: string; effort?: unknown }[] = []
  on('process.run', (_$: unknown, e: { argv: string[] }) => {
    ran.push(e.argv.slice(2))
    return { value: e.argv[2] === 'pick' ? out(0, pick) : e.argv[2] === 'model-id' ? out(0, 'claude-opus-5-5\n') : out(0) }
  })
  on('turn.step', async function* (_$: unknown, e: { turnId: string; index: number; model: string; effort?: unknown }) {
    sent.push({ model: e.model, effort: e.effort })
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: null, usage: null }
  })
  return { ran, sent }
}
const step = async ($: any, turnId: string, index: number, over: object = {}) => {
  const s = $.turn.step({ turnId, index, model: 'claude-sonnet-5-5', effort: 'medium', messageCount: 1, ...over })
  for await (const _ of s) { /* drain */ }
}

test('live: the first step is routed and the turn keeps the pick; the pick is asked once', async ($, on) => {
  const { ran, sent } = rig(on, live)
  await $.prompt.submit?.({ text: 'redesign the auth flow' } as never).catch?.(() => {})
  await step($, 't1', 0)
  await step($, 't1', 1)
  expect(sent.map(s => s.model)).toEqual(['claude-opus-5-5', 'claude-opus-5-5'])
  expect(sent[0].effort).toBe('high')
  expect(ran.filter(a => a[0] === 'pick')).toHaveLength(1)
  expect(ran[0]).toEqual(['pick', '--skill', 'turn-step', '--session', '--json'])
})

test('shadow: the request goes through untouched', async ($, on) => {
  const { sent } = rig(on, shadow)
  await $.prompt.submit?.({ text: 'redesign the auth flow' } as never).catch?.(() => {})
  await step($, 't2', 0)
  expect(sent).toEqual([{ model: 'claude-sonnet-5-5', effort: 'medium' }])
})

test('a subagent step is never routed', async ($, on) => {
  const { ran, sent } = rig(on, live)
  await $.prompt.submit?.({ text: 'x' } as never).catch?.(() => {})
  await step($, 't3', 0, { agentId: 'a1' })
  expect(ran).toEqual([])
  expect(sent[0].model).toBe('claude-sonnet-5-5')
})

const complete = ($: any, turnId: string, reason: string) =>
  $.turn.complete({ turnId, reason, answer: 'x', durationMs: 1, isAborted: reason === 'aborted' })

test('outcomes: an applied pick is ok on an answer, returned on an error, silent on an interrupt; shadow records none', async ($, on) => {
  on('turn.complete', (_$: unknown, e: unknown) => ({ text: '' }))
  const { ran } = rig(on, live)
  await $.prompt.submit?.({ text: 'redesign the auth flow' } as never).catch?.(() => {})
  await step($, 't4', 0)
  await complete($, 't4', 'aborted')
  expect(ran.some(a => a[0] === 'outcome')).toBe(false)
  await complete($, 't4', 'answer')
  expect(ran.find(a => a[0] === 'outcome')).toEqual(['outcome', 'r1#0', 'ok', 'turn answer'])
})

test('outcomes: an errored turn is returned; a shadow pick has no outcome', async ($, on) => {
  on('turn.complete', () => ({ text: '' }))
  const a = rig(on, live)
  await $.prompt.submit?.({ text: 'redesign the auth flow' } as never).catch?.(() => {})
  await step($, 't5', 0)
  await complete($, 't5', 'error')
  expect(a.ran.find(r => r[0] === 'outcome')).toEqual(['outcome', 'r1#0', 'returned', 'turn error'])
})
