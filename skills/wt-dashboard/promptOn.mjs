// WP-240: herdr's `agent prompt` pastes (bracketed), which Claude Code gives the model as pasted content it will not
// act on — a slash command (/goal arms, /wt-audit …) must be typed. A single-line slash command is typed (send-text +
// Enter); a multi-line one would submit at its first newline, so it, any other text, and a failed send-text paste.
const ENTER_DELAY_MS = 400
export async function promptOn(herdrOn, m, pane, text) {
  if (text.startsWith('/') && !text.includes('\n')) {
    try {
      await herdrOn(m, 'pane', 'send-text', pane, text)
      await new Promise((r) => setTimeout(r, ENTER_DELAY_MS)) // an Enter sent in the same instant as the text is dropped
      return await herdrOn(m, 'pane', 'send-keys', pane, 'enter')
    } catch { /* paste below */ }
  }
  return herdrOn(m, 'agent', 'prompt', pane, text)
}
