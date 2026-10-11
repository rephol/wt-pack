import { test, expect } from 'claude-code/testing'
import type { Ctx } from './compose'
import { contextHooks, warning } from './context'

const run = async (pcts: (number | undefined)[], agentId?: string) => {
  const said: string[] = []
  let i = 0
  const ctx = { contextPercent: async () => pcts[i++], notify: (t: string) => said.push(t) } as unknown as Ctx
  const h = contextHooks()['turn.complete']!
  for (let n = 0; n < pcts.length; n++) await h(ctx, { agentId }, e => e)
  return said
}

test('warns once per level, again after the context drops', async () => {
  expect(await run([50, 79, 80, 85, 90, 95, 40, 82])).toEqual([warning(80), warning(90), warning(82)])
})

test('a subagent turn, an unknown percent, and a failed read are silent', async () => {
  expect(await run([95], 'sub-1')).toEqual([])
  expect(await run([undefined, undefined])).toEqual([])
})

test('the turn is always passed on', async () => {
  const ctx = { contextPercent: async () => { throw new Error('x') }, notify: () => {} } as unknown as Ctx
  expect(await contextHooks()['turn.complete']!(ctx, { a: 1 }, e => e)).toEqual({ a: 1 })
})
