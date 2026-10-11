// WP-315: a fake @anthropic-ai/claude-agent-sdk for worker tests. query() echoes its options in init (functions dropped by JSON), then per user
// message: 'tool' → canUseTool('Bash') and reports the decision, 'hang' → waits for interrupt/abort, 'modes' → reports setPermissionMode calls.
// WT_FAKE_FAIL=1 makes getContextUsage/supportedCommands throw.
export function query({ prompt, options }) {
  const modes = []
  let release = null
  const text = (t) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: t }] } })
  async function* gen() {
    yield { type: 'system', subtype: 'init', session_id: 'fake-session', options }
    for await (const m of prompt) {
      const t = typeof m.message?.content === 'string' ? m.message.content : m.message?.content?.[0]?.text
      if (t === 'tool') yield text('decision ' + JSON.stringify(await options.canUseTool('Bash', { command: 'ls' }, { signal: options.abortController.signal })))
      else if (t === 'hang') await new Promise((r) => { release = r; options.abortController.signal.addEventListener('abort', r) })
      else if (t === 'modes') yield text('modes ' + modes.join(','))
      else yield text('echo ' + t)
      yield { type: 'result', subtype: 'success', is_error: false, session_id: 'fake-session', result: 'ok' }
    }
  }
  const q = gen()
  q.interrupt = async () => { release?.() }
  q.setPermissionMode = async (m) => { modes.push(m) }
  q.getContextUsage = async () => {
    if (process.env.WT_FAKE_FAIL) throw new Error('usage failed')
    return { totalTokens: 1234, maxTokens: 200000, percentage: 0.6, categories: [] }
  }
  q.supportedCommands = async () => {
    if (process.env.WT_FAKE_FAIL) throw new Error('commands failed')
    return [{ name: 'compact' }]
  }
  return q
}
