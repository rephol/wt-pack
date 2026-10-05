// WP-240: herdr's `agent prompt` pastes (bracketed), which Claude Code gives the model as pasted content it will not
// act on — a slash command (/goal arms, /wt-audit …) must be typed. A single-line slash command is typed (send-text +
// Enter); a multi-line one would submit at its first newline, so it, any other text, and a failed send-text paste.
// WP-242: a long burst of typed text counts as a paste too, so a long `/goal <wt-message …>` types only a short
// /goal line and the message follows as a normal prompt (`enqueue` → the pane's mod; false/absent → paste).
const ENTER_DELAY_MS = 400
const SHORT = 100
export async function promptOn(herdrOn, m, pane, text, enqueue) {
  if (text.startsWith('/') && !text.includes('\n')) {
    const msg = text.length > SHORT ? text.match(/^\/goal\s+(<wt-message\s.*)$/s)?.[1] : undefined
    const id = msg?.match(/\bticket=([A-Z]+-\d+)/)?.[1]
    const line = msg ? `/goal ${id ? id + ': ' : ''}finish the wt-message that follows; reporting what it asks for is the goal` : text
    let typed = false
    try {
      await herdrOn(m, 'pane', 'send-text', pane, line)
      typed = true
      await new Promise((r) => setTimeout(r, ENTER_DELAY_MS)) // an Enter sent in the same instant as the text is dropped
      const r = await herdrOn(m, 'pane', 'send-keys', pane, 'enter')
      if (!msg) return r
    } catch { if (!typed) return herdrOn(m, 'agent', 'prompt', pane, text) /* paste */ }
    if (msg && !(await enqueue?.(msg))) return herdrOn(m, 'agent', 'prompt', pane, msg)
    return
  }
  return herdrOn(m, 'agent', 'prompt', pane, text)
}
