// The one hooks module of the wt-pack plugin (hooks.json `modules` takes a single entry, so every mod registers
// from here): the /wt command (WP-212), per-request model routing (WP-211), AskUserQuestion capture (WP-206) and
// wt-message delivery (WP-210). The plugin root is the repo root, so the other skills are at `<root>/skills`.
// An event several mods hook (session.start, turn.start, turn.complete, prompt.submit) is registered once, below,
// running each mod's handler in turn (compose.ts). The loader follows `$` only into functions declared in this
// file and wants a function literal as the hook, hence `ctx($)` here and the thin arrows.
import type { EngineInterface, Register } from 'claude-code'
import { runShared, type Ctx } from '../skills/wt-mods/hooks/compose'
import { commandsHooks, registerCommands } from '../skills/wt-mods/hooks/commands'
import { routingHooks, routingState, registerRouting } from '../skills/wt-mods/hooks/routing'
import { registerAsk } from '../skills/wt-ask/hooks/register'
import { deliverHooks } from '../skills/wt-room/mod/hooks/register'

const skills = (root: string) => `${root}/skills`

function ctx($: EngineInterface): Ctx {
  return {
    root: $.plugin.root,
    run: (argv, init) => $.process.run(argv, init),
    submit: (text) => $.prompt.submit({ text }),
    every: (ms, fn) => $.clock.every(ms, fn),
    registerCommand: (c) => $.command.register(c),
  }
}

export const register: Register = (on, options) => {
  const routing = routingState()
  // deliver before routing: routing's turn.complete awaits a subprocess, which must not delay deliver's next pull
  const mods = [commandsHooks(), deliverHooks(skills), routingHooks(routing, skills)]
  registerCommands(on, skills)
  registerRouting(on, routing, skills)
  registerAsk(on, options, skills)
  on('session.start', ($, e, next) => runShared(ctx($), mods, 'session.start', e, next))
  on('turn.start', ($, e, next) => runShared(ctx($), mods, 'turn.start', e, next))
  on('turn.complete', ($, e, next) => runShared(ctx($), mods, 'turn.complete', e, next))
  on('prompt.submit', ($, e, next) => runShared(ctx($), mods, 'prompt.submit', e, next))
}
