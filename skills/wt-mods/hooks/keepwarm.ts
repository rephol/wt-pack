// WP-318 — keep a long-lived agent's 1 h prompt cache warm. After ~50 idle minutes a tool-less `$.model.fork` (it shares
// the session's cached prefix and writes nothing back) reads the whole context once, which renews the cache. Measured
// (docs/plans/wp-318-keepwarm.md, Unit 0): a ping reads the full context at ~2.5% of a cold send's cost, a gap over 60 min
// re-writes it all. So the budget is pings, not limit pressure: a window after the last real turn, a daily cap, a floor on
// context size. Config and reports go through wt-dashboard (wt-keepwarm); `$` never reaches this file (compose.ts).
import type { Ctx, Hooks } from './compose'
import type { SkillsDir } from './commands'

export type Cfg = { enabled: boolean; intervalMin: number; minContext: number; windowH: number; dailyCap: number; pingsToday: number }
export type State = { lastReal: number; lastPing: number; lastRead: number | null; stopped: boolean }
export type Usage = { read: number; write: number }

const MIN = 60_000

export const fresh = (now: number): State => ({ lastReal: now, lastPing: 0, lastRead: null, stopped: false })

// A ping is due when the cache has been idle for the interval, the agent worked within the window, and the budget allows.
export const due = (s: State, cfg: Cfg, now: number, tokens: number | undefined): boolean =>
  cfg.enabled && !s.stopped && tokens !== undefined && tokens >= cfg.minContext && cfg.pingsToday < cfg.dailyCap &&
  now - Math.max(s.lastReal, s.lastPing) >= cfg.intervalMin * MIN && now - s.lastReal <= cfg.windowH * 60 * MIN

// Why to stop after a ping, or null. Zero reads = the cache was already cold; a read under half the previous ping's =
// it is shrinking away. (A steady ~13% cache *write* is normal for a ping, so writes are not a signal.)
export const stopReason = (u: Usage, prevRead: number | null): string | null =>
  u.read === 0 ? 'cache was already cold (a ping read nothing)' : prevRead !== null && u.read < prevRead / 2 ? 'cache reads are falling away' : null

// The pane's own context size in tokens; the engine reports a percent (and, per version, the window/tokens).
export const contextTokensOf = (c: { tokens?: number; used?: number; window?: number; percent?: number } | undefined): number | undefined =>
  c?.tokens ?? c?.used ?? (c?.window !== undefined && c.percent !== undefined ? Math.round(c.window * c.percent / 100) : undefined)

export const keepwarmHooks = (skills: SkillsDir): Hooks => {
  let s = fresh(0)
  let cfg: Cfg | undefined, cfgAt = 0, busy = false
  const cli = (ctx: Ctx, argv: string[], stdin?: string) => ctx.run([`${skills(ctx.root)}/wt-mods/scripts/wt-keepwarm`, ...argv], { stdin, timeoutMs: 15000 }).catch(() => null)
  const load = async (ctx: Ctx, now: number) => {
    const r = await cli(ctx, ['config'])
    try { cfg = r?.exitCode === 0 ? JSON.parse(r.stdout) : undefined } catch { cfg = undefined }
    cfgAt = now
  }
  const tick = async (ctx: Ctx) => {
    if (busy) return
    busy = true
    try {
      const now = await ctx.now()
      // Off (or unknown) is re-checked every 5 min, so arming an agent in the dashboard takes effect without a restart.
      if (!cfg?.enabled && now - cfgAt < 5 * MIN) return
      if (cfg?.enabled && !due(s, cfg, now, await ctx.contextTokens().catch(() => undefined))) return
      await load(ctx, now) // the dashboard is the truth: Off, a new cap or a new window since the last look
      if (!cfg || !due(s, cfg, now, await ctx.contextTokens().catch(() => undefined))) return
      const r = await ctx.fork('Reply with: ok').catch(() => undefined)
      const t = await ctx.now()
      s.lastPing = t
      if (!r?.usage) return // nothing to learn from; try again at the next interval
      const u = { read: r.usage.cache_read_input_tokens ?? 0, write: r.usage.cache_creation_input_tokens ?? 0 }
      const why = r.isAnswered === false && r.reason !== 'empty-reply' ? `fork ${r.reason}` : stopReason(u, s.lastRead)
      s.lastRead = u.read
      if (why) { s.stopped = true; await cli(ctx, ['report', '-'], JSON.stringify({ event: 'stop', reason: why })) }
      else await cli(ctx, ['report', '-'], JSON.stringify({ event: 'ping', usage: u, nextAt: t + cfg.intervalMin * MIN }))
    } finally { busy = false }
  }
  return {
    'session.start': async (ctx, e, next) => {
      s = fresh(await ctx.now()); cfg = undefined; cfgAt = 0
      ctx.every(MIN, () => { void tick(ctx).catch(() => null) })
      return next(e)
    },
    // A real turn (not a subagent's, not our own fork) is what the window measures from, and what re-arms a stopped session.
    'turn.complete': async (ctx, e, next) => {
      if (!e.agentId && !busy) s = { ...s, lastReal: await ctx.now(), stopped: false, lastRead: null }
      return next(e)
    },
  }
}
