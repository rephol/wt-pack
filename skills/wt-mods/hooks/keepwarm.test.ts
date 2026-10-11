import { test, expect } from 'claude-code/testing'
import type { Ctx } from './compose'
import { contextTokensOf, due, fresh, keepwarmHooks, stopReason, type Cfg } from './keepwarm'

const MIN = 60_000, H = 60 * MIN
const cfg: Cfg = { enabled: true, intervalMin: 50, minContext: 50_000, windowH: 3, dailyCap: 15, pingsToday: 0 }
const at = (lastReal: number, lastPing = 0) => ({ ...fresh(lastReal), lastPing })

test('due: only after the interval idle, inside the window, over the context floor, under the cap', () => {
  expect(due(at(0), cfg, 49 * MIN, 60_000)).toBe(false) // not idle long enough
  expect(due(at(0), cfg, 50 * MIN, 60_000)).toBe(true)
  expect(due(at(0), cfg, 3 * H, 60_000)).toBe(true) // the window edge is inclusive
  expect(due(at(0), cfg, 3 * H + 1, 60_000)).toBe(false) // past the window
  expect(due(at(0), { ...cfg, windowH: 1 }, 61 * MIN, 60_000)).toBe(false)
  expect(due(at(0), cfg, 50 * MIN, 49_999)).toBe(false) // under minContext
  expect(due(at(0), cfg, 50 * MIN, undefined)).toBe(false) // unknown size: never guess
  expect(due(at(0), { ...cfg, pingsToday: 15 }, 50 * MIN, 60_000)).toBe(false) // daily cap
  expect(due(at(0), { ...cfg, pingsToday: 14 }, 50 * MIN, 60_000)).toBe(true)
  expect(due(at(0), { ...cfg, enabled: false }, 50 * MIN, 60_000)).toBe(false)
  expect(due({ ...at(0), stopped: true }, cfg, 50 * MIN, 60_000)).toBe(false)
})

test('a ping never extends the window: the next one waits from the last ping, the window still runs from the last real turn', () => {
  expect(due(at(0, 50 * MIN), cfg, 99 * MIN, 60_000)).toBe(false) // 49 min after the ping
  expect(due(at(0, 50 * MIN), cfg, 100 * MIN, 60_000)).toBe(true)
  expect(due(at(0, 150 * MIN), cfg, 200 * MIN, 60_000)).toBe(false) // 200 min > the 3 h window from lastReal=0
})

test('stop rules: zero reads, or reads under half of the previous ping; steady writes are not a signal', () => {
  expect(stopReason({ read: 0, write: 150_000 }, null)).toMatch(/already cold/)
  expect(stopReason({ read: 140_000, write: 19_000 }, null)).toBeNull() // the constant ~13% write of a healthy ping
  expect(stopReason({ read: 140_000, write: 19_000 }, 141_000)).toBeNull()
  expect(stopReason({ read: 70_499, write: 0 }, 141_000)).toMatch(/falling/)
  expect(stopReason({ read: 70_500, write: 0 }, 141_000)).toBeNull()
})

test('contextTokensOf: tokens, used, or window x percent; unknown stays unknown', () => {
  expect(contextTokensOf({ tokens: 90_000 })).toBe(90_000)
  expect(contextTokensOf({ window: 200_000, percent: 25 })).toBe(50_000)
  expect(contextTokensOf({ percent: 25 })).toBeUndefined()
  expect(contextTokensOf(undefined)).toBeUndefined()
})

const harness = (config: Partial<Cfg> | null, fork: () => unknown, tokens: number | undefined = 100_000) => {
  let now = 1_000_000, tick: () => void = () => {}
  const reports: any[] = [], runs: string[][] = []
  const ctx = {
    root: '/r', now: async () => now, contextTokens: async () => tokens, every: (_ms: number, fn: () => void) => { tick = fn },
    fork: async () => fork(),
    run: async (argv: string[], init?: { stdin?: string }) => {
      runs.push(argv)
      if (argv[1] === 'config') return { exitCode: 0, stdout: JSON.stringify(config ? { ...cfg, ...config } : {}) , stderr: '' }
      reports.push(JSON.parse(init?.stdin ?? '{}')); return { exitCode: 0, stdout: '', stderr: '' }
    },
  } as unknown as Ctx
  const h = keepwarmHooks(() => '/s')
  return {
    reports, runs, ctx, h, advance: (ms: number) => { now += ms },
    start: () => h['session.start']!(ctx, {}, (e: unknown) => e),
    turn: (e = {}) => h['turn.complete']!(ctx, e, (x: unknown) => x),
    tick: async () => { tick(); await new Promise(r => setTimeout(r, 20)) },
  }
}
const ok = (read: number, write = 19_000) => ({ isAnswered: true, text: 'ok', usage: { cache_read_input_tokens: read, cache_creation_input_tokens: write } })

test('flow: an idle armed session pings once at the interval, reports it, and stops on a cold read', async () => {
  const reads = [141_000, 0]
  const t = harness({}, () => ok(reads.shift()!))
  await t.start()
  await t.tick() // first look: loads the config, nothing due
  expect(t.reports).toEqual([])
  t.advance(50 * MIN); await t.tick()
  expect(t.reports.length).toBe(1)
  expect(t.reports[0]).toMatchObject({ event: 'ping', usage: { read: 141_000, write: 19_000 } })
  expect(t.reports[0].nextAt).toBe(1_000_000 + 100 * MIN)
  t.advance(50 * MIN); await t.tick()
  expect(t.reports[1]).toMatchObject({ event: 'stop' })
  t.advance(50 * MIN); await t.tick()
  expect(t.reports.length).toBe(2) // stopped: no more forks
})

test('flow: a real turn re-arms a stopped session and a subagent turn or a disabled config does nothing', async () => {
  const t = harness({}, () => ok(0))
  await t.start(); await t.tick()
  t.advance(50 * MIN); await t.tick()
  expect(t.reports.map(r => r.event)).toEqual(['stop'])
  await t.turn({ agentId: 'sub-1' }) // a subagent is not activity
  t.advance(50 * MIN); await t.tick()
  expect(t.reports.length).toBe(1)
  await t.turn(); t.advance(50 * MIN); await t.tick() // the user came back
  expect(t.reports.length).toBe(2)
  const off = harness({ enabled: false }, () => ok(1))
  await off.start(); await off.tick(); off.advance(50 * MIN); await off.tick()
  expect(off.reports).toEqual([])
})

test('flow: a failed fork is not a report; the turn is always passed on', async () => {
  const t = harness({}, () => { throw new Error('boom') })
  await t.start(); await t.tick(); t.advance(50 * MIN); await t.tick()
  expect(t.reports).toEqual([])
  expect(await t.h['turn.complete']!(t.ctx, { a: 1 }, (e: unknown) => e)).toEqual({ a: 1 })
})
