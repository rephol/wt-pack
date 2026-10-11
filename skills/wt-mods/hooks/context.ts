// WP-282 — warn when the main session's context nears its limit and suggest a fresh agent. Usage per turn needs no
// reporting from here: the dashboard's usage view (WP-130) already re-reads every live session's transcript.
// `$` never reaches this file (compose.ts): the percent and the toast come in through Ctx.
import type { Hooks } from './compose'

export const LEVELS = [80, 90] as const

export const warning = (pct: number) =>
  `Context ${pct}% full: finish this step, then continue in a fresh agent (handoff.sh --new, or /compact)`

// Each level warns once while the context is above it; a drop below (compact, /clear) re-arms it.
export const contextHooks = (): Hooks => {
  let warned = 0
  return {
    'turn.complete': async (ctx, e, next) => {
      if (!e.agentId) { // a subagent has a window of its own
        const pct = await ctx.contextPercent().catch(() => undefined)
        if (pct !== undefined) {
          const level = LEVELS.filter(l => pct >= l).at(-1) ?? 0
          if (level > warned) ctx.notify(warning(Math.round(pct)))
          warned = level
        }
      }
      return next(e)
    },
  }
}
