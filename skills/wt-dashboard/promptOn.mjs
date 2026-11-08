// WP-240: herdr's `agent prompt` pastes (bracketed), which Claude Code gives the model as pasted content it will not
// act on — a slash command (/goal arms, /wt-audit …) must be typed. A single-line slash command is typed (send-text +
// Enter); a multi-line one would submit at its first newline, so it, any other text, and a failed send-text paste.
// WP-352: a long `/goal <wt-message …>` is a long burst of typed text, which also counts as a paste, and the old "do the task in <file>" line
// was an untagged prompt the receiver could not verify. So it is typed as its short recorded POINTER (`/goal <wt-message …>Read it with:
// wt-message show <id></wt-message>`); the dashboard's deliver() already hands over the pointer, and a full envelope arriving here is shortened.
import { pointerOf } from '../wt-shared/scripts/wt-message.mjs'
const ENTER_DELAY_MS = 400
// WP-248: `opts.confirm` re-presses Enter (bounded) when the typed line is still in the input box, and fails if it stays.
async function confirmed(herdrOn, m, pane, opts) {
  if (!opts.confirm) return
  const { confirmSubmitted } = await import('../wt-shared/scripts/pane-submit.mjs').catch(() => ({}))
  if (confirmSubmitted && !(await confirmSubmitted(() => herdrOn(m, 'pane', 'read', pane, '--source', 'visible', '--format', 'text'), () => herdrOn(m, 'pane', 'send-keys', pane, 'enter'), { settleMs: opts.settleMs })))
    throw new Error(`prompt not submitted: still in the input box of ${pane}`)
}
export async function promptOn(herdrOn, m, pane, text, opts = {}) {
  if (text.startsWith('/') && !text.includes('\n')) {
    const line = /^\/goal\s+<wt-message\s/.test(text) ? pointerOf(text) ?? text : text
    let typed = false
    try {
      await herdrOn(m, 'pane', 'send-text', pane, line)
      typed = true
      await new Promise((r) => setTimeout(r, ENTER_DELAY_MS)) // an Enter sent in the same instant as the text is dropped
      const r = await herdrOn(m, 'pane', 'send-keys', pane, 'enter')
      await confirmed(herdrOn, m, pane, opts)
      return r
    } catch (e) { if (typed && /not submitted/.test(e.message)) throw e; if (!typed) return herdrOn(m, 'agent', 'prompt', pane, line) /* paste */ }
  }
  return herdrOn(m, 'agent', 'prompt', pane, text)
}
