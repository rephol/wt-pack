// A prompt into an agent terminal. WP-378: hc's `send` pastes the line and presses Enter, and a pasted single-line slash command (/goal arms,
// /wt-audit …) still runs under Claude Code (checked on an isolated core: a pasted `/cost` ran as a command), so the earlier "type it key by
// key" path (WP-240) is gone: one send for everything. `hc keys` cannot type arbitrary characters anyway.
// WP-352: a long `/goal <wt-message …>` is sent as its short recorded POINTER (`/goal <wt-message …>Read it with: wt-message show <id></wt-message>`):
// deliver() already hands over the pointer, and a full envelope arriving here is shortened.
// io = { send(pane, text), keys(pane, ...keys), read(pane) → plain screen, status?(pane) → hc status word }.
import { pointerOf } from '../wt-shared/scripts/wt-message.mjs'
// WP-248: `opts.confirm` re-presses Enter (bounded) when the line is still in the input box, and fails if it stays.
async function confirmed(io, pane, opts) {
  if (!opts.confirm) return
  const { confirmSubmitted } = await import('../wt-shared/scripts/pane-submit.mjs').catch(() => ({}))
  if (confirmSubmitted && !(await confirmSubmitted(() => io.read(pane), () => io.keys(pane, 'enter'), { settleMs: opts.settleMs, status: io.status && (() => io.status(pane)) })))
    throw new Error(`prompt not submitted: still in the input box of ${pane}`)
}
export async function promptOn(io, pane, text, opts = {}) {
  const line = /^\/goal\s+<wt-message\s/.test(text) && !text.includes('\n') ? pointerOf(text) ?? text : text
  const r = await io.send(pane, line)
  await confirmed(io, pane, opts)
  return r
}
