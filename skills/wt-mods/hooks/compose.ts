// WP-213: one plugin, one hooks module — but the engine refuses a second hook on the same event without a matcher,
// and several mods want session.start / turn.start / turn.complete / prompt.submit. So a mod gives `Hooks` (its
// handlers for those four shared events, plain functions) and a `registerX(on, …)` function for everything else
// (matcher hooks, turn.step). The one module registers each shared event once, as the `chain` of every mod's handler.
// (The loader reads `on(...)` call sites statically: `on` is only ever passed to a plain function of the plugin.)
import type { EngineInterface, Register } from 'claude-code'

export type On = Parameters<Register>[0]
// The loader follows `$` only into functions declared in the module's own file, so a shared-event handler (which
// lives in a mod's file) never sees `$`: it gets this narrow ctx, built in the module from literal `$.noun.event(...)` calls.
export type Ctx = {
  root: string
  run: (argv: readonly string[], init?: Parameters<EngineInterface['process']['run']>[1]) => ReturnType<EngineInterface['process']['run']>
  submit: (text: string) => Promise<unknown>
  every: (ms: number, fn: () => void) => unknown
  registerCommand: (c: Parameters<EngineInterface['command']['register']>[0]) => Promise<unknown>
}
export type Hook = (ctx: Ctx, e: any, next: (e: any) => any) => any // eslint-disable-line @typescript-eslint/no-explicit-any
export type Shared = 'session.start' | 'turn.start' | 'turn.complete' | 'prompt.submit'
export type Hooks = Partial<Record<Shared, Hook>>

// First is outermost: h0 runs, and its next() runs h1, … then the engine's own (the final `next`).
export const chain = (hooks: readonly Hook[]): Hook => (ctx, e, next) =>
  hooks.reduceRight<(e2: unknown) => any>((n, h) => (e2) => h(ctx, e2, n as never), (e2) => next(e2))(e)

export const handlers = (mods: readonly Hooks[], event: Shared): Hook => chain(mods.flatMap(m => (m[event] ? [m[event]] : [])))

// What the module's one hook per shared event calls: `($, e, next) => runShared(ctx($), mods, 'turn.complete', e, next)`.
export const runShared = (ctx: Ctx, mods: readonly Hooks[], event: Shared, e: unknown, next: (e: any) => any) => handlers(mods, event)(ctx, e, next) // eslint-disable-line @typescript-eslint/no-explicit-any
