import { test, expect } from 'claude-code/testing'
import { chain, type Ctx } from './compose'

const ctx = {} as Ctx
const trace: string[] = []
const h = (name: string, rewrite?: string) => (_c: Ctx, e: { v: string }, next: (e: unknown) => unknown) => { trace.push(name); return next(rewrite ? { v: rewrite } : e) }

test('chain runs handlers first-to-last, threads a rewritten event, then the engine', async () => {
  trace.length = 0
  const r = await chain([h('a'), h('b', 'B'), h('c')])(ctx, { v: 'A' }, e => { trace.push('engine'); return e })
  expect(trace).toEqual(['a', 'b', 'c', 'engine'])
  expect(r).toEqual({ v: 'B' })
})

test('a handler that does not call next answers alone', async () => {
  trace.length = 0
  const stop = () => 'stopped'
  expect(await chain([h('a'), stop, h('never')])(ctx, { v: 'A' }, () => 'engine')).toBe('stopped')
  expect(trace).toEqual(['a'])
})

test('no handlers: straight to the engine', async () => {
  expect(await chain([])(ctx, { v: 'A' }, e => e)).toEqual({ v: 'A' })
})
