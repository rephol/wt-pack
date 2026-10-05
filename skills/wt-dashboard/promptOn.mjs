// WP-240: herdr's `agent prompt` pastes (bracketed), which Claude Code gives the model as pasted content it will not
// act on — a slash command (/goal arms, /wt-audit …) must be typed. A single-line slash command is typed (send-text +
// Enter); a multi-line one would submit at its first newline, so it, any other text, and a failed send-text paste.
// WP-243: a long `/goal <wt-message …>` is a long burst of typed text, which also counts as a paste. So the message goes
// to a mode-600 file and only a short /goal line naming it is typed (no queue: it only drains between turns, and the
// goal's Stop hook keeps the turn open). A file that cannot be written pastes the whole thing.
import { mkdirSync, writeFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
const ENTER_DELAY_MS = 400
const SHORT = 100
const WEEK_MS = 7 * 864e5
function saveMessage(msg) {
  const dir = process.env.WT_MESSAGES_DIR || join(homedir(), '.local/share/wt-dashboard/messages')
  const file = join(dir, `${msg.match(/^<wt-message id=([\w-]+)/)?.[1] ?? randomBytes(6).toString('hex')}.md`)
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeFileSync(file, msg + '\n', { mode: 0o600 })
    for (const f of readdirSync(dir)) { const p = join(dir, f); if (f.endsWith('.md') && Date.now() - statSync(p).mtimeMs > WEEK_MS) unlinkSync(p) }
    return file
  } catch { return null }
}
// WP-248: `opts.confirm` re-presses Enter (bounded) when the typed line is still in the input box, and fails if it stays.
async function confirmed(herdrOn, m, pane, opts) {
  if (!opts.confirm) return
  const { confirmSubmitted } = await import('../wt-shared/scripts/pane-submit.mjs').catch(() => ({}))
  if (confirmSubmitted && !(await confirmSubmitted(() => herdrOn(m, 'pane', 'read', pane, '--source', 'visible', '--format', 'text'), () => herdrOn(m, 'pane', 'send-keys', pane, 'enter'), { settleMs: opts.settleMs })))
    throw new Error(`prompt not submitted: still in the input box of ${pane}`)
}
export async function promptOn(herdrOn, m, pane, text, opts = {}) {
  if (text.startsWith('/') && !text.includes('\n')) {
    const msg = text.length > SHORT ? text.match(/^\/goal\s+(<wt-message\s.*)$/s)?.[1] : undefined
    const file = msg && saveMessage(msg)
    if (msg && !file) return herdrOn(m, 'agent', 'prompt', pane, text)
    const id = msg?.match(/\bticket=([A-Z]+-\d+)/)?.[1]
    const line = msg ? `/goal ${id ? id + ': ' : ''}do the task in ${file}; reporting what it asks for is the goal` : text
    let typed = false
    try {
      await herdrOn(m, 'pane', 'send-text', pane, line)
      typed = true
      await new Promise((r) => setTimeout(r, ENTER_DELAY_MS)) // an Enter sent in the same instant as the text is dropped
      const r = await herdrOn(m, 'pane', 'send-keys', pane, 'enter')
      await confirmed(herdrOn, m, pane, opts)
      return r
    } catch (e) { if (typed && /not submitted/.test(e.message)) throw e; if (!typed) return herdrOn(m, 'agent', 'prompt', pane, text) /* paste */ }
  }
  return herdrOn(m, 'agent', 'prompt', pane, text)
}
